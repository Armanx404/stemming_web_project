/**
 * src/routes/auth.routes.js
 *
 * POST  /auth/register  — create account
 * POST  /auth/login     — get tokens
 * POST  /auth/refresh   — rotate access token
 * POST  /auth/logout    — invalidate session  (requires valid access token)
 * GET   /auth/me        — get own profile     (requires valid access token)
 */

'use strict';

import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.middleware.js';
import { protect } from '../middleware/auth.middleware.js';
import authController from '../controllers/auth.controller.js';

const router = Router();

router.post('/register', asyncHandler(authController.register));
router.post('/login',    asyncHandler(authController.login));
router.post('/refresh',  asyncHandler(authController.refresh));
router.post('/logout',   protect, asyncHandler(authController.logout));
router.get('/me',        protect, asyncHandler(authController.me));

export default router;
