const Promise = require('bluebird')
const assert = require('assert')
import { MultiLockError } from './multi-lock-error'

class MultiLock {
  constructor(locks) {
    this.vault = locks
  }

  static batchAction(locks) {
    const accumulator = {
      vault: [],
      failed: [],
    }

    for (const lock of locks.values()) {
      if (lock.isRejected()) {
        accumulator.failed.push(lock.reason())
      } else {
        accumulator.vault.push(lock.value())
      }
    }

    // throw aggregate error if we have failed
    if (accumulator.failed.length > 0) {
      throw new MultiLockError(accumulator.failed, accumulator.vault)
    }

    return accumulator.vault
  }

  static cleanup(_locks) {
    // allow MultiLockError and raw array
    const isError = _locks instanceof MultiLockError
    const locks = isError ? _locks.locks : _locks

    return Promise
      .map(locks, (lock) => Promise.resolve(lock.release()).reflect())
      .tap(() => {
        if (!isError) {
          return null
        }

        throw _locks
      })
  }

  // if extend fails we cleanup remaining locks
  extend(time = 10000) {
    assert(time > 0, '`time` must be greater than 0')

    return Promise
      .map(this.vault, (lock) => Promise.resolve(lock.extend(time)).reflect())
      .then(MultiLock.batchAction)
      .catch(MultiLockError, MultiLock.cleanup)
  }

  release() {
    return MultiLock.cleanup(this.vault)
  }
}

exports.MultiLock = MultiLock
exports.MultiLockError = MultiLockError
