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
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../middleware/asyncHandler.middleware.js';
import { protect } from '../middleware/auth.middleware.js';
import { createRedisRateLimitStore } from '../config/redis.config.js';
import { errorResponse } from '../utils/response.js';
import {
  login,
  logout,
  me,
  refresh,
  register,
} from '../controllers/auth.controller.js';

const router = Router();

const authRateLimiter = rateLimit({
  store: createRedisRateLimitStore({ prefix: 'auth-rl:' }),
  passOnStoreError: false,
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS) || 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: errorResponse('Too many authentication attempts. Please try again later.'),
});

router.post('/register', authRateLimiter, asyncHandler(register));
router.post('/login',    authRateLimiter, asyncHandler(login));
router.post('/refresh',  authRateLimiter, asyncHandler(refresh));
router.post('/logout',   protect, asyncHandler(logout));
router.get('/me',        protect, asyncHandler(me));

export default router;
