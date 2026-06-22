/**
 * src/config/storage.config.js — Cloudflare R2 Storage Client + multer Storage Engine
 *
 * WHY THIS FILE CHANGED (was: s3.config.js):
 *   - AWS S3Client re-initialized for R2 endpoint/region/credentials.
 *   - `acl: 'private'` on multer-s3 REMOVED. R2 does not implement the S3 ACL
 *     API. Any request that includes an ACL header returns HTTP 501 NotImplemented,
 *     which silently aborts every upload. R2 access is controlled at bucket level
 *     in the Cloudflare dashboard — never per-object via ACL.
 *   - `forcePathStyle: true` added. R2's S3-compatible endpoint requires path-style
 *     URLs. Virtual-hosted style is not stable for all R2 operations, especially
 *     presigned URL generation.
 *   - region: 'auto' — R2 does not use AWS region codes. Any other value causes
 *     SigV4 signing mismatches.
 *   - AWS_* env vars → R2_*, S3_BUCKET_NAME → STORAGE_BUCKET_NAME.
 *   - createS3Storage()  → createStorageEngine()  (vendor-agnostic naming)
 *   - s3Client           → storageClient          (vendor-agnostic naming)
 *
 * RISK LEVEL: HIGH
 *   Root dependency for every upload, every worker download/upload, and every
 *   object delete. Misconfiguration here breaks the entire storage layer.
 *
 * HIDDEN RUNTIME RISKS AVOIDED:
 *   1. ACL removal: multer-s3 v3 sends the `acl` PutObject param if the option
 *      key exists at all. The key is omitted entirely — not set to undefined.
 *   2. forcePathStyle: without this, the SDK may construct virtual-hosted URLs
 *      (https://<bucket>.r2.cloudflarestorage.com) whose SigV4 signatures
 *      diverge from what R2 validates in some edge cases.
 *   3. region 'auto': sending a real AWS region string to R2 does not always fail
 *      immediately, but causes subtle signing failures under certain payloads.
 *
 * ROLLBACK STRATEGY:
 *   Keep s3.config.js alongside this file. Revert import aliases in
 *   upload.middleware.js, video.worker.js, video.service.js to s3.config.js.
 *   No DB schema or queue payload changes are needed for rollback.
 *
 * BUCKET PATH STRUCTURE (unchanged — stable across AWS→R2 migration):
 *   videos/raw/<objectId>/<hex>.<ext>    ← raw upload (stored as objectKey in DB)
 *   videos/hls/<objectId>/master.m3u8   ← HLS master playlist
 *   videos/hls/<objectId>/<res>.m3u8    ← rendition playlist
 *   videos/hls/<objectId>/<seg>.ts      ← transport stream segments
 *   thumbnails/<objectId>.jpg           ← generated thumbnail
 */

'use strict';

import { S3Client } from '@aws-sdk/client-s3';
import multerS3 from 'multer-s3';
import crypto from 'crypto';
import path from 'path';

// ─── R2 Endpoint ──────────────────────────────────────────────────────────────
// Format: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
// R2_ACCOUNT_ID is your 32-char hex Cloudflare account ID visible in the
// dashboard under R2 > Overview or in Account Settings.

const R2_ENDPOINT = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

// ─── Storage Client ───────────────────────────────────────────────────────────
// AWS SDK v3 S3Client is 100% compatible with R2's S3-compatible API.
// Three config keys differ from the original AWS setup:
//   endpoint      → R2's account-scoped URL instead of AWS
//   region        → 'auto' (R2 routes internally; AWS region codes are rejected)
//   forcePathStyle → true (stable path construction for all R2 S3 operations)

const storageClient = new S3Client({
  region:   'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  // R2 requires path-style: https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
  forcePathStyle: true,
});

// ─── multer-s3 Storage Engine ─────────────────────────────────────────────────
// Drop-in replacement for createS3Storage. External API is identical —
// upload.middleware.js calls createStorageEngine((r) => r.videoId) unchanged.
//
// CRITICAL DIFFERENCE: The `acl` option is completely absent from this config.
// multer-s3 v3 includes ACL in the PutObjectRequest whenever the option key
// exists. Omitting the key entirely guarantees no ACL header is sent.
//
// @param {function} getVideoId — (req) => string
//   Returns the pre-generated ObjectId from req.videoId (set by upload.middleware.js).

function createStorageEngine(getVideoId) {
  return multerS3({
    s3:    storageClient,
    bucket: process.env.STORAGE_BUCKET_NAME,

    // ACL intentionally omitted — R2 rejects all ACL headers (HTTP 501).
    // Set bucket-level access (public / private) in the Cloudflare R2 dashboard.

    // Sniffs MIME type and sets Content-Type on the R2 object.
    // Required so HLS playlists (.m3u8) are served with application/x-mpegURL.
    contentType: multerS3.AUTO_CONTENT_TYPE,

    // 1-year immutability hint for R2 / CDN edge caches.
    cacheControl: 'max-age=31536000',

    // Deterministic key paths scoped to the video's MongoDB ObjectId.
    // This key is stored in MongoDB (video.s3Key field) and passed verbatim
    // to the FFmpeg worker via the BullMQ job payload.
    key: (req, file, cb) => {
      const videoId      = getVideoId(req);
      const ext          = path.extname(file.originalname).toLowerCase();
      const uniqueSuffix = crypto.randomBytes(8).toString('hex');

      let objectKey;

      if (file.fieldname === 'video') {
        objectKey = `videos/raw/${videoId}/${uniqueSuffix}${ext}`;
      } else if (file.fieldname === 'thumbnail') {
        objectKey = `thumbnails/${videoId}-${uniqueSuffix}${ext}`;
      } else {
        return cb(new Error(`Unexpected multipart field: ${file.fieldname}`));
      }

      cb(null, objectKey);
    },
  });
}

// ─── Object Key Helpers ───────────────────────────────────────────────────────
// These define the canonical R2 paths for FFmpeg output.
// Consumed by:
//   - video.worker.js  → knows WHERE to upload HLS segments + thumbnail
//   - cdn.config.js    → builds delivery URLs from known paths
//
// STABILITY WARNING: These path patterns are stored in MongoDB
// (video.hlsUrl, video.thumbnailUrl). Do not change them — doing so would
// break playback for every already-processed video without a data migration.

/**
 * getHlsKeyPrefix — R2 prefix for all HLS output files for a given video.
 * The worker uploads master.m3u8, rendition playlists, and .ts segments here.
 * @param {string} videoId — MongoDB ObjectId string
 * @returns {string}
 */
function getHlsKeyPrefix(videoId) {
  return `videos/hls/${videoId}/`;
}

/**
 * getThumbnailKey — R2 key for a video's FFmpeg-generated thumbnail.
 * @param {string} videoId — MongoDB ObjectId string
 * @returns {string}
 */
function getThumbnailKey(videoId) {
  return `thumbnails/${videoId}.jpg`;
}

export {
storageClient,
  createStorageEngine,
  getHlsKeyPrefix,
  getThumbnailKey,
};