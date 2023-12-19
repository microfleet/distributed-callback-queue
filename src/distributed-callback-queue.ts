import Bluebird = require('bluebird')
import redislock = require('@microfleet/ioredis-lock')
import Redis = require('ioredis')
import { pino } from 'pino'
import assert = require('assert')
import readPkg = require('read-pkg-up')

// lodash helpers
import defaults = require('lodash/defaults')
import flatten = require('lodash/fp/flatten')
import filter = require('lodash/fp/filter')
import compose = require('lodash/fp/compose')

// internal deps
import * as callbackQueue from './callback-queue'
import { Semaphore } from './semaphore'
import { MultiLock, MultiLockError } from './multi-lock'
import { Thunk } from '@microfleet/callback-queue'

const { LockAcquisitionError } = redislock
const isBoolean = filter<string>(Boolean)
const toFlattenedTruthyArray = compose(isBoolean, flatten)
const couldNotAcquireLockError = new LockAcquisitionError('job is already running')
const TimeoutError = new Bluebird.TimeoutError('queue-no-response')
const notLockAcquisitionError = (e: unknown): e is Error => e instanceof Error && e.name !== 'LockAcquisitionError'
const isTimeoutError = (e: unknown): e is typeof TimeoutError => e === TimeoutError
const pkg = readPkg.sync()?.packageJson

export interface Config {
  client: Redis.Redis | Redis.Cluster
  pubsub: Redis.Redis | Redis.Cluster
  pubsubChannel: string
  lock: Partial<redislock.Config>
  log: Logger | boolean
  lockPrefix: string
  debug: boolean
  name: string
}

export type Logger = pino.Logger

export type Worker = {
  (err?: Error | null, ...args: any[]): Promise<void | null>
  lock: redislock.Lock | null
}

// eslint-disable-next-line @typescript-eslint/ban-types
function hasProp<K extends PropertyKey>(data: object, prop: K): data is Record<K, unknown> {
  return prop in data
}

/**
 * @class DistributedCallbackQueue
 *
 * Init distributed callback queue
 * @param options:
 *    @param client: redis connection that will be used for communications
 *    @param pubsub: redis connection that will be used for notifications
 *    @param pubsubChannel - will be used to pass notifications
 *    @param lock - configuration for redislock:
 *        @param timeout - defaults to 10000
 *        @param retries - defaults to 0
 *        @param delay - defaults to 100
 *    @param [log] sets up logger. If set to false supresses all warnings
 *    @param [name] name to use when reporting
 *    @param [debug=false] show additional diagnostic information
 *    @param lockPrefix - used for creating locks in redis
 */
export class DistributedCallbackQueue {
  public readonly logger: Logger
  private readonly lockPrefix: string
  private readonly client: Config['client']
  private readonly pubsub: Config['pubsub']
  private readonly lockOptions: redislock.Config
  private readonly pubsubChannel: string
  private publish!: callbackQueue.Publisher
  private consume!: callbackQueue.Consumer

  constructor(options: Partial<Config> = {}) {
    const { client } = options
    assert.ok(client, 'options.client must be defined')

    const pubsub = options.pubsub || client.duplicate()
    if (!(pubsub instanceof Redis.Cluster)) {
      assert.notStrictEqual(client, pubsub, 'options.client and options.pubsub must have separate redis clients')
    }

    const { pubsubChannel } = options
    assert.ok(pubsubChannel, 'pubsubChannel must be specified')
    this.pubsubChannel = pubsubChannel

    assert(pkg, 'must be able to find package.json')

    const lockOptions = defaults(options.lock || {}, {
      timeout: 10000,
      retries: 3,
      jitter: 1.5,
      delay: 100,
    })

    this.logger = DistributedCallbackQueue.initLogger(options)
    this.client = client
    this.pubsub = pubsub
    this.lockOptions = lockOptions
    this.lockPrefix = options.lockPrefix || pkg.name
  }

  async connect() {
    const { client, pubsub } = this

    this.logger.info('connecting redis clients')
    await Promise.all([client.connect(), pubsub.connect()])

    this.publish = callbackQueue.createPublisher(client, this.pubsubChannel, this.logger)
    this.consume = callbackQueue.createConsumer(pubsub, this.pubsubChannel, this.logger)
    this.pubsub.on('messageBuffer', this.consume)
    this.logger.info('Initialized...')
  }

