/**
 * src/middleware/upload.middleware.js — Multer File Upload (R2 Migration)
 *
 * WHY THIS FILE CHANGED:
 *   Two targeted changes only — no logic, validation, or flow changes:
 *     2. Import name:   createS3Storage     → createStorageEngine
 *
 *   The entire external API of this module (uploadFields) is unchanged.
 *   No route, controller, or middleware stack modifications are needed.
 *
 * RISK LEVEL: LOW
 *   The multer orchestration, file filter logic, size limits, field names,
 *   error handling, and req.videoId pre-generation are all untouched.
 *   The only runtime path that changed is which storage engine multer uses
 *   — and that engine (createStorageEngine) is a tested drop-in replacement.
 *
 * HIDDEN RUNTIME RISKS AVOIDED:
 *   multer-s3 v3's createStorageEngine no longer sends an ACL header to R2
 *   (the `acl` option was removed in storage.config.js). This middleware
 *   never referenced ACL directly, so no change is needed here. However,
 *   confirming this file doesn't independently construct a multer-s3 instance
 *   (it delegates entirely to createStorageEngine) is the key safety check.
 *
 * ROLLBACK STRATEGY:
 *   Change the two import lines back to:
 *     storage: createS3Storage((r) => r.videoId),
 *
 * UPLOAD FLOW (unchanged):
 *   1. uploadFields middleware runs
 *   2. req.videoId pre-generated (MongoDB ObjectId) — embedded in S3 key
 *   3. File streamed directly from client → R2 (no disk touch on API server)
 *   4. On success:
 *      req.files.video[0].key      — R2 object key of the raw video
 *      req.files.video[0].location — full R2 URL (unused; CDN URL used instead)
 *      req.files.thumbnail[0].key  — R2 object key of thumbnail (if provided)
 *   5. Controller reads req.files and req.body as before
 */

'use strict';

import multer from 'multer';
import mongoose from 'mongoose';
import { StatusCodes } from 'http-status-codes';

// ─── Storage import: now vendor-agnostic ──────────────────────────────────────
import { createStorageEngine } from '../config/storage.config.js';
import { errorResponse } from '../utils/response.js';

// ─── MIME Allow-lists ─────────────────────────────────────────────────────────

const ALLOWED_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
]);

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const MAX_FILE_SIZE_BYTES =
  (parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 500) * 1024 * 1024;

// ─── File Filter ──────────────────────────────────────────────────────────────

function fileFilter(_req, file, cb) {
  if (file.fieldname === 'video') {
    return ALLOWED_VIDEO_MIME_TYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE',
          `Unsupported video format: ${file.mimetype}`));
  }
  if (file.fieldname === 'thumbnail') {
    return ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)
      ? cb(null, true)
      : cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE',
          `Unsupported image format: ${file.mimetype}`));
  }
  cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
}

// ─── Main Middleware ──────────────────────────────────────────────────────────

/**
 * uploadFields — Stream multipart files directly to R2.
 *
 * We pre-generate a MongoDB ObjectId here so the R2 object key can include it.
 * This ID is used as _id when creating the Video document, keeping the DB record
 * and R2 path in sync from the moment of upload.
 *
 * After this middleware:
 *   req.videoId                    — the pre-generated ObjectId (string)
 *   req.files.video[0].key         — R2 object key of the uploaded raw video
 *   req.files.video[0].location    — full S3-style URL (use CDN URL instead)
 *   req.files.thumbnail[0].key     — R2 object key of thumbnail (if provided)
 */
const uploadFields = (req, res, next) => {
  // Generate the video's ObjectId before upload so the R2 key includes it.
  // This is set on req so createStorageEngine's getVideoId callback can read it.
  req.videoId = new mongoose.Types.ObjectId().toHexString();

  const upload = multer({
    storage: createStorageEngine((r) => r.videoId),
    fileFilter,
    limits: {
      fileSize: MAX_FILE_SIZE_BYTES,
      files:    2,
      fields:   10,
    },
  });

  const handler = upload.fields([
    { name: 'video',     maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
  ]);

  handler(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      const messages = {
        LIMIT_FILE_SIZE:       `File exceeds the maximum allowed size of ${process.env.MAX_FILE_SIZE_MB || 500} MB.`,
        LIMIT_UNEXPECTED_FILE: err.message || 'Unexpected file field.',
        LIMIT_FILE_COUNT:      'Too many files in one request.',
      };
      return res
        .status(StatusCodes.BAD_REQUEST)
        .json(errorResponse(messages[err.code] || err.message));
    }

    return res
      .status(StatusCodes.UNSUPPORTED_MEDIA_TYPE)
      .json(errorResponse(err.message));
  });
};

export {
uploadFields
};