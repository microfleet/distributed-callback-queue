'use strict';

var _ = require('lodash');
var callbackQueue = require('./callback-queue');
var redislock = require('redislock');
var Logger = require('arklogger');

/**
 * Init distributed callback queue
 * @param  {Object}   options:
 *    @param {redisClient} client: redis connection that will be used for communications
 *    @param {redisClient} pubsub: redis connection that will be used for notifications
 *    @param {String} pubsubChannel - will be used to pass notifications
 *    @param {Object} lock - configuration for redislock:
 *        @param {Number} timeout - defaults to 1000
 *        @param {Number} retries - defaults to 0
 *        @param {Number} delay - defaults to 100
 *    @param {Object|Boolean} log: sets up logger. If set to false supresses all warnings
 *        @param {String} name: name to use when reporting
 *        @param {String|Object} preset - either name of preset or streams obj for bunyan
 *    @param {String} lockPrefix - used for creating locks in redis
 */
function DistributedCallbackQueue(options) {

    // guard for lack of new Init()
    if (!this instanceof DistributedCallbackQueue) {
        return new DistributedCallbackQueue(options);
    }

    var client = options.client;
    var pubsub = options.pubsub;

    if (!client || !pubsub || client === pubsub) {
        throw new Error('options.client and options.pubsub must have separate redis clients');
    }

    var pubsubChannel = options.pubsubChannel;
    if (!pubsubChannel) {
        throw new Error('pubsubChannel must be specified');
    }

    var lockOptions = _.defaults(options.lock || {}, {
        timeout: 10000,
        retries: 1,
        delay: 100
    });

    var logger = options.log;
    if (!logger) {
        logger = {};
        ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(function (level) {
            logger[level] = _.noop;
        });
        this.logger = logger;
    } else {
        this.logger = new Logger(logger.name || 'distributed-callback-queue', logger.preset || 'dc-fremont');
    }


    // put on the instance
    _.extend(this, {
        client: client,
        pubsub: pubsub,
        lockOptions: lockOptions,
        lockPrefix: options.lockPrefix || '{dcb}',
        publish: callbackQueue.createPublisher(client, pubsubChannel),
        consume: callbackQueue.createConsumer(pubsub, pubsubChannel, this.logger)
    });

    pubsub.on('message', this.consume);

    // ready
    this.logger.info('Initialized...');
}

/**
 * Adds callback to distributed queue
 * @param {String}   key - queue identifier
 * @param {Function} callback - callback to be called when request is finished
 */
DistributedCallbackQueue.prototype.push = function (key, next, done) {
    // first queue locally to make use of pending requests
    var lockRedisKey = this.lockPrefix + key;

    var queued = callbackQueue.add(lockRedisKey, next);
    // this means that we already have local callback queue with that
    // identifier, don't try to lock it again and proceed further
    if (!queued) {
        return setImmediate(done, null, false);
    }

    // create lock
    var lock = redislock.createLock(this.client, this.lockOptions);
    var self = this;

    lock.acquire(lockRedisKey, function lockAcquireCallback(err) {

        if (err) {
            setImmediate(done, null, false);

            // this is ok, somebody already acquired lock
            if (err.name === 'LockAcquisitionError') {
                return;
            }

            // this is an abnormal error, need to post it and cancel requests
            // so that they dont hang
            return self.publish(lockRedisKey, err);
        }

        // report that we are good to proceed with the task
        setImmediate(done, null, self.createWorker(lockRedisKey, lock));

    });

};

/**
 * Returns function that should be called with the result of the work
 * @param {Object} lock - acquired lock
 * @returns {Function} worker - call with arguments that need to be passed to
 *                            	all queued callbacks
 */
DistributedCallbackQueue.prototype.createWorker = function (lockRedisKey, lock) {
    var self = this;

    return function workerCallback() {
        // do not leak references
        var argsLength = arguments.length;
        var args = new Array(argsLength + 1);
        args[0] = lockRedisKey;
        for (var i = 1; i <= argsLength; i++) {
            args[i] = arguments[i - 1];
        }

        // emit event
        self.publish.apply(null, args);

        // must release lock now. Technically there could be an event
        // where lock had not been released, notification already emitted
        // and callback is stuck in the queue, to avoid that we can add retry
        // to lock acquisition. Desicion and constraints are up to you. Ideally
        // you would want to cache result of the function for some time - and then
        // this race is completed. Multi() command is not possible to use here
        lock.release(_.noop);
    };

};

/**
 * Constructor for distributed callback queue
 * @type {DistributedCallbackQueue}
 */
module.exports = DistributedCallbackQueue;
