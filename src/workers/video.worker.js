/**
 * src/workers/video.worker.js — FFmpeg HLS Transcoding Worker (R2 Migration)
 *
 * WHY THIS FILE CHANGED:
 *      Import name:   s3Client                   → storageClient
 *      (buildHlsSignedUrl, buildThumbnailUrl same names)
 *   3. ACL REMOVED from uploadObject (formerly uploadToS3):
 *      PutObjectCommand no longer includes `ACL: 'private'`.
 *      R2 rejects any request with an ACL parameter (HTTP 501 NotImplemented).
 *      This is the single highest-risk line in the entire migration.
 *   4. Env var rename:
 *   5. Helper function renames (vendor-agnostic):
 *      downloadFromS3       → downloadObject
 *      uploadToS3           → uploadObject
 *      uploadDirectoryToS3  → uploadDirectory
 *   6. Queue payload backward compatibility:
 *      job.data now contains `objectKey` (new name from video.queue.js).
 *      Jobs enqueued BEFORE this deployment contain `s3Key` (old name).
 *      Both are destructured and resolved via: objectKey ?? s3Key (legacy fallback).
 *      This ensures in-flight Redis jobs drain without errors.
 *   7. ASYNC calls to buildHlsSignedUrl:
 *      buildHlsSignedUrl is now async — must be awaited before storing in MongoDB.
 *      buildThumbnailUrl remains synchronous (plain string concat).
 *
 * RISK LEVEL: MEDIUM-HIGH
 *   - The worker is a separate Node.js process. Config errors cause silent worker
 *     death, not API-layer 500s. Thorough pre-flight logging is critical.
 *   - ACL removal: one line change, but the consequence of missing it is that
 *     EVERY HLS segment upload fails with HTTP 501 at runtime, leaving videos
 *     stuck in 'processing' status permanently.
 *
 * HIDDEN RUNTIME RISKS AVOIDED:
 *   1. ACL on PutObjectCommand: The original uploadToS3 passed `ACL: 'private'`
 *      on every PutObjectCommand. R2 returns 501 on ANY request with ACL params —
 *      including metadata and segment uploads. Removed entirely.
 *   2. Body.pipe() in downloadObject: The GetObjectCommand Body is a readable
 *      stream. R2's S3-compatible API returns the same ReadableStream interface
 *      as AWS S3 — pipe() works identically. No change needed.
 *   3. Legacy job payload: without the objectKey ?? s3Key fallback, videos
 *      queued before deployment would be picked up by the new worker, which
 *      would read undefined as the object key, fail to download, and burn all
 *      3 retry attempts, leaving the video permanently in 'failed' status.
 *   4. buildHlsSignedUrl await: if the await is missing, `hlsUrl` is a
 *      Promise object. Mongoose coerces it to "[object Promise]" when storing
 *      in the String field — silent data corruption with no thrown error.
 *
 * ROLLBACK STRATEGY:
 *   back. Re-add `ACL: 'private'` to PutObjectCommand. Revert objectKey → s3Key
 *   in job.data destructuring and all downstream references. Remove the legacy
 *   Remove the await on buildHlsSignedUrl.
 *
 * ARCHITECTURE NOTE (unchanged):
 *   This worker runs as a SEPARATE Node.js process (npm run worker).
 *   Never import this file into the API server — it starts a long-lived
 *   BullMQ worker that blocks waiting for jobs. It establishes its own
 *   DB connection for this reason.
 *
 * PROCESSING PIPELINE PER JOB (unchanged):
 *   1. Download raw video from R2 → temp file
 *   2. Probe metadata with ffprobe
 *   3. Transcode to HLS at 360p, 720p, 1080p
 *   4. Generate thumbnail at 5-second mark
 *   5. Upload all HLS output + thumbnail to R2
 *   6. Update MongoDB: status='ready', hlsUrl, thumbnailUrl, meta fields
 *   7. Clean up all temp files (always, including on failure)
 *
 * On failure: status → 'failed', processingError set. BullMQ retries up to 3×.
 * Concurrency: 2 (two simultaneous videos per worker process).
 */

'use strict';

import 'dotenv/config';

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Worker } from 'bullmq';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
const ffmpegPath = ffmpegInstaller.path;
const ffprobePath = ffprobeInstaller.path;
import mongoose from 'mongoose';

