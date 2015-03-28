/* global describe, it, expect, jest, jasmine */
'use strict';

jest.autoMockOff();

// stupid jest doesnt work with native module for some reason
jest.setMock('msgpack', {

    pack: function (obj) {
        return JSON.stringify(obj);
    },

    unpack: function (obj) {
        return JSON.parse(obj);
    }

});

describe('Distributed callback queue', function () {

    describe('callback queue', function () {

        it('should queue new job request', function () {
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

    });

    describe('local callback queue', function () {

    });

    describe('lock acquisition', function () {

    });

    describe('complete workflow', function () {

    });

});
