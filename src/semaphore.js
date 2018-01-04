const Deque = require('denque');
const Promise = require('bluebird');
const { LockAcquisitionError } = require('ioredis-lock');

class Semaphore {
  constructor(dlock, key) {
    this.dlock = dlock;
    this.key = key;
    this.queue = new Deque();
    this.current = null;
    this.idle = true;

    this.next = this.next.bind(this);
    this.leave = this.leave.bind(this);
    this._take = this._take.bind(this);
  }

  take() {
    return Promise
      .fromCallback(this._take)
      .disposer(this.leave);
  }

  _take(next) {
    if (this.idle === false) {
      this.queue.push(next);
      return;
    }

    this.idle = false;
    this.dlock
      .push(this.key, this.next)
      .then((done) => {
        this.current = done;
        return next();
      })
      .catch(LockAcquisitionError, () => {
        this.dlock.logger.debug('failed to acquire lock');
        this._take(next);
      })
      .catch((e) => {
        this.dlock.logger.error('semaphore operational error', e);
        return Promise.bind(this, next)
          .delay(50)
          .then(this._take);
      });
  }

  next() {
    this.idle = true;

    if (this.queue.isEmpty()) {
      return;
    }

    this._take(this.queue.shift());
  }

  leave() {
    const done = this.current;
    this.current = null;
    done();
  }
}

module.exports = Semaphore;
