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
