const Bluebird = require('bluebird')
const redislock = require('@microfleet/ioredis-lock')
const Redis = require('ioredis')
const pino = require('pino')
const assert = require('assert')
const readPkg = require('read-pkg-up')

// may only use redis with bluebird promise
Redis.Promise = Bluebird

// lodash helpers
const assign = require('lodash/assign')
const defaults = require('lodash/defaults')
const flatten = require('lodash/fp/flatten')
const filter = require('lodash/fp/filter')
const compose = require('lodash/fp/compose')

// internal deps
const callbackQueue = require('./callback-queue')
const Semaphore = require('./semaphore')
const { MultiLock, MultiLockError } = require('./multi-lock')
const pkg = readPkg.sync().packageJson

const { LockAcquisitionError } = redislock
const isBoolean = filter(Boolean)
const toFlattenedTruthyArray = compose(isBoolean, flatten)
const couldNotAcquireLockError = new LockAcquisitionError('job is already running')
const TimeoutError = new Bluebird.TimeoutError('queue-no-response')
const notLockAcquisitionError = (e) => e.name !== 'LockAcquisitionError'
const isTimeoutError = (e) => e === TimeoutError

/**
 * @class DistributedCallbackQueue
 *
 * Init distributed callback queue
 * @param  {Object}   options:
 *    @param {redisClient} client: redis connection that will be used for communications
 *    @param {redisClient} pubsub: redis connection that will be used for notifications
 *    @param {String} pubsubChannel - will be used to pass notifications
 *    @param {Object} lock - configuration for redislock:
 *        @param {Number} timeout - defaults to 10000
 *        @param {Number} retries - defaults to 0
 *        @param {Number} delay - defaults to 100
 *    @param {Pino|Boolean} [log] sets up logger. If set to false supresses all warnings
 *    @param {String} [name] name to use when reporting
 *    @param {Boolean} [debug=false] show additional diagnostic information
 *    @param {String} lockPrefix - used for creating locks in redis
 */
class DistributedCallbackQueue {
  constructor(options = {}) {
    const { client } = options
    assert.ok(client, 'options.client must be defined')

    const pubsub = options.pubsub || (typeof client.duplicate === 'function' ? client.duplicate({ lazyConnect: false }) : client)
    if (!(pubsub instanceof Redis.Cluster)) {
      assert.notStrictEqual(client, pubsub, 'options.client and options.pubsub must have separate redis clients')
    }

    const { pubsubChannel } = options
    assert.ok(pubsubChannel, 'pubsubChannel must be specified')

    const lockOptions = defaults(options.lock || {}, {
      timeout: 10000,
      retries: 2,
      delay: 100,
    })

    const logger = this.logger = DistributedCallbackQueue.initLogger(options)

    // put on the instance
    assign(this, {
      client,
      pubsub,
      lockOptions,
      lockPrefix: options.lockPrefix || pkg.name,
      publish: callbackQueue.createPublisher(client, pubsubChannel, logger),
      consume: callbackQueue.createConsumer(pubsub, pubsubChannel, logger),
    })

    pubsub.on('messageBuffer', this.consume)

    // ready
    this.logger.info('Initialized...')
  }

  static isCompatibleLogger(logger) {
    for (const level of ['debug', 'info', 'warn', 'error', 'fatal'].values()) {
      if (typeof logger[level] !== 'function') {
        return false
      }
    }

    return true
  }

  static initLogger(options) {
    const { log: logger, debug, name } = options
    const loggerEnabled = typeof logger === 'undefined' ? !!debug : logger

    if (loggerEnabled && DistributedCallbackQueue.isCompatibleLogger(logger)) {
      return logger
    }

    let level = 'silent'
    if (loggerEnabled) {
      level = debug ? 'debug' : 'info'
    }

    return pino({ name: name || pkg.name, level }, pino.destination(1))
  }

  /**
   * Combines task key
   * @param  {String} suffix
   */
  key(suffix) {
    return `${this.lockPrefix}${suffix}`
  }

  /**
   * Creates lock instance
   * @return {Lock}
   */
  getLock() {
    return redislock.createLock(this.client, this.lockOptions)
  }

