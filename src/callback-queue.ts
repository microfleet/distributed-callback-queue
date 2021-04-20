import P from 'pino'
import { delay } from 'bluebird'
import * as callbackQueue from '@microfleet/callback-queue'
import { serializeError, deserializeError } from 'serialize-error'
import Redis = require('ioredis')

// callback buckets
const queue = new Map<string, callbackQueue.Thunk>()
const { isArray } = Array

export type RedisInstance = Redis.Redis | Redis.Cluster
export type Publisher = (key: string, err?: Error | null, ...args: any[]) => Promise<void>
export type Consumer = (channel: string, message: string) => void

/**
 * Call functions stored in local queues
 * @param queueName
 * @param args
 * @param logger
 */
function call(queueName: string, args: any[], logger: P.Logger): void {
  const callback = queue.get(queueName)
  if (!callback) {
    throw new Error('callback called multiple times')
  }

  // these are async anyways - gonna schedule them
  logger.debug({ queueName, args }, 'Calling callback')
  callback(...args)

  // clean local queue
  queue.delete(queueName)
}

/**
 * Add callback into local queue
 * @param {String} key - queue key
 * @param {Function} callback - function to add
 */
export function add(key: string, callback: callbackQueue.Thunk): boolean {
  const aggregator = callbackQueue.add(key, callback)
  if (!aggregator) {
    return false
  }

  queue.set(key, aggregator)
  return true
}

/**
 * Creates publish function that is used later on to process callbacks
 * @param {Object} redis
 */
export function createPublisher(redis: RedisInstance, pubsubChannel: string, logger: P.Logger): Publisher {
  return async function publishResult(lockRedisKey: string, err?: Error | null, ...args: any[]): Promise<void> {
    const broadcastArgs = [err ? serializeError(err) : null, ...args]
    const localArgs = [err, ...args];

    // post result to other processes
    (async () => {
      try {
        await redis.publish(pubsubChannel, JSON.stringify([lockRedisKey, broadcastArgs]))
      } catch (err) {
        logger.warn({ err }, 'failed to publish results')
      }
    })()

    // call local queue for faster processing
    // we don't care here if it fails, it could've been already processed
    try {
      call(lockRedisKey, localArgs, logger)
    } catch (err) {
      logger.warn({ err, lockRedisKey }, 'failed to perform call')
    }
  }
}

/**
 * Helper function to parse possible JSON from the Buffer
 */
function tryParsing(message: string, logger: P.Logger) {
  try {
    return JSON.parse(message)
  } catch (err) {
    logger.warn({ originalMessage: message, err }, 'Cant parse message')
    return null
  }
}

/**
 * Creates publish function that is used later on to process callbacks
 * @param {Object} redis
 */
export function createConsumer(redis: RedisInstance, pubsubChannel: string, logger: P.Logger): Consumer {
  const connect = async (): Promise<void> => {
    try {
      await redis.subscribe(pubsubChannel)
      logger.info({ pubsubChannel }, 'Subscribed to channel')
    } catch (err) {
      logger.error({ err }, 'Failed to subsctibe to pubsub channel')
      await delay(250)
      return connect()
    }
  }

  // init connection
  connect()

  return async function redisEventListener(channel, _message) {
    if (channel.toString() !== pubsubChannel) {
      return
    }

    const message = tryParsing(_message, logger)
    if (!isArray(message)) {
      return
    }

    const [key, args] = message
    if (!key || !isArray(args)) {
      logger.warn({ redisMsg: message }, 'Malformed message passed: no key or args')
      return
    }

    // no listeners here
    // eat the error
    try {
      if (args[0]) {
        args[0] = deserializeError(args[0])
      }

      call(key, args, logger)
    } catch (err) {
      logger.warn({ err }, 'call failed')
    }
  }
}

// //////////////////////////////////////////////////////////////////////////////
// Private section
// //////////////////////////////////////////////////////////////////////////////

/**
 * Reference to original call function,
 * used for testing
 */
export const _call = call
