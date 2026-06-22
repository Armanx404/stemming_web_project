/**
 * src/config/cloudfront.config.js — CloudFront URL Builder
 *
 * This is the SINGLE place in the codebase that generates video delivery URLs.
 * Replacing local disk URLs (Phase 1) → CloudFront signed URLs (Phase 2)
 * is a one-file change — zero controller or route modifications needed.
 *
 * Two URL modes:
 *   1. Public URL  — for non-sensitive assets (thumbnails, public videos)
 *   2. Signed URL  — for private/paid content with time-limited access
 *      Uses CloudFront key pairs (RSA-SHA1), NOT IAM credentials.
 *
 * Setup checklist:
 *   1. Create a CloudFront key pair in AWS console (Security Credentials).
 *   2. Download the private key → save to ./certs/cloudfront-private-key.pem
 *      (add certs/ to .gitignore — NEVER commit private keys)
 *   3. Set CLOUDFRONT_KEY_PAIR_ID and CLOUDFRONT_PRIVATE_KEY_PATH in .env
 *   4. Associate the key pair with your CloudFront distribution.
 */

'use strict';

import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN || '';
const TTL_SECONDS = parseInt(process.env.CLOUDFRONT_URL_TTL_SECONDS, 10) || 14400; // 4 hours

// Load the private key once at startup (not per-request)
let cloudfrontPrivateKey = null;

function getPrivateKey() {
  if (cloudfrontPrivateKey) return cloudfrontPrivateKey;

  const keyPath = process.env.CLOUDFRONT_PRIVATE_KEY_PATH;
  if (!keyPath) {
    logger.warn('CLOUDFRONT_PRIVATE_KEY_PATH not set — signed URLs disabled.');
    return null;
  }

  try {
    cloudfrontPrivateKey = fs.readFileSync(path.resolve(keyPath), 'utf8');
    return cloudfrontPrivateKey;
  } catch (err) {
    logger.error(`Could not load CloudFront private key: ${err.message}`);
    return null;
  }
}

// ─── URL Builders ─────────────────────────────────────────────────────────────

/**
 * buildPublicUrl — Returns a plain CloudFront URL (no signature).
 * Use for thumbnails or any content where signed URLs are not required.
 *
 * @param {string} s3Key — S3 object key (e.g. 'thumbnails/abc123.jpg')
 * @returns {string}
 */
function buildPublicUrl(s3Key) {
  if (!CLOUDFRONT_DOMAIN || !s3Key) return null;
  return `${CLOUDFRONT_DOMAIN}/${s3Key}`;
}

/**
 * buildSignedUrl — Returns a time-limited CloudFront signed URL.
 * Use for private video content and HLS playlists.
 *
 * Falls back to buildPublicUrl if signing credentials are not configured
 * (allows development without AWS certs).
 *
 * @param {string} s3Key  — S3 object key
 * @param {number} ttl    — URL lifetime in seconds (default: CLOUDFRONT_URL_TTL_SECONDS)
 * @returns {string}
 */
function buildSignedUrl(s3Key, ttl = TTL_SECONDS) {
  if (!CLOUDFRONT_DOMAIN || !s3Key) return null;

  const privateKey = getPrivateKey();
  const keyPairId = process.env.CLOUDFRONT_KEY_PAIR_ID;

  // Degrade gracefully in development — return unsigned URL
  if (!privateKey || !keyPairId) {
    return buildPublicUrl(s3Key);
  }

  const url = `${CLOUDFRONT_DOMAIN}/${s3Key}`;
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;

  return getSignedUrl({
    url,
    keyPairId,
    dateLessThan: new Date(expiresAt * 1000).toISOString(),
    privateKey,
  });
}

/**
 * buildHlsSignedUrl — Convenience wrapper for HLS master playlist URLs.
 *
 * @param {string} videoId — MongoDB ObjectId string
 */
function buildHlsSignedUrl(videoId) {
  return buildSignedUrl(`videos/hls/${videoId}/master.m3u8`);
}

/**
 * buildThumbnailUrl — Thumbnails are public (no signed URL needed).
 *
 * @param {string} videoId — MongoDB ObjectId string
 */
function buildThumbnailUrl(videoId) {
  return buildPublicUrl(`thumbnails/${videoId}.jpg`);
}

export {
buildPublicUrl,
  buildSignedUrl,
  buildHlsSignedUrl,
  buildThumbnailUrl,
};
