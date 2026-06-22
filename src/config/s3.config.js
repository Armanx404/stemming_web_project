/**
 * src/config/s3.config.js — AWS S3 Client + multer-s3 Storage Engine
 *
 * This file is the ONLY place in the codebase that knows about S3.
 * upload.middleware.js imports `s3Storage` from here — no other file
 * touches the AWS SDK directly.
 *
 * File organisation in the bucket:
 *   videos/raw/<objectId>/<timestamp>-<hex>.<ext>   ← original upload
 *   videos/hls/<objectId>/master.m3u8               ← HLS playlist (written by worker)
 *   videos/hls/<objectId>/<resolution>.m3u8          ← rendition playlist
 *   videos/hls/<objectId>/<segment>.ts               ← transport stream segments
 *   thumbnails/<objectId>.jpg                        ← thumbnail (written by worker)
 *
 * Access model:
 *   S3 bucket has ALL public access BLOCKED.
 *   Files are served ONLY via CloudFront with signed URLs (see cloudfront.config.js).
 *   The API never streams S3 bytes directly — always redirects to CloudFront.
 */

'use strict';

import { S3Client } from '@aws-sdk/client-s3';
import multerS3 from 'multer-s3';
import crypto from 'crypto';
import path from 'path';

// ─── S3 Client ────────────────────────────────────────────────────────────────

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  // Phase 3: Add request timeout and retry configuration
  // maxAttempts: 3,
});

// ─── multer-s3 Storage Engine ─────────────────────────────────────────────────

/**
 * s3Storage — Drop-in replacement for multer.diskStorage.
 *
 * The key (S3 object path) is stored on req.file.key and req.file.location
 * after upload. The video service reads req.file.key to store the S3 key
 * in MongoDB for the FFmpeg worker.
 *
 * @param {string} videoId — MongoDB ObjectId of the video document being created.
 *   Passed via req.videoId (set by the controller before calling multer).
 */
function createS3Storage(getVideoId) {
  return multerS3({
    s3: s3Client,
    bucket: process.env.S3_BUCKET_NAME,

    // No public access — CloudFront handles all delivery
    acl: 'private',

    // Set correct Content-Type header on S3 objects (important for HLS)
    contentType: multerS3.AUTO_CONTENT_TYPE,

    // Cache-Control header for CloudFront edge caching
    cacheControl: 'max-age=31536000', // 1 year for immutable video files

    key: (req, file, cb) => {
      const videoId = getVideoId(req);
      const ext = path.extname(file.originalname).toLowerCase();
      const uniqueSuffix = crypto.randomBytes(8).toString('hex');

      let s3Key;
      if (file.fieldname === 'video') {
        // Raw video goes into a per-video folder for easy worker access
        s3Key = `videos/raw/${videoId}/${uniqueSuffix}${ext}`;
      } else if (file.fieldname === 'thumbnail') {
        s3Key = `thumbnails/${videoId}-${uniqueSuffix}${ext}`;
      } else {
        return cb(new Error(`Unexpected field: ${file.fieldname}`));
      }

      cb(null, s3Key);
    },
  });
}

// ─── S3 Key Helpers ───────────────────────────────────────────────────────────

/**
 * getHlsKeyPrefix — Returns the S3 prefix where the worker will write HLS output.
 * @param {string} videoId
 */
function getHlsKeyPrefix(videoId) {
  return `videos/hls/${videoId}/`;
}

/**
 * getThumbnailKey — Returns the expected S3 key for a video's thumbnail.
 * @param {string} videoId
 */
function getThumbnailKey(videoId) {
  return `thumbnails/${videoId}.jpg`;
}

export {
s3Client, createS3Storage, getHlsKeyPrefix, getThumbnailKey
};
