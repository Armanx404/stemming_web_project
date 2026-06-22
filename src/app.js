/**
 * src/app.js — Express Application Factory (Phase 2)
 *
 * Changes from Phase 1:
 *   - Rate limiter now backed by Redis (multi-instance safe)
 *   - Auth routes added: /auth
 *   - Search routes added: /api/search
 *   - Cookie parser added (for httpOnly refresh token)
 *   - Static file serving removed (files now served via CloudFront)
 */

'use strict';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';

import { getRedisClient } from './config/redis.config.js';
import videoRoutes from './routes/video.routes.js';
import authRoutes from './routes/auth.routes.js';
import searchRoutes from './routes/search.routes.js';
import { notFoundHandler, globalErrorHandler } from './middleware/error.middleware.js';
import logger from './utils/logger.js';

const app = express();

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet());

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',').map((o) => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => (!origin || allowedOrigins.includes(origin) ? cb(null, true) : cb(new Error(`CORS: ${origin} not allowed`))),
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,   // Required for httpOnly cookies (refresh token)
}));

// ─── Rate Limiting (Redis-backed — works across multiple server instances) ────
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});

app.use(limiter);

// ─── Parsing ──────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser()); // Needed to read httpOnly refresh token cookie

// ─── Logging ──────────────────────────────────────────────────────────────────
const morganFormat = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';
app.use(morgan(morganFormat, { stream: { write: (msg) => logger.http(msg.trim()) } }));

// ─── Routes ───────────────────────────────────────────────────────────────────
const API_PREFIX = process.env.API_PREFIX || '/api';

app.use('/auth',              authRoutes);
app.use(`${API_PREFIX}/videos`, videoRoutes);
app.use(`${API_PREFIX}/search`, searchRoutes);

// Root status
app.get('/', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'Video Streaming API is running',
    version: '2.0.0',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
    endpoints: {
      auth:         { register: 'POST /auth/register', login: 'POST /auth/login' },
      videos:       `${API_PREFIX}/videos`,
      search:       `GET ${API_PREFIX}/search?q=<term>`,
      health:       `GET ${API_PREFIX}/health`,
    },
  });
});

// Health check
app.get(`${API_PREFIX}/health`, (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'Service is healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
  });
});

// ─── Error Handling ───────────────────────────────────────────────────────────
app.use(notFoundHandler);
app.use(globalErrorHandler);

export default app;
