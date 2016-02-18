const Promise = require('bluebird');
const defaults = require('lodash.defaults');
const assign = require('lodash.assign');
const callbackQueue = require('./callback-queue');
const redislock = require('ioredis-lock');
const bunyan = require('bunyan');
const assert = require('assert');
const { LockAcquisitionError } = redislock;
const pkg = require('../package.json');

function notLockAcquisitionError(e) {
  return e.name !== 'LockAcquisitionError';
}

/**
 * @class DistributedCallbackQueue
 *
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
class DistributedCallbackQueue {

  constructor(options = {}) {
    const client = options.client;
    assert.ok(client, 'options.client must be defined');

    const pubsub = options.pubsub || client.duplicate({ lazyConnect: false });
    assert.notStrictEqual(client, pubsub, 'options.client and options.pubsub must have separate redis clients'); // eslint-disable-line max-len

    const pubsubChannel = options.pubsubChannel;
    assert.ok(pubsubChannel, 'pubsubChannel must be specified');

    const lockOptions = defaults(options.lock || {}, {
      timeout: 10000,
      retries: 1,
      delay: 100,
    });

    const logger = this.logger = this.initLogger(options);

    // put on the instance
    assign(this, {
      client,
      pubsub,
      lockOptions,
      lockPrefix: options.lockPrefix || pkg.name,
      publish: callbackQueue.createPublisher(client, pubsubChannel, logger),
      consume: callbackQueue.createConsumer(pubsub, pubsubChannel, logger),
    });

    pubsub.on('messageBuffer', this.consume);

    // ready
    this.logger.info('Initialized...');
  }

  initLogger(options) {
    const { log: logger, debug, name } = options;
    const loggerEnabled = typeof logger === 'undefined' ? !!debug : logger;

    if (loggerEnabled && logger instanceof bunyan) {
      return logger;
    }

    const streams = [{
      level: 'trace',
      type: 'raw',
      stream: new bunyan.RingBuffer({ limit: 100 }),
    }];

    if (loggerEnabled) {
      streams.push({
        stream: process.stdout,
        level: debug ? 'debug' : 'info',
      });
    }

    return bunyan.createLogger({
      name: name || pkg.name,
      streams,
    });
  }

  key(suffix) {
    return `${this.lockPrefix}${suffix}`;
  }

  /**
   * Adds callback to distributed queue
   * @param {String}  suffix - queue identifier
   * @param {Function} next - callback to be called when request is finished
   * @returns {Promise} if promise is resolved then we must act, if it's rejected - then
   *                    somebody else is working on the same task right now
   */
  push(suffix, next) {
    // first queue locally to make use of pending requests
    const lockRedisKey = this.key(suffix);
    const queued = callbackQueue.add(lockRedisKey, next);

    // this means that we already have local callback queue with that
    // identifier, don't try to lock it again and proceed further
    if (!queued) {
      return Promise.reject(new LockAcquisitionError('job is already running'));
    }

    // create lock
    const lock = redislock.createLock(this.client, this.lockOptions);

    // get the lock
    return lock
      .acquire(lockRedisKey)
      .then(() => this.createWorker(lockRedisKey, lock))
      .catch(notLockAcquisitionError, err => {
        // this is an abnormal error, need to post it and cancel requests
        // so that they dont hang
        return this
          .publish(lockRedisKey, err)
          .throw(err);
      });
  }

  /**
   * Returns function that should be called with the result of the work
   * @param {String} lockRedisKey - key used for locking
   * @param {Object} lock - acquired lock
   * @returns {Function} worker - call with arguments that need to be passed to
   *                            	all queued callbacks
   */
  createWorker(lockRedisKey, lock) {
    /**
     * This function must be called when job has been completed
     * @param  {Error} err
     * @param  {Array} ...args
     */
    return (err, ...args) => {
      // emit event
      this.publish(lockRedisKey, err, ...args);

      // must release lock now. Technically there could be an event
      // where lock had not been released, notification already emitted
      // and callback is stuck in the queue, to avoid that we can add retry
      // to lock acquisition. Desicion and constraints are up to you. Ideally
      // you would want to cache result of the function for some time - and then
      // this race is completed. Multi() command is not possible to use here
      return lock.release();
    };
  }

}

/**
 * Constructor for distributed callback queue
 * @type {DistributedCallbackQueue}
 */
module.exports = DistributedCallbackQueue;
