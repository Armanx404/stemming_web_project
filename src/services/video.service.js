/**
 * src/services/video.service.js — Video Business Logic (R2 Migration)
 *
 * WHY THIS FILE CHANGED:
 *   1. Import source change:
 *        ../config/s3.config → ../config/storage.config
 *        s3Client            → storageClient
 *   2. Import source change:
 *        ../config/cloudfront.config → ../config/cdn.config
 *        buildSignedUrl              → buildSignedUrl (same name, now ASYNC)
 *   3. Queue payload field rename:
 *        s3Key → objectKey  in the enqueueVideoProcessing call
 *   4. ASYNC handling of buildSignedUrl:
 *        buildSignedUrl is now an async function (presigned URL via R2 SDK).
 *        All three call sites in createVideo and getVideoById must `await` it.
 *   5. Env var rename:
 *        process.env.S3_BUCKET_NAME → process.env.STORAGE_BUCKET_NAME
 *   6. Local variable renames (vendor-agnostic, not DB field names):
 *        s3Key (local var) → objectKey
 *        thumbnailS3Key    → thumbnailObjectKey
 *        DB field video.s3Key is NOT renamed — it is defined in video.model.js
 *        which is outside the scope of this migration.
 *
 * RISK LEVEL: MEDIUM
 *   The async change to buildSignedUrl is the highest-risk item. If any call
 *   site forgets `await`, it stores a "[object Promise]" string as the URL
 *   in MongoDB — a silent data corruption bug. All three sites are audited below.
 *
 * HIDDEN RUNTIME RISKS AVOIDED:
 *   1. createVideo — two buildSignedUrl calls, both awaited:
 *        const videoUrl     = await buildSignedUrl(objectKey)
 *        const thumbnailUrl = thumbnailObjectKey ? await buildSignedUrl(...) : null
 *   2. getVideoById — one buildSignedUrl call, awaited:
 *        video.videoUrl = await buildSignedUrl(video.s3Key)
 *      Note: video.s3Key is the DB field name (video.model.js). Using the DB
 *      field name directly here is correct — do not rename to video.objectKey.
 *   3. deleteVideo — uses storageClient (renamed from s3Client). The
 *      DeleteObjectCommand is SDK-compatible with R2's S3 API unchanged.
 *   4. S3_BUCKET_NAME → STORAGE_BUCKET_NAME in DeleteObjectCommand to match
 *      the new env var convention.
 *
 * ROLLBACK STRATEGY:
 *   Revert import paths to s3.config and cloudfront.config. Remove `await`
 *   from the three buildSignedUrl call sites. Rename objectKey → s3Key in
 *   local vars and the enqueueVideoProcessing call. Revert STORAGE_BUCKET_NAME
 *   → S3_BUCKET_NAME in the delete operation.
 *
 * SYSTEMS UNCHANGED:
 *   - getAllVideos (no storage interaction)
 *   - Redis cache invalidation logic
 *   - Pagination logic
 *   - Soft-delete DB update
 *   - Ownership check (enforced upstream in requireOwner middleware)
 *   - Response structure
 *   - Error propagation (statusCode on thrown Error objects)
 *   - Logger calls
 */

'use strict';

import mongoose from 'mongoose';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';

import VideoModel from '../models/video.model.js';
import { storageClient } from '../config/storage.config.js';
import { buildSignedUrl, buildHlsSignedUrl } from '../config/cdn.config.js';
import { enqueueVideoProcessing } from '../queues/video.queue.js';
import { invalidateCache } from '../middleware/cache.middleware.js';
import logger from '../utils/logger.js';

const LIST_CACHE_NAMESPACE = 'videos-list';

// ─── Service Methods ──────────────────────────────────────────────────────────