  /**
   * Adds callback to distributed queue
   * @param {String}  suffix - queue identifier
   * @param {Function} next - callback to be called when request is finished
   * @param {number} [timeout=this.lockOptions.timeout * 2] - fail after <timeout>, set to 0 to disable
   * @returns {Promise} if promise is resolved then we must act, if it's rejected - then
   *                    somebody else is working on the same task right now
   */
  async push(suffix, next, timeout = this.lockOptions.timeout * 2) {
    assert(suffix, 'must be a truthy string')

    // first queue locally to make use of pending requests
    const lockRedisKey = this.key(suffix)
    const queued = callbackQueue.add(lockRedisKey, next)

    // this means that we already have local callback queue with that
    // identifier, don't try to lock it again and proceed further
    if (!queued) {
      throw couldNotAcquireLockError
    }

    if (timeout) {
      /* we are first in the local queue */
      const onTimeout = setTimeout(
        callbackQueue._call,
        timeout,
        lockRedisKey,
        [TimeoutError],
        this.logger
      )

      /* if we have no response from dlock -> without timeout, clean local queue */
      callbackQueue.add(lockRedisKey, () => clearTimeout(onTimeout))
    }

    // create lock
    const lock = this.getLock()

    // get the lock
    try {
      await lock.acquire(lockRedisKey)
      return await this.createWorker(lockRedisKey, lock)
    } catch (e) {
      if (notLockAcquisitionError(e)) {
        // this is an abnormal error, need to post it and cancel requests
        // so that they dont hang
        await this.publish(lockRedisKey, e)
      }

      throw e
    }
  }

  /**
   * Provides a helper over push method to be able to perform the same
   * work using promises with async/await style
   *
   * @param {String} suffix job key
   * @param {Number} [timeout] when job is considered to be failed and error is returned instead
   * @param {Function} worker async job to be performed by the party that gets the lock
   * @param {Mixed[]} [args] passed on to worker as args
   *
   * @return {Function} job handler that must be invoked with a worker that returns a promise
   */
  async fanout(suffix, ...props) {
    const propsAmount = props.length
    assert(propsAmount >= 1, 'must have at least job function passed')

    // eslint-disable-next-line prefer-const
    let [timeout, worker, ...workerArgs] = props

    // in case of 1 arg
    switch (propsAmount) {
      case 1:
        worker = timeout
        timeout = undefined
        break
      default:
        if (typeof timeout === 'function') {
          workerArgs.unshift(worker)
          worker = timeout
          timeout = undefined
        }
    }

    assert(typeof worker === 'function', 'ensure that you pass a function as a worker')
    assert(typeof timeout === 'number' || typeof timeout === 'undefined', 'invalid timeout value')

    // allows us to reject-and-halt (eg. on timeout) even if the #push'ed lock has not yet been acquired
    let jobAbortReject
    let jobAbortPromise = new Bluebird((resolve, reject) => {
      jobAbortReject = reject
    })

    let onJobCompleted
    const jobCompletedPromise = new Bluebird((resolve, reject) => {
      onJobCompleted = (err, ...args) => {
        if (err) {
          if (jobAbortPromise) {
            // ensure that jobAbortPromise rejects *first* so that we can return jobCompletedPromise *before* it rejects
            jobAbortReject(err)
            setImmediate(reject, err)
            return
          }

          reject(err)
          return
        }

        resolve(...args)
      }
    })

    let onCompleted
    try {
      const pushPromise = this.push(suffix, onJobCompleted, timeout)
      onCompleted = await Bluebird.race([
        pushPromise,
        jobAbortPromise,
      ])

      jobAbortReject = undefined
      jobAbortPromise = undefined
    } catch (err) {
      // doing this in finally {} is too late
      jobAbortReject = undefined
      jobAbortPromise = undefined

      if (notLockAcquisitionError(err)) {
        setImmediate(onJobCompleted, err)
        return jobCompletedPromise
      }

      return jobCompletedPromise
    }

    // wrap so that we have concept of "cancelling" work
    const performWork = worker(...workerArgs)

    try {
      const result = await Bluebird.race([
        performWork,
        jobCompletedPromise,
      ])

      setImmediate(onCompleted, null, result)
    } catch (err) {
      // only local timeouts would trigger this as we do strict equality
      // if there is cancel method available on the job - we'll call it
      if (isTimeoutError(err) && typeof performWork.cancel === 'function') {
        performWork.cancel()
      }

      // broadcast this everywhere so that others dont wait for longer than needed
      // as the result will fail either way
      setImmediate(onCompleted, err)
    }

    // in some cases may already be resolved/rejected
    return jobCompletedPromise
  }

  semaphore(bucket) {
    return new Semaphore(this, bucket)
  }

