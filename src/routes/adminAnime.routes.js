'use strict';

import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.middleware.js';
import { protect, requireAdmin } from '../middleware/auth.middleware.js';
import {
  createAnime,
  deleteAnime,
  getAnimeById,
  listAnime,
  publishAnime,
  unpublishAnime,
  updateAnime,
} from '../controllers/adminAnime.controller.js';

const router = Router();

router.post('/', protect, requireAdmin, asyncHandler(createAnime));
router.get('/', protect, requireAdmin, asyncHandler(listAnime));
router.patch('/:animeId/publish', protect, requireAdmin, asyncHandler(publishAnime));
router.patch('/:animeId/unpublish', protect, requireAdmin, asyncHandler(unpublishAnime));
router.get('/:animeId', protect, requireAdmin, asyncHandler(getAnimeById));
router.patch('/:animeId', protect, requireAdmin, asyncHandler(updateAnime));
router.delete('/:animeId', protect, requireAdmin, asyncHandler(deleteAnime));

export default router;
