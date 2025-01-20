/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import Deque from 'denque'
import { promisify } from 'node:util'
import { LockAcquisitionError } from '@microfleet/ioredis-lock'
import type { DistributedCallbackQueue } from './distributed-callback-queue.js'
import { setTimeout } from 'node:timers/promises'

export type Resolver<T = any> = (err?: any, result?: T) => void

export interface Semaphore {
  take: <T>() => Promise<T>
}

export class Semaphore {
  private queue = new Deque<Resolver>()
  private current: Resolver | null = null
  private idle = true

  constructor(private dlock: DistributedCallbackQueue, public key: string) {
    this.dlock = dlock
    this.key = key

    // this.next = this.next.bind(this)
    // this.leave = this.leave.bind(this)
    // this._take = this._take.bind(this)
    // this.take = promisify<any>(this._take)
  }

  _take<T>(resolver: Resolver<T>) {
    if (this.idle === false) {
      this.queue.push(resolver)
      return
    }

    this.idle = false
    this.dlock
      .push(this.key, () => this.next())
      .then((done) => {
        this.current = done
        return resolver()
      })
      .catch(async (err) => {
        if (err instanceof LockAcquisitionError) {
          this.dlock.logger.debug({ err }, 'failed to acquire lock')
          this._take(resolver)
        } else {
          this.dlock.logger.error({ err }, 'semaphore operational error')
          await setTimeout(50)
          this._take(resolver)
          this.next()
        }
      })
  }

  public async next(): Promise<void> {
    this.idle = true

    if (this.queue.isEmpty()) {
      return
    }

    // we've verified this with .isEmpty()
    return this._take(this.queue.shift() as Resolver)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public leave(..._args: any[]): void {
    const done = this.current
    this.current = null
    if (done) done()
  }
}

Semaphore.prototype.take = promisify<any>(Semaphore.prototype._take)
