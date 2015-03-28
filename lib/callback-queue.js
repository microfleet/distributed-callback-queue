'use strict';

var _ = require('lodash').runInContext();
var callbackQueue = require('callback-queue');
var msgpack = require('msgpack');

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
function call(queueName, args) {
    var callback = queue[queueName];
    if (!callback) {
        return false;
    }

    // schedule callbacks
    args.unshift(callback);
    setImmediate.apply(null, args);

    // clean local queue
    queue[queueName] = null;
    if (++nulls > 300) {
        queue = _.compactObject(queue);
    }
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
exports.createPublish = function (redis, pubsubChannel) {

    return function publishResult(lockRedisKey) {
        // do not leak references, copy all but key
        var argsLength = arguments.length - 1;
        var args = new Array(argsLength);
        for (var i = 0; i < argsLength; i++) {
            args[i] = arguments[i + 1];
        }

        var message = msgpack.pack({
            key: lockRedisKey,
            args: args
        });

        // post to other processes
        redis.publish(pubsubChannel, message);

        // call local queue for faster processing
        call(lockRedisKey, args);
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
            message = msgpack.unpack(message);
        } catch (e) {
            logger.warn('Cant parse message %s', message);
            return;
        }

        var key = message.key,
            args = message.args;

        if (!key || !Array.isArray(args)) {
            logger.warn('Malformed message passed: no key or args.', message);
            return;
        }

        call(message.key, message.args);
    };

};

/**
 * Returns internal queue, used for testing
 * @return {Object}
 */
exports._queue = function () {
    return queue;
};