// ─── R2-migrated imports ──────────────────────────────────────────────────────
import { createBullMQConnection } from '../config/redis.config.js';
import { storageClient, getHlsKeyPrefix, getThumbnailKey } from '../config/storage.config.js';
import { buildHlsSignedUrl, buildThumbnailUrl } from '../config/cdn.config.js';
// ─────────────────────────────────────────────────────────────────────────────

import connectDB from '../config/db.js';
import VideoModel from '../models/video.model.js';
import logger from '../utils/logger.js';
import { QUEUE_NAME } from '../queues/video.queue.js';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// ─── HLS Rendition Configuration ─────────────────────────────────────────────
// Unchanged from Phase 2. Each rendition produces a separate .m3u8 playlist
// and a set of .ts segment files. The master playlist references all renditions,
// letting the player choose quality based on available bandwidth.

const HLS_RENDITIONS = [
  { label: '360p',  width: 640,  height: 360,  videoBitrate: '800k',  audioBitrate: '96k'  },
  { label: '720p',  width: 1280, height: 720,  videoBitrate: '2800k', audioBitrate: '128k' },
  { label: '1080p', width: 1920, height: 1080, videoBitrate: '5000k', audioBitrate: '192k' },
];

const SEGMENT_DURATION = 6; // seconds — industry standard for HLS VOD

// ─── Storage Helpers ──────────────────────────────────────────────────────────

/**
 * downloadObject — Stream an R2 object to a local temp file.
 * (was: downloadFromS3)
 *
 * Body.pipe() works identically for R2's S3-compatible stream response.
 * The GetObjectCommand requires no changes for R2 compatibility.
 *
 * @param {string} objectKey — R2 object key of the raw uploaded video
 * @param {string} destPath  — local filesystem path to write to
 * @returns {Promise<string>} resolves with destPath on success
 */
async function downloadObject(objectKey, destPath) {
  const command = new GetObjectCommand({
    Bucket: process.env.STORAGE_BUCKET_NAME,
    Key:    objectKey,
  });

  const { Body } = await storageClient.send(command);

  return new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(destPath);
    Body.pipe(writeStream);
    writeStream.on('finish', () => resolve(destPath));
    writeStream.on('error', reject);
  });
}

/**
 * uploadObject — Upload a local file to R2 with the given key and content type.
 * (was: uploadToS3)
 *
 * CRITICAL CHANGE: `ACL: 'private'` has been removed.
 * R2 does not implement the S3 ACL API. Including any ACL parameter causes
 * R2 to return HTTP 501 NotImplemented, failing the upload silently.
 * R2 access control is set at the bucket level in the Cloudflare dashboard.
 *
 * @param {string} localPath    — path to the local file to upload
 * @param {string} objectKey    — destination R2 object key
 * @param {string} contentType  — MIME type for the Content-Type header
 */
async function uploadObject(localPath, objectKey, contentType) {
  const fileStream = fs.createReadStream(localPath);

  const command = new PutObjectCommand({
    Bucket:      process.env.STORAGE_BUCKET_NAME,
    Key:         objectKey,
    Body:        fileStream,
    ContentType: contentType,
    // ACL removed — R2 returns HTTP 501 NotImplemented on any ACL header.
    // Bucket-level access is configured in the Cloudflare R2 dashboard.
    CacheControl: 'max-age=31536000', // 1-year edge cache for immutable assets
  });

  await storageClient.send(command);
}

/**
 * uploadDirectory — Upload all files in a local directory to R2.
 * (was: uploadDirectoryToS3)
 *
 * Used to batch-upload the HLS output directory after FFmpeg finishes.
 * All uploads run in parallel via Promise.all — safe because they are
 * independent objects in R2.
 *
 * @param {string} localDir      — local directory containing HLS output files
 * @param {string} storagePrefix — R2 key prefix for the destination folder
 */
async function uploadDirectory(localDir, storagePrefix) {
  const files = fs.readdirSync(localDir);

  await Promise.all(
    files.map((file) => {
      const localPath  = path.join(localDir, file);
      const objectKey  = `${storagePrefix}${file}`;
      const contentType = file.endsWith('.m3u8')
        ? 'application/x-mpegURL'
        : 'video/MP2T';
      return uploadObject(localPath, objectKey, contentType);
    })
  );
}

