const Promise = require('bluebird');
const callbackQueue = require('callback-queue');
const { serializeError, deserializeError } = require('serialize-error');

// callback buckets
const queue = new Map();
const { isArray } = Array;

/**
 * Call functions stored in local queues
 * @param  {String} queueName
 * @param  {Array} args
 */
async function call(queueName, args, logger) {
  const callback = queue.get(queueName);
  if (!callback) {
    throw new Error('callback called multiple times');
  }

  // these are async anyways - gonna schedule them
  logger.debug('Calling %s callback with args', queueName, args);
  callback(...args);

  // clean local queue
  queue.delete(queueName);
}

/**
 * Add callback into local queue
 * @param {String} key - queue key
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
  return async function publishResult(lockRedisKey, err, ...args) {
    const broadcastArgs = [err ? serializeError(err) : null, ...args];
    const localArgs = [err, ...args];

    // post result to other processes
    redis
      .publish(pubsubChannel, JSON.stringify([lockRedisKey, broadcastArgs]))
      .catch((e) => {
        logger.warn({ err: e }, 'failed to publish results');
      });

    // call local queue for faster processing
    // we don't care here if it fails, it could've been already processed
    try {
      await call(lockRedisKey, localArgs, logger);
    } catch (e) {
      logger.warn({ err: e, lockRedisKey }, 'failed to perform call');
    }
  };
};

/**
 * Helper function to parse possible JSON from the Buffer
 */
function tryParsing(message, logger) {
  try {
    return JSON.parse(message);
  } catch (e) {
    logger.warn({ message }, 'Cant parse message');
    return null;
  }
}

/**
 * Creates publish function that is used later on to process callbacks
 * @param {Object} redis
 */
exports.createConsumer = function createConsumer(redis, pubsubChannel, logger) {
  const connect = () => redis
    .subscribe(pubsubChannel)
    .tap(() => {
      logger.info('Subscribed to channel %s', pubsubChannel);
    })
    .catch((err) => {
      logger.fatal('Failed to subsctibe to pubsub channel:', err);
      return Promise.delay(250).then(connect);
    });

  // init connection
  connect();

  return async function redisEventListener(channel, _message) {
    if (channel.toString() !== pubsubChannel) {
      return;
    }

    const message = tryParsing(_message, logger);
    if (!isArray(message)) {
      return;
    }

    const [key, args] = message;
    if (!key || !isArray(args)) {
      logger.warn('Malformed message passed: no key or args.', message);
      return;
    }

    // no listeners here
    // eat the error
    try {
      if (args[0]) args[0] = deserializeError(args[0]);
      await call(key, args, logger);
    } catch (err) {
      logger.warn({ err }, 'call failed');
    }
  };
};

// //////////////////////////////////////////////////////////////////////////////
// Private section
// //////////////////////////////////////////////////////////////////////////////

/**
 * Reference to original call function,
 * used for testing
 * @type {Function}
 */
exports._call = call;
