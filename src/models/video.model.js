/**
 * src/models/video.model.js — Video Schema  (Phase 2 Update)
 *
 * Changes from Phase 1:
 *   - uploadedBy: links video to its owner (User ObjectId)
 *   - status: tracks the async processing pipeline state
 *   - hlsUrl: CDN path to the master HLS playlist after transcoding
 *   - thumbnailUrl: now populated automatically by the FFmpeg worker
 *
 * All new fields are optional or have defaults → zero breaking changes
 * for documents written in Phase 1.
 */

'use strict';

import mongoose from 'mongoose';
const { Schema } = mongoose;

// ─── Processing Status Enum ───────────────────────────────────────────────────
// Tracks where the video is in the async FFmpeg pipeline.
const VIDEO_STATUS = Object.freeze({
  PENDING:    'pending',      // Upload received, job queued
  PROCESSING: 'processing',  // FFmpeg worker has picked up the job
  READY:      'ready',       // HLS output available — video is streamable
  FAILED:     'failed',      // Processing failed — see processingError field
});

// ─── Sub-schema: VideoMeta ────────────────────────────────────────────────────
const VideoMetaSchema = new Schema(
  {
    format:    { type: String, trim: true, default: null },
    sizeBytes: { type: Number, min: 0, default: null },
    mimeType:  { type: String, trim: true, default: null },
    // Phase 2 additions — populated by the FFmpeg worker post-processing
    duration:  { type: Number, min: 0, default: null },    // seconds
    width:     { type: Number, min: 0, default: null },    // pixels
    height:    { type: Number, min: 0, default: null },    // pixels
    bitrate:   { type: Number, min: 0, default: null },    // bps
  },
  { _id: false }
);

// ─── Root Schema ──────────────────────────────────────────────────────────────
const VideoSchema = new Schema(
  {
    title: {
      type: String,
      required: [true, 'Video title is required'],
      trim: true,
      maxlength: [200, 'Title must not exceed 200 characters'],
    },

    description: {
      type: String,
      trim: true,
      maxlength: [5000, 'Description must not exceed 5 000 characters'],
      default: '',
    },

    // Phase 2: This is now a full CloudFront / S3 URL (not a local path).
    // Phase 1 documents with local paths continue to work — the API
    // returns whatever is stored, so backward compat is maintained.
    videoUrl: {
      type: String,
      required: [true, 'Video URL is required'],
      trim: true,
    },

    // CloudFront URL to the HLS master playlist (e.g. /videos/<id>/master.m3u8)
    // Null until the FFmpeg worker sets it to 'ready'.
    hlsUrl: {
      type: String,
      trim: true,
      default: null,
    },

    thumbnailUrl: {
      type: String,
      trim: true,
      default: null,
    },

    meta: {
      type: VideoMetaSchema,
      default: () => ({}),
    },

    views: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ── Phase 2: Ownership ─────────────────────────────────────────────────
    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,    // null for Phase 1 legacy documents
      index: true,
    },

    // ── Phase 2: Processing Pipeline ───────────────────────────────────────
    status: {
      type: String,
      enum: Object.values(VIDEO_STATUS),
      default: VIDEO_STATUS.PENDING,
      index: true,
    },

    processingError: {
      type: String,
      default: null,
    },

    // S3 key of the raw uploaded file (needed for the FFmpeg worker to locate it)
    s3Key: {
      type: String,
      default: null,
      select: false,    // Internal field — not exposed in API responses
    },

    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform: (_doc, ret) => {
        delete ret._id;
        delete ret.isDeleted;
        delete ret.s3Key;           // Never expose internal S3 keys
        delete ret.processingError; // Expose only via admin endpoints
      },
    },
    toObject: { virtuals: true },
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
VideoSchema.index({ title: 'text', description: 'text' });
VideoSchema.index({ isDeleted: 1, createdAt: -1 });
VideoSchema.index({ isDeleted: 1, uploadedBy: 1, createdAt: -1 }); // "my videos" queries

// ─── Pre-hooks ────────────────────────────────────────────────────────────────
VideoSchema.pre(/^find/, function (next) {
  if (!this.getFilter().hasOwnProperty('isDeleted')) {
    this.where({ isDeleted: false });
  }
  next();
});

VideoSchema.pre('countDocuments', function (next) {
  if (!this.getFilter().hasOwnProperty('isDeleted')) {
    this.where({ isDeleted: false });
  }
  next();
});

// ─── Virtual ─────────────────────────────────────────────────────────────────
VideoSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

// Export status enum so other modules don't hardcode strings
VideoSchema.statics.STATUS = VIDEO_STATUS;

const VideoModel = mongoose.model('Video', VideoSchema);

export default VideoModel;
