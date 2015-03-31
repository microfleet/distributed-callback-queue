# Distributed callback queue

[![Codacy Badge](https://www.codacy.com/project/badge/1a90183ad6964bfca54a7ba0f4b9b3a7)](https://www.codacy.com/app/v/distributed-callback-queue)

Purpose of this module to allow only 1 similar action to run at the same time across any amount
of the machines. This task is solved by the means of acquiring lock before any action
is performed. Currently redis is used as a backing provider, which is super fast,
and more than reliable for this task, especially when combined with redis-sentinel, or cluster
in the future (once it's production ready).

This library requires you to pass 2 redis instances: 1 will be used for acquiring and releasing locks
and the other one for pubsub events (and this is how the system becomes distributed)

`npm install distributed-callback-queue -S`

***Notice***

Because nodejs errors do not have own enumerable properties, and we still want stack-traces,
messages, and other fancy stuff, this module uses `error-tojson`, which makes properties
of error objects enumerable. Therefore, make sure you do not include circular references
in the error object, as it will kill your process

## Usage

[Opts description](https://github.com/AVVS/distributed-callback-queue/blob/master/lib/distributed-callback-queue.js#L8-L23)

```js
var CallbackQueue = require('distributed-callback-queue');

// assume we have 2 redis clients ready
// one called `redis` and the other `pubsub`. They must be different clients
// technically they can even connect to different redis instances machines,
// since they are used for 2 separate tasks

var opts = {
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

var callbackQueue = new CallbackQueue(opts);

/**
 * Method push
 * Accepts following arguments:
 * `id` {String} identificator of the job. Unique across processes between same lockPrefix
 * `onJobcompleted` {Function} called when job has been completed or failed
 * `onJobQueued` {Function} called after `onJobCompleterd` has been added to queue
 */
callbackQueue.push('jobid', onJobCompleted, onJobQueued);

/**
 * Will be called once job had been completed
 * This function will be called for every queued callback
 */
function onJobCompleted(err, arg1, arg2, ..., argN) {
    if (err) {
        // first arg is canonical error
        // you decide what the rest of args are, but make sure that first one
        // is an error
        return console.error('Failed to complete job: ', err);
    }

    // equals 10
    console.log(arg1);
}

/**
 * This function is called once lock has either failed to be acquired or
 * was acquired. In case of the latter, we need to perform our desired job here
 * @param {Errir}   err
 * @param {Boolean|Function} workCompleted
 */
function onJobQueued(err, workCompleted) {
    if (err) {
        // smth gone wrong - maybe redis is down, onJobCompleted will be called with this error
        return;
    }

    if (!workCompleted) {
        // someone else has the lock, don't do anything
        return;
    }

    // I've got the lock, do something
    var nastylongcalculations = 1 + 1;

    workCompleted(null, nastylongcalculations);
}

```
