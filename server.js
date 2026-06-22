/**
 * server.js — Application Entry Point (R2 Migration: env guard updated)
 *
 * CHANGE FROM PHASE 2:
 *   validateEnv required array now includes R2 storage credentials.
 *   Without R2_ACCOUNT_ID or R2_ACCESS_KEY_ID, the endpoint resolves to
 *   'https://undefined.r2.cloudflarestorage.com' — no startup crash, but
 *   every upload silently fails at the DNS level with a confusing error.
 *   Adding these to the required array surfaces the misconfiguration
 *   immediately at boot with a clear actionable message.
 *
 * All other server.js logic is unchanged.
 */

'use strict';

import dotenv from 'dotenv';
dotenv.config();

// ─── Required Environment Variable Guard ──────────────────────────────────────
(function validateEnv() {
  const required = [
    // Core infrastructure
    'MONGO_URI',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    // R2 storage — missing any of these produces silent upload failures
    'R2_ACCOUNT_ID',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'STORAGE_BUCKET_NAME',
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(
      '\n[STARTUP ERROR] Missing required environment variables:\n' +
      missing.map((k) => `  - ${k}`).join('\n') +
      '\n\nCopy .env.example to .env and fill in all required values.\n' +
      'Generate JWT secrets: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"\n' +
      'R2 credentials: Cloudflare Dashboard → R2 → Manage R2 API Tokens\n'
    );
    process.exit(1);
  }
}());

import http from 'http';
import app from './src/app.js';
import connectDB from './src/config/db.js';
import logger from './src/utils/logger.js';

const PORT     = process.env.PORT || 5000;
const NODE_ENV = process.env.NODE_ENV || 'development';

async function bootstrap() {
  await connectDB();

  const server = http.createServer(app);

  server.listen(PORT, () => {
    logger.info(`⚡  Server running in ${NODE_ENV} mode on port ${PORT}`);
    logger.info(`📡  API base: http://localhost:${PORT}${process.env.API_PREFIX || '/api'}`);
  });

  const gracefulShutdown = (signal) => {
    logger.info(`\n${signal} received. Initiating graceful shutdown…`);
    server.close(() => {
      logger.info('HTTP server closed. Exiting process.');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Graceful shutdown timed out. Forcing exit.');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Promise Rejection:', reason);
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
    process.exit(1);
  });
}

bootstrap();