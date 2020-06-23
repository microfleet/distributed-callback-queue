# Distributed callback queue

[![Codacy Badge](https://www.codacy.com/project/badge/1a90183ad6964bfca54a7ba0f4b9b3a7)](https://www.codacy.com/app/v/distributed-callback-queue)

Purpose of this module to allow only 1 similar action to run at the same time across any amount
of the machines. This task is solved by the means of acquiring lock before any action
is performed. Currently redis is used as a backing provider, which is super fast,
and more than reliable for this task, especially when combined with redis-sentinel, or cluster
in the future (once it's production ready).

This library requires you to pass 2 redis instances: 1 will be used for acquiring and releasing locks
and the other one for pubsub events (and this is how the system becomes distributed)

`npm install dlock -S`

## Usage

[Opts description](https://github.com/AVVS/distributed-callback-queue/blob/master/lib/distributed-callback-queue.js#L8-L23)

```js
const CallbackQueue = require('dlock');

// assume we have 2 redis clients ready
// one called `redis` and the other `pubsub`. They must be different clients
// technically they can even connect to different redis instances machines,
// since they are used for 2 separate tasks
```

### Sample configuration

```js
const opts = {
  client: redis,  // lock acquisition, can be shared with the rest of the app
  pubsub: pubsub, // pubsub, please do not share unless you know what you are doing
  pubsubChannel: '{mypubsubchannel}',
  lock: {
    timeout: 20000, // in 20000ms lock will expire, defaults to 10000
    retries: 0, // if we failed to acquire lock for the first time, retry in `delay`. Defaults to 1
    delay: 500 // retry in 500 ms when acquiring new lock. Default: 100
  },
  lockPrefix: '{mylockprefix}', // used for prefixing keys in redis and in local queue, defaults to {dcb}
  log: false // turn of logging
};

const callbackQueue = new CallbackQueue(opts);
```

### In-flight Request Caching

Perform only 1 request and fan-out results via redis pubsub on the network, so that
we never perform more than 1 requests to the same resource in parallel

```js
/**
 * Method push
 * Accepts following arguments:
 * `id` {String} identificator of the job. Unique across processes between same lockPrefix
 * `onJobcompleted` {Function} called when job has been completed or failed
 * @returns {Promise} called after `onJobCompleterd` has been added to queue
 */
const errPredicate = err => err.name !== 'LockAcquisitionError';

callbackQueue
  .push('jobid', onJobCompleted)
  .then(completed => {
    // do work and call completed once it's done
    // when completed is called, onJobCompleted will be invoked with the args
    // that were passed from here

    const nastylongcalculations = 1 + 1;
    completed(null, nastylongcalculations);
  })
  // omit that error
  .catch({ name: 'LockAcquisitionError' }, noop)
  // handle this one
  .catch(errPredicate, err => {
    // failed to queue
  });

/**
 * Will be called once job had been completed
 * This function will be called for every queued callback
 */
function onJobCompleted(err, ...args) {
    if (err) {
        // first arg is canonical error
        // you decide what the rest of args are, but make sure that first one
        // is an error
        return console.error('Failed to complete job: ', err);
    }

    // prints 2
    console.log(args[0]);
}
```

### Async/Await in-flight request caching

#### Fanout(jobId: String, [timeout: Number], job: Function, [...args]: any[])

Use `fanout(...)` method for the easiest way to handle job subscriptions where
one actor must perform long-running job, but as soon as it's done - everyone who
queued for the results of this job must be notified.

`args` are optional args to be passed on to the job function. If you need to preserve context - use .bind

Sample of code is provided to make use of this feature:

```js
const jobId = 'xxx';
const job = async () => {
  await Promise.delay(10000);
  return 'done';
}

let result;
try {
  result = await callbackQueue.fanout(jobId, 2000, job);
} catch (e) {
  // handle timeout error - because it will fail
}

try {
  result = await callbackQueue.fanout(jobId, 20000, job);
  // result will be equal 'done'
} catch (e) {
  // no error is expected, but make sure you handle unexpected cases
}
```

### Distributed Resource Locking

Allows to acquire lock across multiple processes with redis based lock

```js
/**
 * Method `once` - means there can only be 1 concurrent task
 * and callers will be rejected if they can't acquire lock
 */

callbackQueue
  .once('app:job:processing')
  .then(lock => {
    // perform lengthy calculations here
    // call `lock.extend()` if needed

    // do not forget to release lock after the job is done
    // do not care about result
    return lock.release().reflect();
  })
  .catch(err => {
    // lock could not be acquire
  })
```

### Distributed Locking on Multiple Keys

A little more complex lock, which ensures that we can acquire all locks from a list.
When at least one lock is not acquired - we can't proceed further.
This can be helpful in cases when partial resource can be altered in a separate action
and side-effect from such event would affect further actions from a multi lock.

```js
/**
 * Method `multi` - similar to once, except that it expects to hold
 * multiple locks concurrently. This is useful when you want to perform non-atomic
 * changes on different resource and must ensure that they don't change during the transaction
 */
const { MultiLockError } = CallbackQueue;
callbackQueue
  .multi('1', '2', '3', ['4', '5'])
  .then(multiLock => {
    // multiLock has the same interface as normal lock
    // .release()
    // .extend()

    return multiLock
      // will reject promise if it can't extend ALL the locks,
      // you can catch `MultiLockError`, which extends Promise.AggregateError
      // and has the same interface + `.locks`. If MultiLockError is thrown
      // successfully extends locks would be automatically released
      .extend(1000)
      .then(() => longRunningJob())
      // same as .extend in terms of cleaning up
      // in case we can't do it - it will throw
      .then(() => multiLock.release())
      .catch(MultiLockError, e => {
        // re-throw generic error so that it doesn't end up in the generic error handler
      });
  })
  .catch(MultiLockError, e => {
    // could not acquire locks
  })
  .catch(e => {
    // unexpected error - perhaps redis was offline
    // or timed out. ioredis-created errors would be defined here
  });
```

### Semaphore

Ensures that all requests are processed one by one. It doesn't guarantee FIFO, but ensures that
not more than 1 request runs at any given time.

```js
const Promise = require('bluebird');
const semaphore = callbackQueue.semaphore('job:id');

// option 1 - use disposer that will automatically call semaphore.leave
Promise.using(semaphore.take(), () => {
  // do some work, return promise
});

// option 2 - without disposer
await semaphore.take(false);
try {
  // perform some async work and ensure we call leave afterwards
} finally {
  semaphore.leave();
}
```
