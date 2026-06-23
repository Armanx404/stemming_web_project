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
import {
  login,
  logout,
  me,
  refresh,
  register,
} from '../controllers/auth.controller.js';

const router = Router();

router.post('/register', asyncHandler(register));
router.post('/login',    asyncHandler(login));
router.post('/refresh',  asyncHandler(refresh));
router.post('/logout',   protect, asyncHandler(logout));
router.get('/me',        protect, asyncHandler(me));

export default router;