  async close() {
    const { client, pubsub } = this

    this.logger.info('disconnecting redis clients')
    await Promise.all([
      client.quit(),
      pubsub.quit()
    ])
  }

  static isCompatibleLogger(logger: unknown): logger is Logger {
    if (typeof logger !== 'object' || logger == null) {
      return false
    }

    for (const level of ['debug', 'info', 'warn', 'error', 'fatal'].values()) {
      if (!hasProp(logger, level) || typeof logger[level] !== 'function') {
        return false
      }
    }

    return true
  }

  static initLogger(options: Partial<Pick<Config, 'log' | 'debug' | 'name'>>): Logger {
    const { log: logger, debug, name } = options
    const loggerEnabled = typeof logger === 'undefined' ? !!debug : logger

    if (loggerEnabled && DistributedCallbackQueue.isCompatibleLogger(logger)) {
      return logger
    }

    let level = 'silent'
    if (loggerEnabled) {
      level = debug ? 'debug' : 'info'
    }

    assert(pkg, 'package.json couldnt be found')

    return pino({ name: name || pkg.name, level }, pino.destination(1))
  }

  /**
   * Combines task key
   * @param suffix
   */
  key(suffix: string): string {
    return `${this.lockPrefix}${suffix}`
  }

  /**
   * Creates lock instance
   * @return {Lock}
   */
  getLock(): redislock.Lock {
    return redislock.createLock(this.client, this.lockOptions)
  }

  /**
   * Adds callback to distributed queue
   * @param suffix - queue identifier
   * @param next - callback to be called when request is finished
   * @param [timeout=this.lockOptions.timeout * 2] - fail after <timeout>, set to 0 to disable
   * @returns if promise is resolved then we must act, if it's rejected - then
   *                    somebody else is working on the same task right now
   */
  async push(suffix: string, next: Thunk, timeout = this.lockOptions.timeout * 2): Promise<Worker> {
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
      return this.createWorker(lockRedisKey, lock)
    } catch (e: unknown) {
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
   * @param suffix job key
   * @param [timeout] when job is considered to be failed and error is returned instead
   * @param worker async job to be performed by the party that gets the lock
   * @param [args] passed on to worker as args
   *
   * @return job handler that must be invoked with a worker that returns a promise
   */
  async fanout(suffix: string, ...props: any[]): Promise<any> {
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
    let jobAbortReject: undefined | ((err?: Error | null) => void)
    let jobAbortPromise: Promise<any> | undefined = new Bluebird((_, reject) => {
      jobAbortReject = reject
    })

    let onJobCompleted: (err?: Error | null, args?: any) => void
    const jobCompletedPromise = new Bluebird((resolve, reject) => {
      onJobCompleted = (err, args) => {
        if (err) {
          if (jobAbortPromise && jobAbortReject) {
            // ensure that jobAbortPromise rejects *first* so that we can return jobCompletedPromise *before* it rejects
            jobAbortReject(err)
            setImmediate(reject, err)
            return
          }

          reject(err)
          return
        }

        resolve(args)
      }
    })

    let onCompleted
    try {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const pushPromise = this.push(suffix, onJobCompleted!, timeout)
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
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        setImmediate(onJobCompleted!, err)
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

  semaphore(bucket: string): Semaphore {
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
  async once(suffix: string): Promise<redislock.Lock> {
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
  async multi(...args: any[]): Promise<MultiLock> {
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
   * Returns function that should be called with the result of the work
   * @param lockRedisKey - key used for locking
   * @param acquiredLock - acquired lock
   * @returns worker - call with arguments that need to be passed to
   *    all queued callbacks
   */
  createWorker(lockRedisKey: string, acquiredLock: redislock.Lock): Worker {
    /**
     * This function must be called when job has been completed
     * @param  {Error} err
     * @param  {Array} ...args
     */
    const broadcastJobStatus: Worker = async (err?: Error | null, ...args: any[]): Promise<void | null> => {
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

export { MultiLockError, MultiLock, Semaphore }
