/* global describe, beforeEach, afterEach, it */
const Promise = require('bluebird');
const Redis = require('ioredis');
const assert = require('assert');
const DLock = require('..');
const sinon = require('sinon');

describe('integration tests', () => {
  function QueueManager() {
    this.redis = new Redis({ lazyConnect: true });
    this.pubsub = this.redis.duplicate();
    return Promise
      .join(this.redis.connect(), this.pubsub.connect())
      .then(() => {
        this.dlock = new DLock({
          client: this.redis,
          pubsub: this.pubsub,
          pubsubChannel: 'dlock',
        });
      })
      .return(this);
  }

  function isLockAcquisitionError(e) {
    return e.name === 'LockAcquisitionError';
  }

  beforeEach('creates queue managers', () => {
    return Promise
      .map(Array(10), () => {
        return new QueueManager();
      })
      .then(queueManagers => {
        this.queueManagers = queueManagers;
      });
  });

  it('#push: job is performed only once', () => {
    const args = [null, 'completed'];
    const job = sinon.spy(next => setTimeout(next, 500, ...args));
    const onComplete = sinon.spy();
    const failedToQueue = sinon.spy();
    const unexpectedError = sinon.spy();

    return Promise.map(this.queueManagers, queueManager => {
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
    });
  });

  it('#push: when job fails onComplete is called with an error', () => {
    const args = new Error('fail');
    const job = sinon.spy(next => next(args));
    const onComplete = sinon.spy();
    const failedToQueue = sinon.spy();
    const unexpectedError = sinon.spy();

    return Promise.map(this.queueManagers, queueManager => {
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
      onComplete.args.forEach(it => {
        const [err] = it;
        const { name, message, stack } = err;
        assert.equal(args.name, name);
        assert.equal(args.message, message);
        assert.ok(stack);
      });
      assert.equal(failedToQueue.callCount, 9, 'unexpected error was raised');
      assert.equal(unexpectedError.called, false, 'fatal error was raised');
    });
  });

  it('#once - performs task once and rejects others', () => {
    const job = sinon.spy();
    const failedToQueue = sinon.spy();
    const unexpectedError = sinon.spy();

    return Promise.map(this.queueManagers, queueManager => {
      return queueManager.dlock.once('once')
        .then(lock => {
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
    });
  });

  afterEach('cleans up redis', () => {
    return this.queueManagers[0].redis.flushdb();
  });

  afterEach('disconnects clients', () => {
    return Promise.map(this.queueManagers, queueManager => {
      return Promise.join(
        queueManager.redis.disconnect(),
        queueManager.pubsub.disconnect()
      );
    });
  });
});
