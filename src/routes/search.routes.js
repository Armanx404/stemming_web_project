import express from 'express';
const router = express.Router();

import { searchVideos } from '../controllers/search.controller.js';

// GET /api/search?q=movie
router.get("/", searchVideos);

export default router;