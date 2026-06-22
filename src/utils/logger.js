/**
 * src/utils/logger.js — Structured Application Logger
 *
 * Uses Node's built-in console for Phase 1 simplicity.
 * In Phase 2, swap the internals for Winston or Pino (zero-dependency change
 * for callers) and ship logs to a centralised aggregator (Datadog, Loki, etc.).
 *
 * Log levels: error > warn > info > http > debug
 *
 * Output is suppressed below the configured level so test runs stay clean.
 */

'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, http: 3, debug: 4 };

const ENV_LEVEL_MAP = {
  production: 'warn',
  test: 'error',
  development: 'debug',
};

const currentLevel = LEVELS[ENV_LEVEL_MAP[process.env.NODE_ENV] || 'debug'];

/**
 * Prefix each log line with an ISO timestamp and the level label.
 * Example: [2024-05-01T10:23:45.123Z] INFO  MongoDB connected: localhost
 */
function log(level, ...args) {
  if (LEVELS[level] > currentLevel) return;

  const timestamp = new Date().toISOString();
  const label = level.toUpperCase().padEnd(5);
  const prefix = `[${timestamp}] ${label}`;

  if (level === 'error') {
    console.error(prefix, ...args);
  } else if (level === 'warn') {
    console.warn(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}

const logger = {
  error: (...args) => log('error', ...args),
  warn: (...args) => log('warn', ...args),
  info: (...args) => log('info', ...args),
  http: (...args) => log('http', ...args),
  debug: (...args) => log('debug', ...args),
};

export default logger;
