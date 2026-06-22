/**
 * src/config/redis.config.js — ioredis Connection Singleton
 *
 * Returns a single shared Redis client used by:
 *   - Cache middleware  (GET /api/videos)
 *   - Rate limiter      (rate-limit-redis)
 *   - BullMQ            (job queue transport)
 *
 * Why a singleton?
 *   Redis connections are expensive. ioredis supports multiplexing
 *   on a single connection, so sharing one client across the app is
 *   the correct pattern (unlike HTTP connections).
 *
 * Phase 3: Replace with ioredis Cluster client for ElastiCache Cluster Mode.
 */

'use strict';

import Redis from 'ioredis';
import logger from '../utils/logger.js';

let client = null;

function getRedisClient() {
  if (client) return client;

  client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    // Automatically retry on connection loss with exponential backoff
    retryStrategy: (times) => {
      if (times > 10) {
        logger.error('Redis: exceeded max reconnection attempts.');
        return null; // Stop retrying
      }
      return Math.min(times * 100, 3000); // Wait up to 3s between attempts
    },

    // Prevent commands from piling up indefinitely when Redis is unreachable.
    // After 5s, pending commands will error rather than queue forever.
    connectTimeout: 5000,
    commandTimeout: 3000,

    // Lazy connect — don't throw at import time if Redis isn't up yet.
    lazyConnect: true,

    maxRetriesPerRequest: 3,
  });

  client.on('connect', () => logger.info('✅  Redis connected'));
  client.on('ready',   () => logger.info('🟢  Redis ready'));
  client.on('error',   (err) => logger.error('Redis error:', err.message));
  client.on('close',   () => logger.warn('⚠️   Redis connection closed'));
  client.on('reconnecting', () => logger.info('🔄  Redis reconnecting…'));

  return client;
}

export {
getRedisClient
};
