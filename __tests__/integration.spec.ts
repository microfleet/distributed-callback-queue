import Promise = require('bluebird')
import Redis = require('ioredis')
import assert = require('assert')
import sinon = require('sinon')
import { noop } from 'lodash'
import { DistributedCallbackQueue, MultiLockError, Semaphore } from '../src/distributed-callback-queue'
import { LockAcquisitionError } from '@microfleet/ioredis-lock'
import { setTimeout } from 'timers/promises'

describe('integration tests', () => {
  jest.setTimeout(10000)

  let queueManagers: QueueManager[]
  let ctor: any
  let config: ConstructorParameters<typeof Redis | typeof Redis.Cluster>
  let retries = 2
  let delay = 100
  if (process.env.DB === 'cluster') {
    const redisHosts = [7000, 7001, 7002]
      .map((port) => ({ host: 'redis-cluster', port }))
    config = [redisHosts, { lazyConnect: true }]
    ctor = Redis.Cluster
    retries = 10
    delay = 100
  } else if (process.env.DB === 'sentinel') {
    config = [{ sentinels: [{ host: 'redis-sentinel', port: 26379 }], name: 'mservice', lazyConnect: true }]
    ctor = Redis
  } else {
    throw new Error('invalid DB setup')
  }

  class QueueManager {
    public readonly redis: Redis.Redis | Redis.Cluster
    public readonly pubsub: Redis.Redis | Redis.Cluster
    private _dlock: DistributedCallbackQueue | null = null

    constructor() {
      this.redis = new ctor(...config)
      this.pubsub = this.redis.duplicate()
    }

    get dlock(): DistributedCallbackQueue {
      assert(this._dlock)
      return this._dlock
    }

    async ready() {
      this._dlock = new DistributedCallbackQueue({
        log: true,
        client: this.redis,
        pubsub: this.pubsub,
        pubsubChannel: 'dlock',
        lock: {
          timeout: 2000,
          retries,
          delay,
        },
      })

      await this._dlock.connect()
    }

    async close() {
      this._dlock?.close()
    }
  }

  function isLockAcquisitionError(e: unknown): e is LockAcquisitionError {
    return e instanceof Error && e.name === 'LockAcquisitionError'
  }

  beforeEach(async () => {
    queueManagers = await Promise.map(new Array(10), async () => {
      const manager = new QueueManager()
      await manager.ready()
      return manager
    })
  })

  it('#push: job is performed only once', () => {
    const args = [null, 'completed']
    const job = sinon.spy((next) => global.setTimeout(next, 500, ...args))
    const onComplete = sinon.spy()
    const failedToQueue = sinon.spy()
    const unexpectedError = sinon.spy()

    return Promise.map(queueManagers, async (queueManager) => {
      try {
        await queueManager.dlock
          .push('1', (...data) => onComplete(...data))
          .then(job)
      } catch (e) {
        if (isLockAcquisitionError(e)) {
          failedToQueue(e)
        } else {
          unexpectedError(e)
        }
      }
    })
      .delay(600)
      .then(() => {
        assert(job.calledOnce, 'job was called more than once')
        assert(onComplete.alwaysCalledWithExactly(...args), 'onComplete was called with incorrect args')
        assert.equal(onComplete.callCount, 10, 'onComplete was called wrong amount of times')
        assert.equal(failedToQueue.callCount, 9, 'unexpected error was raised')
        assert.equal(unexpectedError.called, false, 'fatal error was raised')
        return null
      })
  })

  it('#push: multiple jobs are completed only once', () => {
    const args = [null, 'completed']
    const job = sinon.spy((next) => next(...args))
    const onComplete = sinon.spy()
    const failedToQueue = sinon.spy()
    const unexpectedError = sinon.spy()

    return Promise.map(queueManagers, async (queueManager, idx) => {
      // 0 1 2
      // 0 1 2
      // 0 1 2
      // 0
      const id = String(idx % 3)

      try {
        await queueManager.dlock
          .push(id, (...data) => onComplete(id, ...data))
          .then(job)
      } catch (e) {
        if (isLockAcquisitionError(e)) {
          failedToQueue(e)
        } else {
          unexpectedError(e)
        }
      }
    })
      .delay(100)
      .then(() => {
        assert.equal(job.callCount, 3)
        assert.equal(onComplete.withArgs('0', ...args).callCount, 4)
        assert.equal(onComplete.withArgs('1', ...args).callCount, 3)
        assert.equal(onComplete.withArgs('2', ...args).callCount, 3)
        assert.equal(failedToQueue.callCount, 7, 'unexpected error was raised')
        assert.equal(unexpectedError.called, false, 'fatal error was raised')
        return null
      })
  })

  it('#push: fails after timeout', () => {
    const job = sinon.spy()
    const onComplete = sinon.spy()
    const failedToQueue = sinon.spy()
    const unexpectedError = sinon.spy()

    return Promise.map(queueManagers, async (queueManager, idx) => {
      const id = String(idx % 3)
      try {
        await queueManager.dlock
          .push(id, (...args) => onComplete(...args)) /* to ensure functions are unique */
          .then(job)
      } catch (e) {
        if (isLockAcquisitionError(e)) {
          failedToQueue(e)
        } else {
          unexpectedError(e)
        }
      }
    })
      .delay(4500) /* must be called after timeout * 2 */
      .then(() => {
        assert.equal(job.callCount, 3)
        assert.equal(onComplete.callCount, 10)
        assert.equal(onComplete.withArgs(sinon.match({ message: 'queue-no-response' })).callCount, 10)
        assert.equal(failedToQueue.callCount, 7, 'unexpected error was raised')
        assert.equal(unexpectedError.called, false, 'fatal error was raised')
        return null
      })
  })

  it('#push: when job fails onComplete is called with an error', () => {
    const args = new Error('fail')
    const job = sinon.spy((next) => next(args))
    const onComplete = sinon.spy()
    const failedToQueue = sinon.spy()
    const unexpectedError = sinon.spy()

    return Promise.map(queueManagers, async (queueManager) => {
      try {
        await queueManager.dlock
          .push('error', (...data) => onComplete(...data))
          .then(job)
      } catch (e) {
        if (isLockAcquisitionError(e)) {
          failedToQueue(e)
        } else {
          unexpectedError(e)
        }
      }
    })
      .delay(100)
      .then(() => {
        assert(job.calledOnce, 'job was called more than once')
        assert.equal(onComplete.callCount, 10, 'onComplete was called wrong amount of times')
        onComplete.args.forEach((it) => {
          const [err] = it
          const { name, message, stack } = err
          assert.equal(args.name, name)
          assert.equal(args.message, message)
          assert.ok(stack)
        })
        assert.equal(failedToQueue.callCount, 9, 'unexpected error was raised')
        assert.equal(unexpectedError.called, false, 'fatal error was raised')
        return null
      })
  })

  it('#fanout: job is performed only once', () => {
    const args = ['completed']
    const job = sinon.spy(async () => {
      await setTimeout(500)
      return [...args]
    })
    const onComplete = sinon.spy()
    const unexpectedError = sinon.spy()

    return Promise.map(queueManagers, async (queueManager) => {
      try {
        onComplete(await queueManager.dlock.fanout('1', job))
      } catch (e) {
        unexpectedError(e)
      }
    })
      .delay(600)
      .then(() => {
        assert(job.calledOnce, 'job was called more than once')
        assert(onComplete.alwaysCalledWithExactly(args), 'onComplete was called with incorrect args')
        assert.equal(onComplete.callCount, 10, 'onComplete was called wrong amount of times')
        assert.equal(unexpectedError.called, false, 'fatal error was raised')
        return null
      })
  })

  it('#fanout: multiple jobs are completed only once', () => {
    const args = ['completed']
    const arg1 = 'arg1'
    const job = sinon.spy((_: any) => args)
    const onComplete = sinon.spy()
    const unexpectedError = sinon.spy()

    return Promise.map(queueManagers, async (queueManager, idx) => {
      // 0 1 2
      // 0 1 2
      // 0 1 2
      // 0
      const id = String(idx % 3)

      try {
        onComplete(id, await queueManager.dlock.fanout(id, job, arg1))
      } catch (e) {
        unexpectedError(e)
      }
    })
      .delay(100)
      .then(() => {
        assert.equal(job.callCount, 3)
        assert.equal(job.withArgs(arg1).callCount, 3)
        assert.equal(onComplete.withArgs('0', args).callCount, 4)
        assert.equal(onComplete.withArgs('1', args).callCount, 3)
        assert.equal(onComplete.withArgs('2', args).callCount, 3)
        assert.equal(unexpectedError.called, false, 'fatal error was raised')
        return null
      })
  })

  it('#fanout: fails after timeout', async () => {
    const job = sinon.spy(async (_: any) => {
      await setTimeout(3000)
    })
    const arg1 = 'arg1'
    const onComplete = sinon.spy()
    const timeoutError = sinon.spy()
    const unexpectedError = sinon.spy()

    await Promise.map(queueManagers, async (queueManager, idx) => {
      const id = String(idx % 3)

      try {
        const result = await queueManager.dlock.fanout(id, 1500, job, arg1)
        onComplete(result)
      } catch (e: any) {
        if (e.message === 'queue-no-response') {
          timeoutError(e)
        } else {
          unexpectedError(e)
        }
      }
    })

    assert.equal(job.callCount, 3)
    assert.equal(job.withArgs(arg1).callCount, 3)
    assert.equal(onComplete.callCount, 0)
    assert.equal(timeoutError.callCount, 10)
    assert.equal(timeoutError.withArgs(sinon.match({ message: 'queue-no-response' })).callCount, 10)
    assert.equal(unexpectedError.called, false, 'fatal error was raised')
  })

  it('#fanout: fails after timeout even if lock has not been acquired', async () => {
    const job = sinon.spy(async () => {
      await setTimeout(3000)
    })
    const onComplete = sinon.spy()
    const timeoutError = sinon.spy()
    const unexpectedError = sinon.spy()
    const unacquirableLock = new Promise(noop)

    await Promise.map(queueManagers, async (queueManager, idx) => {
      const id = String(idx % 3)

      // @ts-expect-error testing
      sinon.stub(queueManager.dlock, 'getLock').returns({
        acquire() { return unacquirableLock },
      })

      try {
        const result = await queueManager.dlock.fanout(id, 1500, job)
        onComplete(result)
      } catch (e: any) {
        if (e.message === 'queue-no-response') {
          timeoutError(e)
        } else {
          unexpectedError(e)
        }
      }
    })

    assert.equal(job.callCount, 0, 'lock was acquired, jobs were called')
    assert.equal(onComplete.callCount, 0)
    assert.equal(timeoutError.callCount, 10)
    assert.equal(timeoutError.withArgs(sinon.match({ message: 'queue-no-response' })).callCount, 10)
    assert.equal(unexpectedError.called, false, 'fatal error was raised')
  })

  it('#fanout: when job fails onComplete is called with an error', () => {
    const args = new Error('fail')
    const job = sinon.spy(async () => {
      throw args
    })
    const onComplete = sinon.spy()
    const unexpectedError = sinon.spy()

    return Promise.map(queueManagers, async (queueManager) => {
      try {
        const results = await queueManager.dlock.fanout('error', job)
        onComplete(null, results)
      } catch (e: any) {
        if (e.name === args.name && e.message === args.message) {
          onComplete(e)
        } else {
          unexpectedError(e)
        }
      }
    })
      .delay(100)
      .then(() => {
        assert(job.calledOnce, 'job was called more than once')
        assert.equal(onComplete.callCount, 10, 'onComplete was called wrong amount of times')
        onComplete.args.forEach((it) => {
          const [err] = it
          const { name, message, stack } = err
          assert.equal(args.name, name)
          assert.equal(args.message, message)
          assert.ok(stack)
        })
        assert.equal(unexpectedError.called, false, 'fatal error was raised')
        return null
      })
  })

  it('#once - performs task once and rejects others', async () => {
    const job = sinon.spy()
    const failedToQueue = sinon.spy()
    const unexpectedError = sinon.spy()

    await Promise.map(queueManagers, async (queueManager) => {
      try {
        const lock = await queueManager.dlock.once('once')
        await setTimeout(1500)
        job()
        await lock.release()
      } catch (err) {
        if (isLockAcquisitionError(err)) {
          failedToQueue(err)
        } else {
          unexpectedError(err)
        }
      }
    })

    assert(job.calledOnce, 'job was called more than once')
    assert.equal(failedToQueue.callCount, 9, 'unexpected error was raised')
    assert.equal(unexpectedError.called, false, 'fatal error was raised')
  })

  it('#multi - able to acquire lock, extend it and release it', async () => {
    const job = sinon.spy()
    const [queueManager] = queueManagers

    const lock = await queueManager.dlock.multi('1', '2')
    job()
    await lock.extend(10000)
    job()
    await lock.release()
    job()

    assert.strictEqual(job.callCount, 3)
  })

  it('#multi - rejects when it can not acquire multiple locks', () => {
    const job = sinon.spy()
    const failedToQueue = sinon.spy()
    const unexpectedError = sinon.spy()
    const queueManager = queueManagers[0]

    return Promise.resolve(queueManager.dlock.once('1'))
      .tap(job)
      .tap(() => queueManager.dlock.multi('1', '2', '3'))
      .catch(MultiLockError, failedToQueue)
      .catch(unexpectedError)
      .then(() => {
        assert.equal(job.callCount, 1)
        assert.equal(failedToQueue.callCount, 1, 'unexpected error was raised')
        assert.ok(!unexpectedError.called, 'fatal error was raised')
        return null
      })
  })

  it('#multi - acquires one of locks concurrently', async () => {
    const job = sinon.spy()
    const failedToQueue = sinon.spy()
    const unexpectedError = sinon.spy()

    await Promise.map(queueManagers, async (queueManager, idx) => {
      try {
        if (idx !== 0) {
          await setTimeout(100) // give a chance for first idx to acquire _all_ locks so that test isnt flaky
        }
        const lock = await queueManager.dlock.multi('5', '6', '7')
        await setTimeout(1500)
        await lock.release()
        job()
      } catch (err) {
        if (err instanceof MultiLockError) {
          failedToQueue()
        } else {
          unexpectedError()
        }
      }
    })

    assert.equal(job.callCount, 1)
    assert.strictEqual(failedToQueue.callCount, 9, 'unexpected error was raised')
    assert.strictEqual(unexpectedError.called, false, 'fatal error was raised')
  })

  describe('#semaphore', () => {
    let counter = 0
    let semaphores: Semaphore[]

    beforeEach(() => {
      counter = 0
      semaphores = queueManagers.map((manager) => (
        manager.dlock.semaphore('test-semaphore')
      ))
    })

    it('ensure each operation is processed serially, no disposer', () => (
      Promise
        .map(Array(50), async (_, i) => {
          const semaphore = semaphores[i % semaphores.length]
          try {
            await semaphore.take()
            counter += 1
            // if it's possible for other contestants
            // to run out of semaphore lock - counter will
            // increase multiple times before resolving following promise
            await setTimeout(10)

            // return the counter
            return counter - 1
          } finally {
            semaphore.leave()
          }
        })
        .then((args) => {
          assert.equal(args.length, 50)
          args.sort((a, b) => a - b).forEach((arg, i) => {
            assert.equal(arg, i)
          })
          return null
        })
    ))
  })

  afterEach(async () => {
    await queueManagers[0].redis.flushdb()
    await Promise.map(queueManagers, (queueManager) => queueManager.dlock.close())
  })
})
