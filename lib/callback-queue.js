'use strict';

var _slicedToArray = function () { function sliceIterator(arr, i) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i["return"]) _i["return"](); } finally { if (_d) throw _e; } } return _arr; } return function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { return sliceIterator(arr, i); } else { throw new TypeError("Invalid attempt to destructure non-iterable instance"); } }; }();

function _toConsumableArray(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) arr2[i] = arr[i]; return arr2; } else { return Array.from(arr); } }

const Promise = require('bluebird');
const callbackQueue = require('callback-queue');
const serializeError = require('serialize-error');

// callback buckets
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
  callback.apply(undefined, _toConsumableArray(args));

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
  return function publishResult(lockRedisKey) {
    for (var _len = arguments.length, args = Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
      args[_key - 1] = arguments[_key];
    }

    // serialize error if it's present
    args[0] = args[0] ? serializeError(args[0]) : null;

    // post result to other processes
    redis.publish(pubsubChannel, JSON.stringify([lockRedisKey, args])).catch(err => {
      logger.warn('failed to publish results', err);
    });

    // call local queue for faster processing
    // we don't care here if it fails, it could've been already processed
    return call(lockRedisKey, args, logger).reflect();
  };
};

/**
 * Helper function to parse possible JSON from the Buffer
 */
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

    var _message2 = _slicedToArray(message, 2);

    const key = _message2[0];
    const args = _message2[1];

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