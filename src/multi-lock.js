const Promise = require('bluebird');
const assert = require('assert');

// aggregate error
class MultiLockError extends Promise.AggregateError {
  constructor(errors, locks) {
    super(errors);
    this.name = 'MultiLockError';
    this.locks = locks;
  }
}

class MultiLock {
  constructor(locks) {
    this.vault = locks;
  }

  static batchAction(locks) {
    const accumulator = {
      vault: [],
      failed: [],
    };

    locks.forEach(lock => {
      if (lock.isRejected()) {
        accumulator.failed.push(lock.reason());
      } else {
        accumulator.vault.push(lock.value());
      }
    });

    // throw aggregate error if we have failed
    if (accumulator.failed.length > 0) {
      throw new MultiLockError(accumulator.failed, accumulator.vault);
    }

    return accumulator.vault;
  }

  static cleanup(_locks) {
    // allow MultiLockError and raw array
    const isError = _locks instanceof MultiLockError;
    const locks = isError ? _locks.locks : _locks;

    return Promise
      .map(locks, lock => lock.release().reflect())
      .tap(() => {
        if (!isError) {
          return null;
        }

        throw _locks;
      });
  }

  // if extend fails we cleanup remaining locks
  extend(time) {
    assert(time > 0, '`time` must be greater than 0');

    return Promise
      .map(this.vault, lock => lock.extend(time).reflect())
      .then(MultiLock.batchAction)
      .catch(MultiLockError, MultiLock.cleanup);
  }

  release() {
    return MultiLock.cleanup(this.vault);
  }
}

exports.MultiLock = MultiLock;
exports.MultiLockError = MultiLockError;
