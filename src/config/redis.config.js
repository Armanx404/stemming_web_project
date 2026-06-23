'use strict';

import Redis from 'ioredis';
import logger from '../utils/logger.js';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const shouldUseTls = () =>
  REDIS_URL.startsWith('rediss://') || process.env.REDIS_TLS === 'true';

const retryStrategy = (times) => {
  if (times > 10) {
    logger.error('Redis: exceeded max reconnection attempts.');
    return null;
  }

  return Math.min(times * 100, 3000);
};

function buildRedisOptions({
  connectionName = 'api-redis',
  lazyConnect = true,
  maxRetriesPerRequest = 3,
} = {}) {
  const options = {
    connectionName,
    lazyConnect,
    connectTimeout: 5000,
    commandTimeout: 3000,
    enableReadyCheck: false,
    maxRetriesPerRequest,
    retryStrategy,
  };

  if (shouldUseTls()) {
    options.tls = {};
  }

  return options;
}

function attachRedisLogging(redis, label) {
  if (redis.__appLoggingAttached) return redis;

  redis.__appLoggingAttached = true;
  redis.on('connect', () => logger.info(`${label}: connected`));
  redis.on('ready', () => logger.info(`${label}: ready`));
  redis.on('error', (err) => logger.error(`${label}: ${err.message}`));
  redis.on('close', () => logger.warn(`${label}: connection closed`));
  redis.on('reconnecting', () => logger.info(`${label}: reconnecting`));

  return redis;
}

let sharedClient = null;

function getRedisClient() {
  if (!sharedClient) {
    sharedClient = attachRedisLogging(
      new Redis(REDIS_URL, buildRedisOptions({ connectionName: 'api-shared' })),
      'Redis'
    );
  }

  return sharedClient;
}

function createRedisConnection(options = {}) {
  const connectionName = options.connectionName || 'redis-connection';
  return attachRedisLogging(
    new Redis(REDIS_URL, buildRedisOptions({ ...options, connectionName })),
    `Redis:${connectionName}`
  );
}

function createBullMQConnection(connectionName = 'bullmq') {
  return createRedisConnection({
    connectionName,
    lazyConnect: false,
    maxRetriesPerRequest: null,
  });
}

function createRedisRateLimitStore({ prefix = 'rl:' } = {}) {
  const redis = getRedisClient();
  let windowMs = 15 * 60 * 1000;

  const buildKey = (key) => `${prefix}${key}`;

  return {
    prefix,

    init(options) {
      windowMs = options.windowMs;
    },

    async increment(key) {
      await connectRedisClient(redis);

      const redisKey = buildKey(key);
      const totalHits = await redis.incr(redisKey);
      let timeToExpire = await redis.pttl(redisKey);

      if (timeToExpire < 0) {
        await redis.pexpire(redisKey, windowMs);
        timeToExpire = windowMs;
      }

      return {
        totalHits,
        resetTime: new Date(Date.now() + timeToExpire),
      };
    },

    async decrement(key) {
      await connectRedisClient(redis);
      await redis.decr(buildKey(key));
    },

    async resetKey(key) {
      await connectRedisClient(redis);
      await redis.del(buildKey(key));
    },
  };
}

async function connectRedisClient(redis = getRedisClient()) {
  if (redis.status === 'ready') return redis;
  if (redis.status === 'wait') {
    await redis.connect();
    return redis;
  }

  if (redis.status === 'connecting' || redis.status === 'connect') {
    await new Promise((resolve, reject) => {
      redis.once('ready', resolve);
      redis.once('error', reject);
    });
  }

  return redis;
}

export {
  connectRedisClient,
  createBullMQConnection,
  createRedisRateLimitStore,
  createRedisConnection,
  getRedisClient,
};
