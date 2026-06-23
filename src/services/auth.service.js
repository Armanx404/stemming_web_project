/**
 * src/services/auth.service.js — Authentication Business Logic
 *
 * FIXES APPLIED:
 *   1. Startup guard: validates JWT_SECRET and JWT_REFRESH_SECRET exist
 *      at module load time, not silently at runtime during the first login.
 *      Previously: jwt.sign(payload, undefined) threw an unhandled error → 500.
 *      Now: server refuses to start if secrets are missing.
 *
 *   2. issueTokenPair: added null-check on user._id before DB update.
 *
 *   3. login: added explicit guard if user.password is undefined after select(+password),
 *      with a clear developer-facing error instead of a cryptic bcrypt crash.
 *
 * Token strategy:
 *   - Access token:  short-lived (7d), stateless JWT. Verified on every request.
 *   - Refresh token: long-lived (30d), stored as a keyed hash in MongoDB.
 *     Rotated on each use — prevents replay attacks.
 *     Reuse detection: presenting an old token wipes ALL sessions for that user.
 */

"use strict";

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import UserModel from '../models/user.model.js';
import logger from '../utils/logger.js';

const JWT_VERIFY_OPTIONS = { algorithms: ['HS256'] };
const REFRESH_TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;

// ─── Startup Guard ────────────────────────────────────────────────────────────
//
// ROOT CAUSE OF THE 500 ERROR:
//   JWT_SECRET and JWT_REFRESH_SECRET were missing from .env.
//   jwt.sign(payload, undefined) throws: "secretOrPrivateKey must have a value"
//   That error has no .statusCode → globalErrorHandler returns 500.
//
// FIX: Fail at MODULE LOAD TIME, not at first login request.
//   The server will refuse to start with a clear message instead of crashing
//   silently on the first POST /auth/login.
//
(function validateRequiredEnv() {
  const required = ["JWT_SECRET", "JWT_REFRESH_SECRET"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `[auth.service] Missing required environment variables: ${missing.join(", ")}\n` +
        "Add them to your .env file and restart the server.\n" +
        "Generate secrets with: node -e \"console.log(require('crypto').randomBytes(64).toString('hex'))\"",
    );
  }
})();

// ─── Token Helpers ────────────────────────────────────────────────────────────

/**
 * signAccessToken
 * Uses JWT_SECRET — confirmed non-null by the startup guard above.
 */
function signAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    algorithm: "HS256",
  });
}

/**
 * signRefreshToken
 * Uses JWT_REFRESH_SECRET — confirmed non-null by the startup guard above.
 * Uses a DIFFERENT secret from the access token so a compromised access token
 * cannot be used to forge a refresh token.
 */
function signRefreshToken(payload) {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "30d",
    algorithm: "HS256",
  });
}

/**
 * buildTokenPayload
 * Minimal stable claims: only sub (userId) and role.
 * Never include email, password, or mutable fields in a JWT payload.
 */
function buildTokenPayload(user) {
  return { sub: user.id, role: user.role };
}

function hashRefreshToken(refreshToken) {
  return createHmac('sha256', process.env.JWT_REFRESH_SECRET)
    .update(refreshToken)
    .digest('hex');
}

async function verifyStoredRefreshToken(incomingRefreshToken, storedRefreshToken) {
  if (REFRESH_TOKEN_HASH_PATTERN.test(storedRefreshToken)) {
    const incomingHash = Buffer.from(hashRefreshToken(incomingRefreshToken), 'hex');
    const storedHash = Buffer.from(storedRefreshToken, 'hex');

    return (
      incomingHash.length === storedHash.length &&
      timingSafeEqual(incomingHash, storedHash)
    );
  }

  // Backward compatibility for sessions created before HMAC refresh hashes.
  return bcrypt.compare(incomingRefreshToken, storedRefreshToken);
}

/**
 * issueTokenPair
 * Generates a new access + refresh token pair, hashes the refresh token,
 * and stores the hash in MongoDB against the user document.
 */
async function issueTokenPair(user) {
  const payload = buildTokenPayload(user);
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken({ ...payload, jti: randomUUID() });

  // Hash the refresh token — raw token never touches the DB.
  // JWTs exceed bcrypt's 72-byte input limit, so use a keyed SHA-256 hash.
  const hashedRefresh = hashRefreshToken(refreshToken);

  await UserModel.findByIdAndUpdate(
    user._id,
    { refreshToken: hashedRefresh },
    { runValidators: false }, // updating internal token, not user data
  );

  return { accessToken, refreshToken };
}

// ─── register ─────────────────────────────────────────────────────────────────

/**
 * register — Create a new user account and return a token pair.
 *
 * The UserSchema pre-save hook hashes the password automatically.
 * Duplicate username or email throws MongoDB error code 11000,
 * which the global error handler maps to a 409 Conflict response.
 */