/**
 * createVideo — Persist video metadata and enqueue the FFmpeg transcoding job.
 *
 * The video is stored in MongoDB immediately with status='pending'.
 * The API responds instantly; transcoding happens asynchronously in the worker.
 * Clients poll GET /api/videos/:id and check the `status` field.
 *
 * ASYNC CHANGE: buildSignedUrl is now async. Both call sites below are awaited.
 * If await is omitted, the URL fields store a Promise object string — silent bug.
 *
 * @param {{ title, description, userId }} fields
 * @param {{ videoFile, thumbnailFile }}   files — multer-s3 file objects
 * @param {string}                         videoId — pre-generated ObjectId (from upload middleware)
 */
async function createVideo({ title, description, userId }, { videoFile, thumbnailFile }, videoId) {
  if (!videoFile) {
    const err = new Error('A video file is required for upload.');
    err.statusCode = 400;
    throw err;
  }

  // multer-s3 sets .key to the R2 object key and .location to the raw S3-style URL.
  // We never expose .location directly — always build URLs via cdn.config.js.
  const objectKey         = videoFile.key;
  const thumbnailObjectKey = thumbnailFile?.key ?? null;

  // buildSignedUrl is ASYNC — must await both calls.
  // Produces a time-limited presigned R2 URL for the raw video.
  const videoUrl     = await buildSignedUrl(objectKey);
  const thumbnailUrl = thumbnailObjectKey
    ? await buildSignedUrl(thumbnailObjectKey)
    : null;

  const meta = {
    format:    videoFile.originalname.split('.').pop().toLowerCase(),
    sizeBytes: videoFile.size,
    mimeType:  videoFile.mimetype,
  };

  // Use the pre-generated ID so the R2 object key and DB _id are always in sync.
  // The DB field is named `s3Key` (video.model.js schema — not renamed here).
  const video = await VideoModel.create({
    _id:         new mongoose.Types.ObjectId(videoId),
    title,
    description,
    videoUrl,
    thumbnailUrl,
    meta,
    s3Key:       objectKey,   // DB field name is s3Key — defined in video.model.js
    uploadedBy:  userId || null,
    status:      'pending',
  });

  // Enqueue FFmpeg transcoding job — non-blocking.
  // Payload field renamed from s3Key to objectKey (vendor-agnostic).
  // video.queue.js and video.worker.js both updated to match.
  await enqueueVideoProcessing({
    videoId:   video.id,
    objectKey,          // renamed from s3Key in Phase 2
    mimeType:  videoFile.mimetype,
  });

  // Invalidate the list cache so the new video appears immediately in GET /api/videos.
  await invalidateCache(LIST_CACHE_NAMESPACE);

  logger.info(`Video created & queued: id=${video.id} title="${video.title}"`);
  return video;
}

/**
 * getAllVideos — Paginated list of active videos.
 * Cache layer is applied at the route level (cache middleware).
 * This function is pure DB logic — no storage or CDN interaction.
 */
