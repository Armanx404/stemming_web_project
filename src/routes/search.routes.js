import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.middleware.js';
import { searchVideos } from '../controllers/search.controller.js';

const router = Router();

// GET /api/search?q=movie
router.get('/', asyncHandler(searchVideos));

export default router;
