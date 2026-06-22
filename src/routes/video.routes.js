/**
 * src/routes/video.routes.js — Phase 2 Update
 *
 * Changes from Phase 1:
 *   - POST /upload    → requires authentication (protect)
 *   - DELETE /:id     → requires authentication + ownership (protect + requireOwner)
 *   - GET routes      → remain public (no auth required)
 *   - GET /           → now wrapped with Redis cache middleware
 *
 * No controller or handler code changed.
 */

'use strict';

import { Router } from 'express';
import { uploadFields } from '../middleware/upload.middleware.js';
import { asyncHandler } from '../middleware/asyncHandler.middleware.js';
import { protect, requireOwner } from '../middleware/auth.middleware.js';
import { cache } from '../middleware/cache.middleware.js';
import VideoModel from '../models/video.model.js';
import videoController from '../controllers/video.controller.js';

const router = Router();

// POST /api/videos/upload — Auth required
router.post(
  '/upload',
  protect,
  uploadFields,
  asyncHandler(videoController.uploadVideo)
);

// GET /api/videos — Public, Redis cached
router.get(
  '/',
  cache('videos-list', 300),   // 5-minute cache
  asyncHandler(videoController.getAllVideos)
);

// GET /api/videos/:id — Public
router.get('/:id', asyncHandler(videoController.getVideoById));

// DELETE /api/videos/:id — Auth + Ownership required
router.delete(
  '/:id',
  protect,
  requireOwner(VideoModel, 'uploadedBy'),
  asyncHandler(videoController.deleteVideo)
);

export default router;
