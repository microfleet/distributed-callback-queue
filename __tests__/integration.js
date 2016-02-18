/* global describe, beforeEach, afterEach */
const Promise = require('bluebird');
const Redis = require('ioredis');
const assert = require('assert');
const DLock = require('dlock');

describe('integration tests', () => {
  beforeEach('creates redis connection', () => {
    this.redis = new Redis({ lazyConnect: true });
    this.pubsub = this.redis.duplicate();
    return Promise.join(this.redis.connect(), this.pubsub.connect());
  });

  beforeEach('creates distrubuted lock queue', () => {
    this.dlock = new DLock({
      client: this.redis,
      pubsub: this.pubsub,
      pubsubChannel: 'dlock',
    });
  });

  afterEach('closes redis connection', () =>
    Promise.join(
      this.redis.quit(),
      this.pubsub.quit(),
    )
  );
});