  /**
   * Performs task once and _does_ not notify others of it's completion
   * @param {String} suffix - queue identifier
   * @returns {Promise} if promise is resolved then we must act, if it's rejected - then
   *                    somebody else is working on the same task right now.
   *                    Caller won't be notified when task is complete
   *                    Promise contains lock, which must be released after the job is completed
   *                    Call `lock.release()` or `lock.extend` based on what's needed
   */
  async once(suffix) {
    assert(suffix, 'must be a truthy string')

    const lockRedisKey = this.key(suffix)
    const lock = this.getLock()
    await lock.acquire(lockRedisKey)
    return lock
  }

  /**
   * Acquires multi-lock. All or none strategy
   * @param  {String[]} args - array of locks to acquire
   * @return {MultiLock}
   */
  async multi(...args) {
    const actions = toFlattenedTruthyArray(args)
    assert(actions.length, 'at least 1 action must be supplied')

    try {
      const reflection = await Promise.allSettled(actions.map(action => this.once(action)))
      const locks = MultiLock.batchAction(reflection)
      return new MultiLock(locks)
    } catch (err) {
      if (err instanceof MultiLockError) {
        return MultiLock.cleanup(err)
      }

      throw err
    }
  }

  /**
   * Creates real queue, which performs operations in the order they were added to it
   * @param  {string} lockKey - Identifier, based on which we create the lock.
   * @param  {Function(completed)} jobFunction - Accepts one arg, which is a fn, which must be called when work is done.
   * @returns {Promise<*>}
   */
  serial(lockKey, jobFunction) {
    const workUnit = (next) => {
      let called = 0
      let rejected = false

      const done = (err) => {
        // in case there are some remnants of this
        if (rejected === true) return null

        // increase counter for further queueing
        called += 1

        // error handling
        if (err) {
          // if we failed to acquire lock - do a noop
          // and record failure of lock acquisition
          if (err instanceof LockAcquisitionError) {
            rejected = true
            return null
          }

          // if it's not an acquisition error - then it's operational
          // and we must end early with an error
          return next(err)
        }

        // in-case that is not an error and call counter is 1 - simply return
        // we must wait for the second call
        if (called === 1) return null

        // if we were not rejected - return control
        if (rejected === false) return next()

        // try requeueing and basically repeating operation until it succeeds
        return Bluebird.fromCallback(workUnit).asCallback(next)
      }

      return this
        .push(lockKey, done)
        .then(jobFunction)
        .asCallback(done)
    }

    return Bluebird.fromCallback(workUnit)
  }

  /**
   * Returns function that should be called with the result of the work
   * @param {String} lockRedisKey - key used for locking
   * @param {Object} acquiredLock - acquired lock
   * @returns {Function} worker - call with arguments that need to be passed to
   *                              all queued callbacks
   */
  createWorker(lockRedisKey, acquiredLock) {
    /**
     * This function must be called when job has been completed
     * @param  {Error} err
     * @param  {Array} ...args
     */
    const broadcastJobStatus = async (err, ...args) => {
      /* clen ref */
      const { lock } = broadcastJobStatus

      // because a job may take too much time, other listeners must implement timeout/retry strategy
      if (lock == null) {
        this.logger.error('lock was already released')
        return null
      }

      // clean ref
      broadcastJobStatus.lock = null

      // must release lock now. Technically there could be an event
      // where lock had not been released, notification already emitted
      // and callback is stuck in the queue, to avoid that we can add retry
      // to lock acquisition. Desicion and constraints are up to you. Ideally
      // you would want to cache result of the function for some time - and then
      // this race is completed. Multi() command is not possible to use here
      try {
        // ensure lock still belongs to us
        await lock.extend()
      } catch (error) {
        // because a job may take too much time, other listeners must implement timeout/retry strategy
        this.logger.warn({ err: error }, 'failed to release lock and publish results')
        return null
      }

      // emit event
      // at this point we are sure that this job still belongs to us,
      // if it doesn't - we can't publish response, because this task may be acquired
      // by someone else
      try {
        return await this.publish(lockRedisKey, err, ...args)
      } finally {
        /* ensure we release the lock once publish is completed */
        /* during race conditions we rely on _retry_ setting to re-acquire lock */
        lock.release().catch((err) => {
          this.logger.warn({ err }, 'failed to release lock')
        })
      }
    }

    // set associated lock -> lengthy jobs must extend this
    broadcastJobStatus.lock = acquiredLock

    return broadcastJobStatus
  }
}

/**
 * Constructor for distributed callback queue
 * @type {DistributedCallbackQueue}
 */
module.exports = exports = DistributedCallbackQueue

/**
 * Expose custom error type for MultiLock
 * @type {MultiLockError}
 */
exports.MultiLockError = MultiLockError

/**
 * Exposes MultiLock class
 * @type {MultiLock}
 */
exports.MultiLock = MultiLock
