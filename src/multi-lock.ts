import assert from 'node:assert/strict'
import { Lock } from '@microfleet/ioredis-lock'
import { MultiLockError } from './multi-lock-error.js'

export { MultiLockError }
export class MultiLock {
  public readonly vault: Lock[]

  constructor(locks: Lock[]) {
    this.vault = locks
  }

  static batchAction(inspections: PromiseSettledResult<Lock>[]): Lock[] {
    const accumulator = {
      vault: [] as Lock[],
      failed: [] as Error[],
    }

    for (const lock of inspections.values()) {
      if (lock.status === 'rejected') {
        accumulator.failed.push(lock.reason)
      } else {
        accumulator.vault.push(lock.value)
      }
    }

    // throw aggregate error if we have failed
    if (accumulator.failed.length > 0) {
      throw new MultiLockError(accumulator.failed, accumulator.vault)
    }

    return accumulator.vault
  }

  static async cleanup(_locks: MultiLockError): Promise<never>
  static async cleanup(_locks: Lock[]): Promise<PromiseSettledResult<Lock>[]>
  static async cleanup(_locks: MultiLockError | Lock[]): Promise<never | PromiseSettledResult<Lock>[]> {
    // allow MultiLockError and raw array
    let locks: Lock[]
    if (_locks instanceof MultiLockError) {
      locks = _locks.locks
    } else {
      locks = _locks
    }

    const reflection = await Promise.allSettled(locks.map((lock) => {
      return lock.release()
    }))

    if (_locks instanceof MultiLockError) {
      throw _locks
    }

    return reflection
  }

  // if extend fails we cleanup remaining locks
  async extend(time = 10000): Promise<Lock[]> {
    assert(time > 0, '`time` must be greater than 0')

    try {
      const results = await Promise.allSettled(this.vault.map((lock) => lock.extend(time)))
      return MultiLock.batchAction(results)
    } catch (err) {
      if (err instanceof MultiLockError) {
        return MultiLock.cleanup(err)
      }

      throw err
    }
  }

  async release(): Promise<PromiseSettledResult<Lock>[]> {
    return MultiLock.cleanup(this.vault)
  }
}
