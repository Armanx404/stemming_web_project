/**
 * src/services/search.service.js — Full-Text Video Search
 *
 * Phase 2 uses MongoDB's built-in $text index (already defined on the Video model).
 * This works well up to ~1M documents and requires zero new infrastructure.
 *
 * When to upgrade to Atlas Search / Elasticsearch:
 *   - Need fuzzy matching (typo-tolerant search: "Avengres" → "Avengers")
 *   - Need language-aware stemming
 *   - Need faceted search (filter by genre, duration, year simultaneously)
 *   - Query latency exceeds 100ms at scale
 *
 * Migration path:
 *   - Replace the MongoDB $text query below with an Atlas Search aggregation
 *     pipeline ($search stage) — the controller and route remain identical.
 *   - For Elasticsearch: replace with an ES client query, same shape of return value.
 *
 * The search route is GET /api/search?q=...&page=1&limit=20
 */

'use strict';

import VideoModel from '../models/video.model.js';

/**
 * searchVideos — Full-text search on title + description.
 *
 * Returns results sorted by MongoDB's textScore (relevance), then by views
 * as a secondary signal — similar to how YouTube blends relevance + engagement.
 *
 * @param {string} query      — Search term(s) from the user
 * @param {number} page
 * @param {number} limit
 * @returns {Promise<{ data, pagination, query }>}
 */
async function searchVideos({ query, page = 1, limit = 20 }) {
  if (!query || !query.trim()) {
    const err = new Error('Search query is required.');
    err.statusCode = 400;
    throw err;
  }

  const pageNum  = Math.max(1, parseInt(page,  10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip     = (pageNum - 1) * limitNum;

  const searchFilter = {
    $text: { $search: query.trim() },
    isDeleted: false,
    status: 'ready',   // Only return streamable videos in search results
  };

  // Project the textScore so we can sort by relevance
  const textScoreProjection = { score: { $meta: 'textScore' } };

  const [videos, total] = await Promise.all([
    VideoModel.find(searchFilter, textScoreProjection)
      .sort({ score: { $meta: 'textScore' }, views: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate('uploadedBy', 'username')
      .lean({ virtuals: true }),

    VideoModel.countDocuments(searchFilter),
  ]);

  return {
    query: query.trim(),
    data: videos,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum),
      hasNextPage: pageNum < Math.ceil(total / limitNum),
      hasPrevPage: pageNum > 1,
    },
  };
}

export {
searchVideos
};
