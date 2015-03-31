'use strict';

var _ = require('lodash').runInContext();
var callbackQueue = require('callback-queue');

// gc for queue keeping
var mixins = require('mm-lodash');
_.mixin(_.pick(mixins, 'compactObject'));

// we need to serialize errors and pass them using notifications
// this is done for that purpose
require('error-tojson');

// callback buckets
var setImmediate = setImmediate || process.nextTick;
var queue = {};
var nulls = 0;

/**
 * Call functions stored in local queues
 * @param  {String} queueName
 * @param  {Array}  args
 */
function call(queueName, args, logger) {
    var callback = queue[queueName];
    if (!callback) {
        logger.debug('Called callback %s for the N-th time', queueName);
        return false;
    }

    logger.debug('Calling %s callback with args', queueName, args);

    // these are async anyways - gonna schedule them
    callback.apply(null, args);

    // clean local queue
    queue[queueName] = null;
    if (++nulls > 300) {
        queue = _.compactObject(queue);
    }

    return true;
}

/**
 * Add callback into local queue
 * @param {String}   key - queue key
 * @param {Function} callback - function to add
 */
exports.add = function (key, callback) {
    var aggregator = callbackQueue.add(key, callback);
    if (!aggregator) {
        return false;
    }

    queue[key] = aggregator;
    return true;
};

/**
 * Creates publish function that is used later on to process callbacks
 * @param {Object} redis
 */
exports.createPublisher = function (redis, pubsubChannel, logger) {

    return function publishResult(lockRedisKey) {
        // do not leak references, copy all but key
        var argsLength = arguments.length - 1;
        var args = new Array(argsLength);
        for (var i = 0; i < argsLength; i++) {
            args[i] = arguments[i + 1];
        }

        var message = JSON.stringify([ lockRedisKey, args ]);

        // post to other processes
        redis.publish(pubsubChannel, message);

        // call local queue for faster processing
        call(lockRedisKey, args, logger);
    };

};

/**
 * Creates publish function that is used later on to process callbacks
 * @param {Object} redis
 */
exports.createConsumer = function (redis, pubsubChannel, logger) {

    redis.subscribe(pubsubChannel);

    return function redisEventListener(channel, message) {
        if (channel !== pubsubChannel) {
            return;
        }

        try {
            message = JSON.parse(message);
        } catch (e) {
            logger.warn('Cant parse message %s', message);
            return;
        }

        var key = message[0],
            args = message[1];

        if (!key || !Array.isArray(args)) {
            logger.warn('Malformed message passed: no key or args.', message);
            return;
        }

        call(key, args, logger);
    };

};

////////////////////////////////////////////////////////////////////////////////
// Private section
////////////////////////////////////////////////////////////////////////////////

/**
 * Returns internal queue, used for testing
 * @return {Object}
 */
exports._queue = function () {
    return queue;
};

/**
 * For testing, allows overriding `call` func
 * @type {Function}
 */
exports._setCall = function (fn) {
    call = fn;
};

/**
 * Reference to original call function,
 * used for testing
 * @type {Function}
 */
exports._call = call;

////////////////////////////////////////////////////////////////////////////////
