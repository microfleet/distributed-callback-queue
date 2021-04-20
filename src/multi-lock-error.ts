import Bluebird = require('bluebird')
import type { Lock } from '@microfleet/ioredis-lock'

// aggregate error
export class MultiLockError extends Bluebird.AggregateError {
  public locks: Lock[]

  constructor(errors: Error[], locks: Lock[]) {
    super()
    this.name = 'MultiLockError'
    this.locks = locks
    this.push(...errors)
  }
}
