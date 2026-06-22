import Video from '../models/video.model.js';

import redisClient from '../config/redis.js';

export const searchVideos = async (req, res) => {
  try {
    const query = req.query.q;

    if (!query) {
      return res.status(400).json({
        success: false,
        message: "Search query (q) is required",
      });
    }

    const cacheKey = `search:${query}`;

    // 🔥 1. Check Redis Cache
    if (redisClient) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        return res.json({
          success: true,
          source: "cache",
          data: JSON.parse(cached),
        });
      }
    }

    // 🔎 2. DB Search (case-insensitive)
    const videos = await Video.find({
      title: { $regex: query, $options: "i" },
    }).sort({ createdAt: -1 });

    // 🔥 3. Store in Redis (60 sec)
    if (redisClient) {
      await redisClient.setEx(cacheKey, 60, JSON.stringify(videos));
    }

    return res.json({
      success: true,
      source: "database",
      results: videos.length,
      data: videos,
    });
  } catch (error) {
    console.error("Search Error:", error);
    res.status(500).json({
      success: false,
      message: "Server Error",
    });
  }
};