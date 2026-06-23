/**
 * src/middleware/cache.middleware.js — Redis Response Cache
 *
 * A generic route-level caching middleware.
 *
 * Usage:
 *   router.get('/', cache('videos-list', 300), asyncHandler(controller.getAllVideos))
 *
 * Cache key strategy:
 *   Includes the full query string so ?page=2&limit=10 is cached separately
 *   from ?page=1&limit=20.
 *
 * Cache invalidation:
 *   Call invalidateCache(pattern) from the service layer after mutations
 *   (upload, delete). Uses Redis SCAN to find and delete matching keys
 *   without blocking the server (SCAN vs KEYS).
 *
 * Failure mode:
 *   If Redis is unavailable, the middleware silently falls through to the
 *   controller. The API stays functional — just uncached.
 */

'use strict';

import { connectRedisClient, getRedisClient } from '../config/redis.config.js';
import logger from '../utils/logger.js';

const DEFAULT_TTL = parseInt(process.env.REDIS_CACHE_TTL_SECONDS, 10) || 300;

/**
 * cache — Express middleware factory.
 *
 * @param {string} namespace  — Key prefix (e.g. 'videos-list')
 * @param {number} ttl        — Cache duration in seconds (default: REDIS_CACHE_TTL_SECONDS)
 */
function cache(namespace, ttl = DEFAULT_TTL) {
  return async (req, res, next) => {
    const redis = getRedisClient();

    // Build a deterministic cache key from namespace + sorted query params
    const sortedQuery = new URLSearchParams(
      Object.entries(req.query).sort()
    ).toString();
    const cacheKey = `cache:${namespace}:${sortedQuery}`;

    try {
      await connectRedisClient(redis);
      const cached = await redis.get(cacheKey);
      if (cached) {
        logger.debug(`Cache HIT: ${cacheKey}`);
        // Add a header so callers can see whether the response was cached
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).json(JSON.parse(cached));
      }

      logger.debug(`Cache MISS: ${cacheKey}`);
      res.setHeader('X-Cache', 'MISS');

      // Intercept res.json to cache the response before sending
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        // Only cache successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          redis.set(cacheKey, JSON.stringify(body), 'EX', ttl).catch((err) => {
            logger.warn(`Cache write failed for ${cacheKey}: ${err.message}`);
          });
        }
        return originalJson(body);
      };

      next();
    } catch (err) {
      // Redis down — degrade gracefully
      logger.warn(`Cache middleware error, bypassing: ${err.message}`);
      next();
    }
  };
}

/**
 * invalidateCache — Delete all keys matching a namespace prefix.
 *
 * Uses SCAN (not KEYS) to avoid blocking Redis on large keysets.
 * Call this after any mutation that affects cached list endpoints.
 *
 * @param {string} namespace  — Must match the namespace used in cache()
 */
async function invalidateCache(namespace) {
  const redis = getRedisClient();
  const pattern = `cache:${namespace}:*`;
  let cursor = '0';
  let deleted = 0;

  try {
    await connectRedisClient(redis);
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;

      if (keys.length > 0) {
        await redis.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');

    if (deleted > 0) {
      logger.debug(`Cache invalidated: ${deleted} key(s) matching "${pattern}"`);
    }
  } catch (err) {
    logger.warn(`Cache invalidation failed for "${pattern}": ${err.message}`);
    // Non-fatal — stale cache is better than a crashed server
  }
}

export {
cache, invalidateCache
};
