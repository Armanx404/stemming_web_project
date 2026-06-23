/**
 * src/middleware/error.middleware.js — Centralised Error Handlers
 *
 * Two handlers are exported:
 *   1. notFoundHandler  — catches requests for routes that don't exist (404)
 *   2. globalErrorHandler — catches everything next(err) passes along (4xx / 5xx)
 *
 * By centralising error handling here we guarantee:
 *   - All errors return the same JSON envelope structure
 *   - Stack traces never leak to clients in production
 *   - Errors are always logged with context
 */

'use strict';

import { StatusCodes } from 'http-status-codes';
import logger from '../utils/logger.js';
import { errorResponse } from '../utils/response.js';

function shouldRedactKey(key) {
  const normalizedKey = String(key).toLowerCase();
  return (
    normalizedKey.includes('password') ||
    normalizedKey.includes('token') ||
    normalizedKey.includes('secret') ||
    normalizedKey === 'authorization' ||
    normalizedKey === 'cookie'
  );
}

function sanitizeForLog(value, depth = 0) {
  if (depth > 5) return '[MaxDepth]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, depth + 1));
  }
  if (typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      shouldRedactKey(key) ? '[REDACTED]' : sanitizeForLog(entryValue, depth + 1),
    ])
  );
}

// ─── 404 Handler ─────────────────────────────────────────────────────────────

/**
 * notFoundHandler — Registered AFTER all valid routes.
 * If execution reaches here, no route matched the request.
 */
const notFoundHandler = (req, res) => {
  res.status(StatusCodes.NOT_FOUND).json(
    errorResponse(`Cannot ${req.method} ${req.originalUrl}`)
  );
};

// ─── Global Error Handler ─────────────────────────────────────────────────────

/**
 * globalErrorHandler — Express identifies a 4-argument function as an error handler.
 * All calls to next(err) in controllers, services, and middleware end up here.
 *
 * Error normalisation strategy:
 *   - Mongoose CastError      → 400 Bad Request
 *   - Mongoose ValidationError → 422 Unprocessable Entity
 *   - Mongoose duplicate key   → 409 Conflict
 *   - Service errors with .statusCode → use that code
 *   - Everything else          → 500 Internal Server Error
 */
// eslint-disable-next-line no-unused-vars
const globalErrorHandler = (err, req, res, _next) => {
  logger.error(`[${req.method}] ${req.originalUrl} — ${err.message}`, {
    stack: err.stack,
    body: sanitizeForLog(req.body),
  });

  // ── Mongoose: invalid ObjectId ─────────────────────────────────────────────
  if (err.name === 'CastError') {
    return res
      .status(StatusCodes.BAD_REQUEST)
      .json(errorResponse(`Invalid value for field "${err.path}": ${err.value}`));
  }

  // ── Mongoose: schema validation failure ────────────────────────────────────
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res
      .status(StatusCodes.UNPROCESSABLE_ENTITY)
      .json(errorResponse(`Validation failed: ${messages.join('. ')}`));
  }

  // ── MongoDB: duplicate key (e.g. unique index violation) ───────────────────
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res
      .status(StatusCodes.CONFLICT)
      .json(errorResponse(`Duplicate value for ${field}.`));
  }

  // ── Application errors raised by service layer ─────────────────────────────
  if (err.statusCode) {
    return res
      .status(err.statusCode)
      .json(errorResponse(err.message));
  }

  // ── Catch-all: unexpected server error ─────────────────────────────────────
  const isProduction = process.env.NODE_ENV === 'production';

  return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json(
    errorResponse(
      isProduction
        ? 'An unexpected error occurred. Please try again later.'
        : err.message,
      isProduction ? undefined : err.stack
    )
  );
};

export {
notFoundHandler,
globalErrorHandler,
sanitizeForLog,
};
