/* global describe, it, expect, jest, jasmine */
'use strict';

jest.autoMockOff();

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

    });

    describe('complete workflow', function () {

    });

});