// ─── FFmpeg Helpers ───────────────────────────────────────────────────────────
// Unchanged from Phase 2 — FFmpeg pipeline is storage-agnostic.

/**
 * transcodeRendition — Run FFmpeg to produce HLS segments for one quality level.
 * Updates BullMQ job progress so dashboards (Bull Board) reflect completion %.
 */
function transcodeRendition(inputPath, outputDir, rendition, job) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        `-vf scale=${rendition.width}:${rendition.height}`,
        `-c:v libx264`,
        `-b:v ${rendition.videoBitrate}`,
        `-c:a aac`,
        `-b:a ${rendition.audioBitrate}`,
        `-hls_time ${SEGMENT_DURATION}`,
        `-hls_playlist_type vod`,
        `-hls_segment_filename ${path.join(outputDir, `${rendition.label}_%04d.ts`)}`,
        `-f hls`,
      ])
      .output(path.join(outputDir, `${rendition.label}.m3u8`))
      .on('progress', (progress) => {
        if (progress.percent) {
          job.updateProgress(Math.round(progress.percent)).catch(() => {});
        }
      })
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

/**
 * generateThumbnail — Extract a single JPEG frame at the 5-second mark.
 */
function generateThumbnail(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .screenshots({
        timestamps: ['5'],
        filename:   path.basename(outputPath),
        folder:     path.dirname(outputPath),
        size:       '1280x720',
      })
      .on('end', resolve)
      .on('error', reject);
  });
}

/**
 * getVideoMetadata — Probe the video file for duration, dimensions, bitrate.
 */
function getVideoMetadata(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
      resolve({
        duration: Math.round(metadata.format.duration),
        width:    videoStream?.width  ?? null,
        height:   videoStream?.height ?? null,
        bitrate:  parseInt(metadata.format.bit_rate, 10) || null,
      });
    });
  });
}

/**
 * buildMasterPlaylist — Construct the HLS master playlist content.
 * Players use this to select a quality rendition based on bandwidth.
 */
