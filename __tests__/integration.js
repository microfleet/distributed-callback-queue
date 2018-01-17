const Promise = require('bluebird');
const Redis = require('ioredis');
const assert = require('assert');
const DLock = require('..');
const sinon = require('sinon');

describe('integration tests', () => {
  jest.setTimeout(10000);

  function QueueManager() {
    this.redis = new Redis({ host: 'redis', lazyConnect: true });
    this.pubsub = this.redis.duplicate();
    return Promise
      .join(this.redis.connect(), this.pubsub.connect())
      .then(() => {
        this.dlock = new DLock({
          logger: true,
          client: this.redis,
          pubsub: this.pubsub,
          pubsubChannel: 'dlock',
          lock: {
            timeout: 2000,
          },
        });
        return null;
      })
      .return(this);
  }

  function isLockAcquisitionError(e) {
    return e.name === 'LockAcquisitionError';
  }

  beforeEach(() => {
    return Promise
      .map(new Array(10), () => new QueueManager())
      .then((queueManagers) => {
        this.queueManagers = queueManagers;
        return null;
      });
  });

  it('#push: job is performed only once', () => {
    const args = [null, 'completed'];
    const job = sinon.spy(next => setTimeout(next, 500, ...args));
    const onComplete = sinon.spy();
    const failedToQueue = sinon.spy();
    const unexpectedError = sinon.spy();

    return Promise.map(this.queueManagers, (queueManager) => {
      return queueManager.dlock
        .push('1', (...data) => onComplete(...data))
        .then(job)
        .catch(isLockAcquisitionError, failedToQueue)
        .catch(unexpectedError);
    })
      .delay(600)
      .then(() => {
        assert(job.calledOnce, 'job was called more than once');
        assert(onComplete.alwaysCalledWithExactly(...args), 'onComplete was called with incorrect args');
        assert.equal(onComplete.callCount, 10, 'onComplete was called wrong amount of times');
        assert.equal(failedToQueue.callCount, 9, 'unexpected error was raised');
        assert.equal(unexpectedError.called, false, 'fatal error was raised');
        return null;
      });
  });

  it('#push: multiple jobs are completed only once', () => {
    const args = [null, 'completed'];
    const job = sinon.spy(next => next(...args));
    const onComplete = sinon.spy();
    const failedToQueue = sinon.spy();
    const unexpectedError = sinon.spy();

    return Promise.map(this.queueManagers, (queueManager, idx) => {
      // 0 1 2
      // 0 1 2
      // 0 1 2
      // 0
      const id = String(idx % 3);
      return queueManager.dlock
        .push(id, (...data) => onComplete(id, ...data))
        .then(job)
        .catch(isLockAcquisitionError, failedToQueue)
        .catch(unexpectedError);
    })
      .delay(100)
      .then(() => {
        assert.equal(job.callCount, 3);
        assert.equal(onComplete.withArgs('0', ...args).callCount, 4);
        assert.equal(onComplete.withArgs('1', ...args).callCount, 3);
        assert.equal(onComplete.withArgs('2', ...args).callCount, 3);
        assert.equal(failedToQueue.callCount, 7, 'unexpected error was raised');
        assert.equal(unexpectedError.called, false, 'fatal error was raised');
        return null;
      });
  });

  it('#push: fails after timeout', () => {
    const job = sinon.spy();
    const onComplete = sinon.spy();
    const failedToQueue = sinon.spy();
    const unexpectedError = sinon.spy();

    return Promise.map(this.queueManagers, (queueManager, idx) => {
      const id = String(idx % 3);
      return queueManager.dlock
        .push(id, (...args) => onComplete(...args)) /* to ensure functions are unique */
        .then(job)
        .catch(isLockAcquisitionError, failedToQueue)
        .catch(unexpectedError);
    })
      .delay(4500) /* must be called after timeout * 2 */
      .then(() => {
        assert.equal(job.callCount, 3);
        assert.equal(onComplete.callCount, 10);
        assert.equal(onComplete.withArgs(sinon.match({ message: 'queue-no-response' })).callCount, 10);
        assert.equal(failedToQueue.callCount, 7, 'unexpected error was raised');
        assert.equal(unexpectedError.called, false, 'fatal error was raised');
        return null;
      });
  });

  it('#push: when job fails onComplete is called with an error', () => {
    const args = new Error('fail');
    const job = sinon.spy(next => next(args));
    const onComplete = sinon.spy();
    const failedToQueue = sinon.spy();
    const unexpectedError = sinon.spy();

    return Promise.map(this.queueManagers, (queueManager) => {
      return queueManager.dlock
        .push('error', (...data) => onComplete(...data))
        .then(job)
        .catch(isLockAcquisitionError, failedToQueue)
        .catch(unexpectedError);
    })
      .delay(100)
      .then(() => {
        assert(job.calledOnce, 'job was called more than once');
        assert.equal(onComplete.callCount, 10, 'onComplete was called wrong amount of times');
        onComplete.args.forEach((it) => {
          const [err] = it;
          const { name, message, stack } = err;
          assert.equal(args.name, name);
          assert.equal(args.message, message);
          assert.ok(stack);
        });
        assert.equal(failedToQueue.callCount, 9, 'unexpected error was raised');
        assert.equal(unexpectedError.called, false, 'fatal error was raised');
        return null;
      });
  });

  it('#once - performs task once and rejects others', () => {
    const job = sinon.spy();
    const failedToQueue = sinon.spy();
    const unexpectedError = sinon.spy();

    return Promise.map(this.queueManagers, (queueManager) => {
      return queueManager.dlock.once('once')
        .then((lock) => {
          return Promise.delay(1000)
            .then(() => {
              return lock.release();
            })
            .then(() => {
              return job();
            });
        })
        .catch(isLockAcquisitionError, failedToQueue)
        .catch(unexpectedError);
    })
      .then(() => {
        assert(job.calledOnce, 'job was called more than once');
        assert.equal(failedToQueue.callCount, 9, 'unexpected error was raised');
        assert.equal(unexpectedError.called, false, 'fatal error was raised');
        return null;
      });
  });

  it('#multi - able to acquire lock, extend it and release it', () => {
    const job = sinon.spy();
    const failedToQueue = sinon.spy();
    const unexpectedError = sinon.spy();
    const queueManager = this.queueManagers[0];

    return queueManager
      .dlock
      .multi('1', '2')
      .tap(job)
      .tap(lock => lock.extend(10000))
      .tap(job)
      .tap(lock => lock.release())
      .tap(job)
      .catch(DLock.MultiLockError, failedToQueue)
      .catch(unexpectedError)
      .then(() => {
        assert.equal(job.callCount, 3);
        assert.ifError(failedToQueue.called, 'unexpected error was raised');
        assert.ifError(unexpectedError.called, 'fatal error was raised');
        return null;
      });
  });

  it('#multi - rejects when it can not acquire multiple locks', () => {
    const job = sinon.spy();
    const failedToQueue = sinon.spy();
    const unexpectedError = sinon.spy();
    const queueManager = this.queueManagers[0];

    return queueManager.dlock.once('1')
      .tap(job)
      .tap(() => queueManager.dlock.multi('1', '2', '3'))
      .catch(DLock.MultiLockError, failedToQueue)
      .catch(unexpectedError)
      .then(() => {
        assert.equal(job.callCount, 1);
        assert.equal(failedToQueue.callCount, 1, 'unexpected error was raised');
        assert.ifError(unexpectedError.called, 'fatal error was raised');
        return null;
      });
  });

  it('#multi - acquires one of locks concurrently', () => {
    const job = sinon.spy();
    const failedToQueue = sinon.spy();
    const unexpectedError = sinon.spy();

    return Promise
      .map(this.queueManagers, (queueManager) => {
        return queueManager.dlock
          .multi('1', '2', '3')
          .then(lock => (
            Promise
              .delay(1000)
              .then(() => lock.release())
              .then(job)
          ))
          .catch(DLock.MultiLockError, failedToQueue)
          .catch(unexpectedError);
      })
      .then(() => {
        assert(job.calledOnce, 'job was called more than once');
        assert.equal(failedToQueue.callCount, 9, 'unexpected error was raised');
        assert.equal(unexpectedError.called, false, 'fatal error was raised');
        return null;
      });
  });

  describe('#semaphore', () => {
    beforeEach(() => {
      this.counter = 0;
      this.semaphores = this.queueManagers.map(manager => (
        manager.dlock.semaphore('test-semaphore')
      ));
    });

    it('ensure each operation is processed serially', () => (
      Promise
        .map(Array(50), (_, i) => {
          const semaphore = this.semaphores[i % this.semaphores.length];
          return Promise.using(semaphore.take(), async () => {
            this.counter += 1;
            // if it's possible for other contestants
            // to run out of semaphore lock - this.counter will
            // increase multiple times before resolving following promise
            await Promise.delay(10);

            // return the counter
            return this.counter - 1;
          });
        })
        .then((args) => {
          assert.equal(args.length, 50);
          args.sort((a, b) => a - b).forEach((arg, i) => {
            assert.equal(arg, i);
          });
          return null;
        })
    ));

    afterEach(() => {
      this.semaphores = null;
    });
  });

  afterEach(async () => {
    await this.queueManagers[0].redis.flushdb();
    return Promise.map(this.queueManagers, (queueManager) => {
      return Promise.join(
        queueManager.redis.disconnect(),
        queueManager.pubsub.disconnect()
      );
    });
  });
});
