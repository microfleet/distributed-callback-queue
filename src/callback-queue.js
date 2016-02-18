const callbackQueue = require('callback-queue');
const serializeError = require('serialize-error');

// callback buckets
const setImmediate = setImmediate || process.nextTick;
const queue = new Map();
const isArray = Array.isArray;

/**
 * Call functions stored in local queues
 * @param  {String} queueName
 * @param  {Array}  args
 */
function call(queueName, args, logger) {
  const callback = queue.get(queueName);
  if (!callback) {
    return Promise.reject(new Error('callback called multiple times'));
  }

  // these are async anyways - gonna schedule them
  logger.debug('Calling %s callback with args', queueName, args);
  callback(...args);

  // clean local queue
  queue.delete(queueName);
  return Promise.resolve();
}

/**
 * Add callback into local queue
 * @param {String}   key - queue key
 * @param {Function} callback - function to add
 */
exports.add = function add(key, callback) {
  const aggregator = callbackQueue.add(key, callback);
  if (!aggregator) {
    return false;
  }

  queue.set(key, aggregator);
  return true;
};

/**
 * Creates publish function that is used later on to process callbacks
 * @param {Object} redis
 */
exports.createPublisher = function createPublisher(redis, pubsubChannel, logger) {
  return function publishResult(lockRedisKey, ...args) {
    // serialize error if it's present
    args[0] = args[0] ? serializeError(args[0]) : null;

    // post result to other processes
    redis
      .publish(pubsubChannel, JSON.stringify([lockRedisKey, args]))
      .catch(err => {
        logger.warn('failed to publish results', err);
      });

    // call local queue for faster processing
    // we don't care here if it fails, it could've been already processed
    return call(lockRedisKey, args, logger).reflect();
  };
};

function tryParsing(message, logger) {
  try {
    return JSON.parse(message);
  } catch (e) {
    logger.warn('Cant parse message %s', message);
    return null;
  }
}

/**
 * Creates publish function that is used later on to process callbacks
 * @param {Object} redis
 */
exports.createConsumer = function createConsumer(redis, pubsubChannel, logger) {
  redis.subscribe(pubsubChannel, err => {
    if (err) {
      logger.fatal('Failed to subsctibe to pubsub channel:', err);
    } else {
      logger.info('Subscribed to channel %s', pubsubChannel);
    }
  });

  return function redisEventListener(channel, _message) {
    if (channel.toString() !== pubsubChannel) {
      return null;
    }

    const message = tryParsing(_message, logger);
    if (!isArray(message)) {
      return null;
    }

    const [key, args] = message;
    if (!key || !isArray(args)) {
      logger.warn('Malformed message passed: no key or args.', message);
      return null;
    }

    // no listeners here
    // eat the error
    return call(key, args, logger).reflect();
  };
};

// //////////////////////////////////////////////////////////////////////////////
// Private section
// //////////////////////////////////////////////////////////////////////////////

/**
 * Returns internal queue, used for testing
 * @return {Object}
 */
exports._queue = () => queue;

/**
 * For testing, allows overriding `call` func
 * @type {Function}
 */
exports._setCall = fn => {
  call = fn; // eslint-disable-line no-func-assign
};

/**
 * Reference to original call function,
 * used for testing
 * @type {Function}
 */
exports._call = call;