function buildMasterPlaylist(renditions) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

  for (const r of renditions) {
    const bandwidth = parseInt(r.videoBitrate) * 1000;
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${r.width}x${r.height}`);
    lines.push(`${r.label}.m3u8`);
  }

  return lines.join('\n');
}

// ─── Job Processor ────────────────────────────────────────────────────────────

/**
 * processVideo — Core BullMQ job handler.
 *
 * BACKWARD COMPATIBILITY — QUEUE PAYLOAD:
 *   Jobs enqueued by video.service.js BEFORE this deployment contain:
 *     { videoId, s3Key, mimeType }       ← old field name (Phase 2)
 *   Jobs enqueued AFTER this deployment contain:
 *     { videoId, objectKey, mimeType }   ← new field name (R2 migration)
 *
 *   We destructure both and resolve: resolvedObjectKey = objectKey ?? s3Key
 *   This allows the worker to drain the existing Redis queue without errors.
 *   The legacy fallback can be removed once the Redis queue is confirmed empty
 *   of pre-migration jobs (typically 24–48 hours after deployment).
 */
async function processVideo(job) {
  // Destructure both the new name (objectKey) and the legacy name (s3Key)
  // for backward compat with jobs already sitting in Redis before deployment.
  const { videoId, objectKey, s3Key: legacyObjectKey, mimeType } = job.data;
  const resolvedObjectKey = objectKey ?? legacyObjectKey;

  logger.info(`[Worker] Starting: videoId=${videoId} objectKey=${resolvedObjectKey}`);

  if (!resolvedObjectKey) {
    throw new Error(`Job ${job.id} has no objectKey or s3Key in payload — cannot process.`);
  }

  // Mark as processing in MongoDB so the API can report progress to pollers.
  await VideoModel.findByIdAndUpdate(videoId, {
    status: VideoModel.STATUS.PROCESSING,
  });

  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), `video-${videoId}-`));
  const rawPath = path.join(tmpDir, 'raw' + path.extname(resolvedObjectKey));
  const hlsDir  = path.join(tmpDir, 'hls');
  const thumbPath = path.join(tmpDir, 'thumb.jpg');

  fs.mkdirSync(hlsDir, { recursive: true });

  try {
    // ── 1. Download raw video from R2 to local temp file ─────────────────────
    logger.info(`[Worker] Downloading from R2: ${resolvedObjectKey}`);
    await downloadObject(resolvedObjectKey, rawPath);

    // ── 2. Probe video metadata (duration, resolution, bitrate) ──────────────
    const meta = await getVideoMetadata(rawPath);
    logger.info(`[Worker] Probed: duration=${meta.duration}s ${meta.width}x${meta.height}`);

    // ── 3. Transcode each HLS rendition (sequential to avoid OOM on small VMs) ─
    for (const rendition of HLS_RENDITIONS) {
      logger.info(`[Worker] Transcoding ${rendition.label}…`);
      await transcodeRendition(rawPath, hlsDir, rendition, job);
    }

    // ── 4. Write master playlist to disk ─────────────────────────────────────
    const masterContent = buildMasterPlaylist(HLS_RENDITIONS);
    fs.writeFileSync(path.join(hlsDir, 'master.m3u8'), masterContent);

    // ── 5. Generate thumbnail ─────────────────────────────────────────────────
    logger.info('[Worker] Generating thumbnail…');
    await generateThumbnail(rawPath, thumbPath);

    // ── 6. Upload HLS output directory and thumbnail to R2 ───────────────────
    const hlsPrefix = getHlsKeyPrefix(videoId);
    logger.info(`[Worker] Uploading HLS output to R2: ${hlsPrefix}`);
    await uploadDirectory(hlsDir, hlsPrefix);

    const thumbnailObjectKey = getThumbnailKey(videoId);
    await uploadObject(thumbPath, thumbnailObjectKey, 'image/jpeg');
    logger.info(`[Worker] Thumbnail uploaded: ${thumbnailObjectKey}`);

    // ── 7. Update MongoDB — video is now streamable ───────────────────────────
    // buildHlsSignedUrl is ASYNC (presigned URL via @aws-sdk/s3-request-presigner).
    // Must await — without it, hlsUrl stores a Promise object string in MongoDB.
    // buildThumbnailUrl is synchronous (plain public URL string concatenation).
    const hlsUrl      = await buildHlsSignedUrl(videoId);
    const thumbnailUrl = buildThumbnailUrl(videoId);

    await VideoModel.findByIdAndUpdate(videoId, {
      status:            VideoModel.STATUS.READY,
      hlsUrl,
      thumbnailUrl,
      processingError:   null,
      'meta.duration':   meta.duration,
      'meta.width':      meta.width,
      'meta.height':     meta.height,
      'meta.bitrate':    meta.bitrate,
    });

    logger.info(`[Worker] Complete: videoId=${videoId}`);

  } catch (err) {
    logger.error(`[Worker] Failed: videoId=${videoId} — ${err.message}`);

    await VideoModel.findByIdAndUpdate(videoId, {
      status:          VideoModel.STATUS.FAILED,
      processingError: err.message,
    });

    // Re-throw so BullMQ can retry the job (up to 3 attempts per video.queue.js config).
    throw err;

  } finally {
    // Always clean up temp files, even on failure, to prevent disk exhaustion
    // on long-running worker processes.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Worker Bootstrap ─────────────────────────────────────────────────────────

async function startWorker() {
  // Workers run in a separate process and need their own DB connection.
  await connectDB();

  const worker = new Worker(QUEUE_NAME, processVideo, {
    connection:  createBullMQConnection('video-worker'),
    concurrency: 2, // Two videos transcoded simultaneously per worker process.
                    // Scale horizontally by launching additional worker instances.
  });

  worker.on('completed', (job) => {
    logger.info(`[Worker] Job completed: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(`[Worker] Job failed: ${job?.id} — ${err.message}`);
  });

  worker.on('error', (err) => {
    logger.error(`[Worker] Worker error: ${err.message}`);
  });

  logger.info(`✅  Video worker started. Queue: "${QUEUE_NAME}", concurrency: 2`);

  // Graceful shutdown — wait for in-progress jobs to complete before exiting.
  // This prevents videos from getting stuck in 'processing' status on deploys.
  process.on('SIGTERM', async () => {
    logger.info('[Worker] SIGTERM received. Draining current jobs and shutting down…');
    await worker.close();
    await mongoose.connection.close();
    process.exit(0);
  });
}

startWorker().catch((err) => {
  logger.error('[Worker] Failed to start:', err);
  process.exit(1);
});