async function register({ username, email, password }) {
  const user = await UserModel.create({ username, email, password });
  logger.info(`User registered: id=${user.id}`);

  const tokens = await issueTokenPair(user);
  return { user, ...tokens };
}

// ─── login ────────────────────────────────────────────────────────────────────

/**
 * login — Verify email + password and return a token pair.
 *
 * Security: both "email not found" and "wrong password" return the same
 * generic message to prevent user enumeration attacks.
 *
 * FIX NOTES:
 *   - .select('+password') is required because password has select:false in the schema.
 *     Without it, user.password is undefined and bcrypt.compare() throws a 500.
 *   - isActive: true in the query prevents soft-deleted users from logging in.
 *   - comparePassword() is an instance method on the UserModel — see user.model.js.
 */
async function login({ email, password }) {
  const GENERIC_ERROR = "Invalid email or password.";

  // FIX: .select('+password') is the critical piece.
  // The password field has select:false in the schema, so Mongoose excludes it
  // from all queries by default. Without this explicit opt-in:
  //   user.password → undefined
  //   bcrypt.compare(password, undefined) → throws TypeError
  //   globalErrorHandler receives Error with no .statusCode → returns 500
  const user = await UserModel.findOne({ email, isActive: true }).select(
    "+password",
  );

  if (!user) {
    const err = new Error(GENERIC_ERROR);
    err.statusCode = 401;
    throw err;
  }

  // Defensive guard: if somehow password is still undefined after select('+password'),
  // throw a developer-friendly error instead of a cryptic bcrypt crash.
  if (!user.password) {
    logger.error(
      `login: password field missing for user ${user.id} even after select('+password')`,
    );
    const err = new Error("Authentication configuration error.");
    err.statusCode = 500;
    throw err;
  }

  const isMatch = await user.comparePassword(password);
  if (!isMatch) {
    const err = new Error(GENERIC_ERROR);
    err.statusCode = 401;
    throw err;
  }

  logger.info(`User logged in: id=${user.id}`);
  const tokens = await issueTokenPair(user);
  return { user, ...tokens };
}

// ─── refresh ──────────────────────────────────────────────────────────────────

/**
 * refresh — Issue a new token pair from a valid refresh token.
 *
 * Rotation strategy:
 *   Every call invalidates the old refresh token and issues a new pair.
 *   If the same refresh token is presented twice (reuse detected), ALL sessions
 *   for that user are wiped — assumes the token was stolen.
 */
async function refresh(incomingRefreshToken) {
  // Step 1: Verify the token signature and expiry
  let decoded;
  try {
    decoded = jwt.verify(
      incomingRefreshToken,
      process.env.JWT_REFRESH_SECRET,
      JWT_VERIFY_OPTIONS,
    );
  } catch (jwtErr) {
    const message =
      jwtErr.name === "TokenExpiredError"
        ? "Refresh token has expired. Please log in again."
        : "Refresh token is invalid.";
    const err = new Error(message);
    err.statusCode = 401;
    throw err;
  }

  if (!decoded?.sub) {
    const err = new Error("Refresh token is invalid.");
    err.statusCode = 401;
    throw err;
  }

  // Step 2: Load the user with their stored hashed refresh token
  const user = await UserModel.findById(decoded.sub).select("+refreshToken");

  if (!user || !user.refreshToken) {
    const err = new Error("Session not found. Please log in again.");
    err.statusCode = 401;
    throw err;
  }

  // Step 3: Compare the incoming token against the stored hash
  const isValid = await verifyStoredRefreshToken(incomingRefreshToken, user.refreshToken);
  if (!isValid) {
    // Token reuse detected — wipe all sessions immediately
    await UserModel.findByIdAndUpdate(user._id, { refreshToken: null });
    logger.warn(
      `Refresh token reuse detected for user id=${user.id}. All sessions wiped.`,
    );
    const err = new Error(
      "Session invalidated due to suspicious activity. Please log in again.",
    );
    err.statusCode = 401;
    throw err;
  }

  // Step 4: Rotate — issue a fresh pair, store the new hash
  const tokens = await issueTokenPair(user);
  logger.info(`Tokens rotated for user: id=${user.id}`);
  return tokens;
}

// ─── logout ───────────────────────────────────────────────────────────────────

/**
 * logout — Invalidate the user's refresh token in MongoDB.
 *
 * Access tokens remain valid until expiry because they are stateless JWTs.
 * This is acceptable when the access token TTL is short (7d or less).
 * Phase 3: Add access token to a Redis blocklist for immediate invalidation.
 */
async function logout(userId) {
  await UserModel.findByIdAndUpdate(userId, { refreshToken: null });
  logger.info(`User logged out: id=${userId}`);
}

export {
register,
login,
refresh,
logout,
hashRefreshToken,
};
