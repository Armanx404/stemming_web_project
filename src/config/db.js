/**
 * src/config/db.js — MongoDB Connection Manager
 *
 * Uses Mongoose to manage the connection lifecycle.
 * Centralises all connection logic so the rest of the app
 * never has to think about reconnection, pooling, or event wiring.
 */

'use strict';

import mongoose from 'mongoose';
import logger from '../utils/logger.js';

/**
 * Mongoose connection options.
 *
 * - maxPoolSize: How many simultaneous connections the driver maintains.
 *   Netflix-scale services tune this per service tier; 10 is a safe default.
 * - serverSelectionTimeoutMS: How long to wait for a usable server before throwing.
 * - socketTimeoutMS: How long to wait for a response on an open socket.
 * - family: Force IPv4 to avoid DNS resolution issues in some environments.
 */
const MONGOOSE_OPTIONS = {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5_000,
  socketTimeoutMS: 45_000,
  family: 4,
};

/**
 * connectDB — Establish and maintain a Mongoose connection.
 *
 * Called once at startup. Mongoose handles automatic reconnection internally
 * after the initial connection is established.
 *
 * @returns {Promise<void>}
 */
async function connectDB() {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    logger.error('MONGO_URI is not defined in environment variables. Aborting.');
    process.exit(1);
  }

  try {
    const conn = await mongoose.connect(uri, MONGOOSE_OPTIONS);

    logger.info(`✅  MongoDB connected: ${conn.connection.host}`);

    // ─── Connection Event Hooks ─────────────────────────────────────────────
    // These fire after initial connection — useful for observability dashboards.

    mongoose.connection.on('disconnected', () =>
      logger.warn('⚠️   MongoDB disconnected. Mongoose will attempt to reconnect automatically.')
    );

    mongoose.connection.on('reconnected', () =>
      logger.info('🔄  MongoDB reconnected.')
    );

    mongoose.connection.on('error', (err) =>
      logger.error('MongoDB connection error:', err)
    );

  } catch (err) {
    logger.error(`Failed to connect to MongoDB: ${err.message}`);
    // Exit immediately — the service cannot function without a database.
    process.exit(1);
  }
}

export default connectDB;
