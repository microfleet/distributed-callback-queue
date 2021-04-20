import Deque = require('denque')
import Bluebird = require('bluebird')
import { LockAcquisitionError } from '@microfleet/ioredis-lock'
import type { DistributedCallbackQueue } from './distributed-callback-queue'

export type Resolver<T = any> = (err?: any, result?: T) => void

export class Semaphore {
  private queue = new Deque<Resolver>()
  private current: Resolver | null = null
  private idle = true

  constructor(private dlock: DistributedCallbackQueue, public key: string) {
    this.dlock = dlock
    this.key = key

    this.next = this.next.bind(this)
    this.leave = this.leave.bind(this)
    this._take = this._take.bind(this)
  }

  public take<T>(disposer: false): Bluebird<T>
  public take<T>(disposer: true): Bluebird.Disposer<T>
  public take<T>(disposer = true): Bluebird<T> | Bluebird.Disposer<T> {
    const promise = Bluebird.fromCallback<T>(this._take)

    // with disposer by default
    if (disposer === true) {
      return promise.disposer(this.leave)
    }

    return promise
  }

  private async _take<T>(next: Resolver<T>) {
    if (this.idle === false) {
      this.queue.push(next)
      return
    }

    this.idle = false

    try {
      const done = await this.dlock.push(this.key, this.next)
      this.current = done
      return next()
    } catch (err) {
      if (err instanceof LockAcquisitionError) {
        this.dlock.logger.debug({ err }, 'failed to acquire lock')
        this._take(next)
      } else {
        this.dlock.logger.error({ err }, 'semaphore operational error')
        await Bluebird.delay(50)
        await this._take(next)
        return this.next()
      }
    }
  }

  public async next(): Promise<void> {
    this.idle = true

    if (this.queue.isEmpty()) {
      return
    }

    // we've verified this with .isEmpty()
    return this._take(this.queue.shift() as Resolver)
  }

  public leave(): void {
    const done = this.current
    this.current = null
    if (done) done()
  }
}
