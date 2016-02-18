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

  it('job is performed only once', () => {
    const args = [null, 'completed'];
    const job = sinon.spy(next => setTimeout(next, 500, ...args));
    const onComplete = sinon.spy();
    const failedToQueue = sinon.spy();
    const unexpectedError = sinon.spy(); // eslint-disable-line no-console

    return Promise.map(this.queueManagers, queueManager => {
      return queueManager.dlock
        .push('1', (...data) => onComplete(...data))
        .then(job)
        .catch(isLockAcquisitionError, failedToQueue)
        .catch(unexpectedError);
    })
    .delay(1000)
    .then(() => {
      assert(job.calledOnce, 'job was called more than once');
      assert(onComplete.alwaysCalledWithExactly(...args), 'onComplete was called with incorrect args');
      assert.equal(onComplete.callCount, 10, 'onComplete was called wrong amount of times');
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
