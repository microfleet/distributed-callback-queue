/* global describe, it, expect, jest, jasmine */
'use strict';

jest.autoMockOff();

// mock redis lock module
jest.setMock('redislock', {

    errors: require('redislock/lib/errors'),

    locks: {},

    createLock: function () {
        var self = this,
            obj;

        obj = {

            acquire: function (key, callback) {

                if (!self.locks[key]) {
                    self.locks[key] = true;
                    return setImmediate(callback);
                }

                obj.release = function (done) {

                    if (self.locks[key]) {
                        delete self.locks[key];
                        return setImmediate(callback);
                    }

                    return setImmediate(done, new self.errors.LockReleaseError('no lock'));
                };

                setImmediate(callback, new self.errors.LockAcquisitionError('lock already acquired'));

            }

        };

        return obj;

    }

});

jest.setMock('arklogger', {});

describe('Distributed callback queue', function () {

    it('callback queue: should queue new job request', function () {
        var callbackQueue = require('../lib/callback-queue.js');
        var fn = jest.genMockFn();
        var queue = callbackQueue._queue();
        var keyname = 'test-queue';
        var hasQueued = callbackQueue.add(keyname, fn);

        expect(hasQueued).toBe(true);
        expect(queue[keyname]).toEqual(jasmine.any(Function));

        var arg1 = 'yahoo';
        queue[keyname](null, arg1);

        jest.runAllTimers();

        expect(fn).toBeCalledWith(null, arg1);
        expect(fn.mock.calls.length).toBe(1);
    });

    it('local callback queue', function () {
        var callbackQueue = require('../lib/callback-queue.js');
        var callback = jest.genMockFn();
        var callMock = jest.genMockFn().mockImpl(function () {
            return callbackQueue._call.apply(null, arguments);
        });

        // mock call
        callbackQueue._setCall(callMock);

        // vars
        var queueName = 'test-local';
        var pubsubChannel = 'test';
        var redisPublisher = { publish: jest.genMockFn() };
        var redisConsumer = { subscribe: jest.genMockFn() };
        var logger = { warn: jest.genMockFn() };

        var consumer = callbackQueue.createConsumer(redisConsumer, pubsubChannel, logger);
        var publisher = callbackQueue.createPublisher(redisPublisher, pubsubChannel);

        // wire publish to local subscribed channel
        redisPublisher.publish.mockImpl(consumer);

        var isQueued = callbackQueue.add(queueName, callback);

        // checks queue
        expect(isQueued).toBe(true);
        expect(callbackQueue._queue()[queueName]).toEqual(jasmine.any(Function));

        // check subscription
        expect(redisConsumer.subscribe).toBeCalledWith(pubsubChannel);
        expect(redisConsumer.subscribe.mock.calls.length).toBe(1);

        var message = { queued: true };
        publisher(queueName, null, message);

        jest.runAllTimers();

        expect(callbackQueue._queue()[queueName]).toEqual(null);
        expect(redisPublisher.publish.mock.calls.length).toBe(1);
        expect(redisPublisher.publish).toBeCalledWith(pubsubChannel, JSON.stringify([ queueName, [ null, message ] ]));

        expect(callback.mock.calls.length).toBe(1);
        expect(callback).toBeCalledWith(null, message);

        expect(callMock.mock.calls.length).toBe(2);
        expect(callMock).toBeCalledWith(queueName, [ null, message ]);

        expect(logger.warn.mock.calls.length).toBe(0);

    });

    describe('lock acquisition', function () {
        var DCQ = require('../index.js');

        var fn = jest.genMockFn();
        var done = jest.genMockFn();
        var key = 'lock-acq-test';

        var context = {
            createWorker: DCQ.prototype.createWorker,
            lockPrefix: '',
            lockOptions: {
                timeout: 20000,
                retry: 0,
                delay: 0
            }
        };

        // this will queue, but it will resolve as a second function, because
        // there is a shortcut before lock acquisition
        DCQ.prototype.push.call(context, key, fn, done);

        // wont resolve
        DCQ.prototype.push.call(context, key, fn, done);

        jest.runAllTimers();

        expect(fn.mock.calls.length).toBe(0);
        expect(done.mock.calls.length).toBe(2);

        expect(done.mock.calls[0]).toEqual([null, false]);
        expect(done.mock.calls[1]).toEqual([null, jasmine.any(Function)]);

    });

});
