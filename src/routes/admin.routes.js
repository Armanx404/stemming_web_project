'use strict';

import { Router } from 'express';
import adminAnimeRoutes from './adminAnime.routes.js';

const router = Router();

router.use('/anime', adminAnimeRoutes);

export default router;