async function getAllVideos({ page = 1, limit = 20, sort = '-createdAt' } = {}) {
  const pageNum  = Math.max(1, parseInt(page, 10)  || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip     = (pageNum - 1) * limitNum;

  const ALLOWED_SORT_FIELDS = ['createdAt', '-createdAt', 'title', '-title', 'views', '-views'];
  const safeSort = ALLOWED_SORT_FIELDS.includes(sort) ? sort : '-createdAt';

  const activeFilter = { isDeleted: false };

  const [videos, total] = await Promise.all([
    VideoModel.find(activeFilter)
      .sort(safeSort)
      .skip(skip)
      .limit(limitNum)
      .populate('uploadedBy', 'username')
      .lean({ virtuals: true }),
    VideoModel.countDocuments(activeFilter),
  ]);

  return {
    data: videos,
    pagination: {
      total,
      page:        pageNum,
      limit:       limitNum,
      totalPages:  Math.ceil(total / limitNum),
      hasNextPage: pageNum < Math.ceil(total / limitNum),
      hasPrevPage: pageNum > 1,
    },
  };
}

/**
 * getVideoById — Fetch a single video and increment view counter.
 *
 * RUNTIME BUG FIXED (R2 migration):
 *   video.model.js declares s3Key with { select: false }. Without explicitly
 *   selecting it, video.s3Key is undefined after .lean(), causing the URL
 *   regeneration block to silently skip (condition: video.s3Key → undefined → falsy).
 *   Fix: add .select('+s3Key') to force-include the field for this query only.
 *   The toJSON transform still strips s3Key from API responses (model-level config).
 *
 *   Additionally, the worker stores hlsUrl in MongoDB as a presigned URL (TTL-bound).
 *   After TTL expiry, the stored hlsUrl returns 403. This function now regenerates
 *   hlsUrl on every fetch (same pattern as videoUrl) using buildHlsSignedUrl.
 *   buildHlsSignedUrl is ASYNC — must be awaited.
 *
 * NOTE: video.s3Key is the MongoDB document field name (video.model.js schema).
 * It is never exposed in API responses (select: false + toJSON transform deletes it).
 */
async function getVideoById(id) {
  const video = await VideoModel.findByIdAndUpdate(
    id,
    { $inc: { views: 1 } },
    { new: true, runValidators: false }
  )
    .select('+s3Key')   // s3Key has select:false in schema — must opt-in explicitly
    .populate('uploadedBy', 'username')
    .lean({ virtuals: true });

  if (!video) {
    const err = new Error(`Video with id "${id}" not found.`);
    err.statusCode = 404;
    throw err;
  }

  // Re-generate fresh presigned URLs on every fetch.
  // Presigned URLs carry a TTL (default 4h). Without regeneration, the URLs
  // stored in MongoDB go stale and return 403 after expiry.
  // buildSignedUrl and buildHlsSignedUrl are ASYNC — both must be awaited.
  // Without await, the field stores a Promise object string — silent data bug.
  if (video.status === 'ready') {
    if (video.s3Key) {
      video.videoUrl = await buildSignedUrl(video.s3Key);
    }
    // Regenerate hlsUrl — worker stored a presigned URL that may have expired.
    // Uses videoId (the document's _id) to reconstruct the canonical HLS path.
    video.hlsUrl = await buildHlsSignedUrl(video.id);
  }

  return video;
}

/**
 * deleteVideo — Soft-delete in MongoDB + hard-delete from R2.
 *
 * Ownership verification is handled upstream by requireOwner middleware.
 * By the time this function runs, the caller is confirmed to be authorised.
 * The pre-loaded document is passed in to avoid a second DB round-trip.
 *
 * R2 DeleteObjectCommand uses the same AWS SDK interface as S3 — no change
 * to the command itself, only to the client (storageClient) and bucket env var.
 *
 * @param {VideoDocument} video — already-loaded video document (from req.resource)
 */
async function deleteVideo(video) {
  // 1. Soft-delete in DB (preserves audit trail; isDeleted filter in pre-hooks
  //    ensures the document no longer appears in find/list queries).
  await VideoModel.findByIdAndUpdate(video._id, { isDeleted: true });

  // 2. Hard-delete the raw file from R2.
  //    Best-effort: a storage failure should not roll back the DB soft-delete
  //    or return a 500 to the caller. Log the warning and continue.
  //    Note: video.s3Key is the DB field name — references the raw upload object key.
  if (video.s3Key) {
    try {
      await storageClient.send(new DeleteObjectCommand({
        Bucket: process.env.STORAGE_BUCKET_NAME,
        Key:    video.s3Key,
      }));
      logger.info(`R2 object deleted: ${video.s3Key}`);
    } catch (err) {
      logger.warn(`R2 delete failed for "${video.s3Key}": ${err.message}`);
    }
  }

  // 3. Invalidate the list cache so the deleted video disappears from GET /api/videos.
  await invalidateCache(LIST_CACHE_NAMESPACE);

  logger.info(`Video soft-deleted: id=${video.id}`);
}

export {
createVideo, getAllVideos, getVideoById, deleteVideo
};