/**
 * src/queues/video.queue.js — BullMQ Job Queue Definition (R2 Migration)
 *
 * WHY THIS FILE CHANGED:
 *   The enqueueVideoProcessing function accepted and forwarded a payload field
 *   named `s3Key` — an AWS-specific name. As part of the vendor-agnostic
 *   refactor, this is renamed to `objectKey` throughout.
 *
 *   The queue name ('video-processing') is INTENTIONALLY UNCHANGED.
 *   The queue name is the Redis key prefix for all persisted BullMQ jobs.
 *   Renaming it would orphan every job currently sitting in Redis, including
 *   any pending or failed jobs from videos uploaded before this deployment.
 *   Never rename a BullMQ queue name in a live system without a drain-first
 *   migration plan.
 *
 * RISK LEVEL: LOW-MEDIUM
 *   No BullMQ internals, retry config, or job option logic has changed.
 *   The payload field rename (s3Key → objectKey) is the only functional change.
 *
 * HIDDEN RUNTIME RISKS AVOIDED:
 *   EXISTING JOBS IN REDIS: Jobs enqueued before this deployment have
 *   `job.data.s3Key` (old field name). The updated video.worker.js reads
 *   BOTH `objectKey` (new) AND `s3Key` (legacy) from job.data and resolves
 *   to whichever is present. This ensures zero-downtime: old jobs queued
 *   before the deployment drain safely, new jobs use `objectKey`.
 *
 *   The jobId strategy (`transcode:<videoId>`) is preserved — it prevents
 *   duplicate FFmpeg jobs for the same video across restarts or retries.
 *
 * ROLLBACK STRATEGY:
 *   Rename `objectKey` back to `s3Key` in the function signature and the
 *   queue.add payload. Revert the same rename in video.service.js and
 *   video.worker.js. The queue name change is not needed for rollback.
 */

'use strict';

import { Queue } from 'bullmq';
import { createBullMQConnection } from '../config/redis.config.js';
import logger from '../utils/logger.js';

// STABLE — do not rename. Changing this orphans all existing Redis jobs.
const QUEUE_NAME = 'video-processing';

// Lazy-initialised queue instance (created on first enqueue, not at module load).
let videoQueue = null;
let videoQueueConnection = null;

function getVideoQueue() {
  if (videoQueue) return videoQueue;

  videoQueueConnection = createBullMQConnection('video-queue');
  videoQueue = new Queue(QUEUE_NAME, {
    connection: videoQueueConnection,
    defaultJobOptions: {
      // Retry up to 3 times with exponential backoff before moving to failed set.
      attempts: 3,
      backoff: {
        type:  'exponential',
        delay: 5000, // 5s → 10s → 20s
      },
      // Remove completed jobs after 24 hours to prevent Redis memory bloat.
      removeOnComplete: { age: 86400, count: 100 },
      // Keep failed jobs for 7 days for post-mortem debugging.
      removeOnFail: { age: 604800, count: 500 },
    },
  });

  videoQueue.on('error', (err) => {
    logger.error(`[VideoQueue] Queue error: ${err.message}`);
  });

  return videoQueue;
}

// ─── Job Helpers ──────────────────────────────────────────────────────────────

/**
 * enqueueVideoProcessing — Add a transcoding job for a newly uploaded video.
 *
 * PAYLOAD CHANGE from Phase 2:
 *   s3Key → objectKey (vendor-agnostic rename)
 *
 * The worker reads both `objectKey` and `s3Key` for backward compatibility
 * with jobs that were already in the Redis queue at the time of deployment.
 *
 * @param {object} payload
 * @param {string} payload.videoId    — MongoDB ObjectId string
 * @param {string} payload.objectKey  — R2 object key of the raw uploaded file
 *                                      (was s3Key in Phase 2)
 * @param {string} payload.mimeType   — MIME type of the raw upload
 */
async function enqueueVideoProcessing({ videoId, objectKey, mimeType }) {
  const queue = getVideoQueue();

  const job = await queue.add(
    'transcode',
    { videoId, objectKey, mimeType },
    {
      // Idempotency: using videoId as job ID prevents duplicate transcoding
      // jobs if the service crashes and restarts mid-upload handling.
      jobId:    `transcode:${videoId}`,
      priority: 1,
    }
  );

  logger.info(`[VideoQueue] Job enqueued: jobId=${job.id} videoId=${videoId}`);
  return job;
}

export {
getVideoQueue, enqueueVideoProcessing, QUEUE_NAME
};
