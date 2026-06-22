/**
 * src/config/cdn.config.js — R2 URL Builder (replaces cloudfront.config.js)
 *
 * WHY THIS FILE CHANGED (was: cloudfront.config.js):
 *   CloudFront URL signing uses RSA private key pairs via @aws-sdk/cloudfront-signer,
 *   a package that is entirely specific to AWS CloudFront distributions.
 *   R2 has no equivalent CloudFront-style signer. Instead, R2 exposes standard
 *   S3 presigned URLs via @aws-sdk/s3-request-presigner (already in package.json)
 *   using the same storageClient initialized in storage.config.js.
 *
 *   Signed URL semantics are preserved:
 *     - TTL-based expiry (R2_SIGNED_URL_TTL_SECONDS, default 4 hours)
 *     - Graceful fallback to public URL if credentials are absent (dev mode)
 *     - Same exported function names so callers need no logic changes
 *
 *   BREAKING INTERNAL CHANGE — ASYNC SIGNATURE:
 *   getSignedUrl from @aws-sdk/cloudfront-signer is SYNCHRONOUS.
 *   getSignedUrl from @aws-sdk/s3-request-presigner is ASYNC (returns a Promise).
 *   Therefore buildSignedUrl and buildHlsSignedUrl are now async functions.
 *   All callers in video.service.js and video.worker.js must await them.
 *   buildPublicUrl and buildThumbnailUrl remain synchronous (string concat only).
 *
 * RISK LEVEL: HIGH
 *   Every URL returned to clients, stored in MongoDB, and fed to the HLS player
 *   originates from this module. The async signature change ripples into
 *   video.service.js and video.worker.js.
 *
 * HLS DELIVERY IMPORTANT NOTE:
 *   A presigned URL grants access to ONE specific R2 object — the master.m3u8.
 *   HLS players resolve segment URLs (360p.m3u8, *.ts) as RELATIVE paths from
 *   the master playlist URL. Relative resolution strips the presigned query
 *   string, causing 403 errors on segment fetches.
 *
 *   Production options:
 *     Option A (recommended): Enable public access on the videos/hls/ prefix
 *       in Cloudflare R2 via a public bucket or custom domain. Use buildPublicUrl
 *       for HLS. Restrict raw upload paths via bucket policies.
 *     Option B: Proxy HLS through a Cloudflare Worker that re-signs each
 *       segment URL on the fly before forwarding to the player.
 *     Option C: Configure a Cloudflare Access policy on the R2 custom domain
 *       using a session cookie, giving time-limited access to the whole /hls/ tree.
 *
 *   This file preserves the original signed-URL pattern for buildHlsSignedUrl
 *   to maintain behavioral parity with Phase 2. Switch to buildPublicUrl for
 *   the HLS path once your delivery architecture decision is made.
 *
 * HIDDEN RUNTIME RISKS AVOIDED:
 *   1. Private key file loading removed — no .pem files, no disk I/O at startup,
 *      no startup crash if CLOUDFRONT_PRIVATE_KEY_PATH is missing.
 *   2. Graceful fallback preserved — if R2 credentials are absent in development,
 *      falls back to public URL instead of throwing.
 *   3. Presigned URL generation is fully local (HMAC crypto) — no network call,
 *      no latency regression vs. the CloudFront signer.
 *
 * ROLLBACK STRATEGY:
 *   Restore cloudfront.config.js. Revert import alias in video.service.js and
 *   video.worker.js. Revert the `await` additions for buildSignedUrl calls in
 *   those files. Re-add @aws-sdk/cloudfront-signer to package.json.
 *
 * ENV VARS:
 *   R2_PUBLIC_DOMAIN           — Base URL of your R2 public custom domain or
 *                                r2.dev subdomain (e.g. https://cdn.example.com
 *                                or https://pub-xxx.r2.dev). No trailing slash.
 *   R2_SIGNED_URL_TTL_SECONDS  — Presigned URL lifetime in seconds (default 14400 = 4h).
 *   STORAGE_BUCKET_NAME        — R2 bucket name (used in GetObjectCommand).
 *   R2_ACCESS_KEY_ID           — R2 API token key ID.
 *   R2_SECRET_ACCESS_KEY       — R2 API token secret.
 */

'use strict';

import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { storageClient } from './storage.config.js';
import logger from '../utils/logger.js';

// ─── Configuration ────────────────────────────────────────────────────────────

// Base URL for public (unsigned) object delivery.
// Set this to your R2 custom domain or the r2.dev public subdomain.
// Example: https://cdn.example.com  OR  https://pub-abcdef123.r2.dev
const PUBLIC_DOMAIN = process.env.R2_PUBLIC_DOMAIN || '';

// Default presigned URL lifetime (seconds). 4 hours matches Phase 2 CloudFront TTL.
const TTL_SECONDS = parseInt(process.env.R2_SIGNED_URL_TTL_SECONDS, 10) || 14400;

// ─── URL Builders ─────────────────────────────────────────────────────────────

/**
 * buildPublicUrl — Plain URL via the R2 public custom domain.
 * SYNCHRONOUS — safe to call without await.
 *
 * Use for content that is accessible without per-request authentication:
 *   - Thumbnails (always public in this architecture)
 *   - HLS segments (if you choose Option A delivery above)
 *
 * @param {string} objectKey — R2 object key (e.g. 'thumbnails/abc123.jpg')
 * @returns {string|null}
 */
function buildPublicUrl(objectKey) {
  if (!PUBLIC_DOMAIN || !objectKey) return null;
  // Normalise: strip trailing slash from domain, ensure no double-slash
  return `${PUBLIC_DOMAIN.replace(/\/$/, '')}/${objectKey}`;
}

/**
 * buildSignedUrl — Time-limited presigned URL via R2's S3-compatible API.
 * ASYNC — callers MUST await this function.
 *
 * Uses @aws-sdk/s3-request-presigner with a GetObjectCommand. The resulting
 * URL embeds SigV4 query parameters (X-Amz-*) that expire after `ttl` seconds.
 * All signing crypto is local — no network request is made during signing.
 *
 * Falls back to buildPublicUrl when credentials are not configured, enabling
 * development without R2 API tokens (same behaviour as Phase 2 CF fallback).
 *
 * @param {string} objectKey — R2 object key
 * @param {number} [ttl]     — Expiry in seconds (default: R2_SIGNED_URL_TTL_SECONDS)
 * @returns {Promise<string|null>}
 */
async function buildSignedUrl(objectKey, ttl = TTL_SECONDS) {
  if (!objectKey) return null;

  // Graceful dev fallback — mirrors the Phase 2 CloudFront behaviour
  if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    logger.warn('R2 credentials not configured — returning public URL (dev mode).');
    return buildPublicUrl(objectKey);
  }

  const command = new GetObjectCommand({
    Bucket: process.env.STORAGE_BUCKET_NAME,
    Key:    objectKey,
  });

  try {
    // getSignedUrl from @aws-sdk/s3-request-presigner is fully synchronous
    // under the hood (HMAC-SHA256 crypto) but exposed as async for API
    // consistency with other SDK operations. No network call is made.
    return await getSignedUrl(storageClient, command, { expiresIn: ttl });
  } catch (err) {
    // Degrade gracefully rather than surfacing a 500 to the client.
    // The public URL may 403 if the bucket is private, but preserves
    // the response structure for monitoring to catch.
    logger.error(`[CDN] Failed to generate presigned URL for "${objectKey}": ${err.message}`);
    return buildPublicUrl(objectKey);
  }
}

/**
 * buildHlsSignedUrl — Presigned URL for a video's HLS master playlist.
 * ASYNC — callers MUST await this function.
 *
 * See HLS DELIVERY NOTE in the file header for important caveats about
 * signed URLs and HLS segment resolution.
 *
 * @param {string} videoId — MongoDB ObjectId string
 * @returns {Promise<string|null>}
 */
async function buildHlsSignedUrl(videoId) {
  return buildSignedUrl(`videos/hls/${videoId}/master.m3u8`);
}

/**
 * buildThumbnailUrl — Public URL for a video's thumbnail.
 * SYNCHRONOUS — thumbnails are always public in this architecture.
 *
 * @param {string} videoId — MongoDB ObjectId string
 * @returns {string|null}
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