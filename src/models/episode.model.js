'use strict';

import mongoose from 'mongoose';
import {
  CONTENT_STATUS_VALUES,
  EPISODE_PROCESSING_STATUS_VALUES,
} from './content.enums.js';
import {
  AudioTrackSchema,
  MediaAssetSchema,
  SubtitleTrackSchema,
} from './content.subschemas.js';
import softDeletePlugin from './softDelete.plugin.js';
import { createSlugFromTitle, normalizeSlug } from '../utils/slug.js';
import {
  isBoundedArray,
  isPositiveInteger,
} from '../utils/validation.js';

const { Schema } = mongoose;

const MAX_AUDIO_TRACKS = 10;
const MAX_SUBTITLE_TRACKS = 20;

const EpisodeSchema = new Schema(
  {
    animeId: {
      type: Schema.Types.ObjectId,
      ref: 'Anime',
      required: [true, 'Anime id is required'],
      index: true,
    },
    seasonId: {
      type: Schema.Types.ObjectId,
      ref: 'Season',
      required: [true, 'Season id is required'],
      index: true,
    },
    episodeNumber: {
      type: Number,
      required: [true, 'Episode number is required'],
      min: [1, 'Episode number must be positive'],
      validate: {
        validator: isPositiveInteger,
        message: 'Episode number must be a positive integer',
      },
    },
    absoluteEpisodeNumber: {
      type: Number,
      default: null,
      min: [1, 'Absolute episode number must be positive'],
      validate: {
        validator(value) {
          return value === null || value === undefined || isPositiveInteger(value);
        },
        message: 'Absolute episode number must be a positive integer',
      },
    },
    title: {
      type: String,
      required: [true, 'Episode title is required'],
      trim: true,
      maxlength: [200, 'Episode title must not exceed 200 characters'],
    },
    slug: {
      type: String,
      required: [true, 'Episode slug is required'],
      trim: true,
      lowercase: true,
      maxlength: [140, 'Slug must not exceed 140 characters'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [5000, 'Description must not exceed 5000 characters'],
      default: '',
    },
    thumbnail: {
      type: MediaAssetSchema,
      default: null,
    },
    duration: {
      type: Number,
      default: null,
      min: [0, 'Duration cannot be negative'],
      max: [86400, 'Duration must not exceed 86400 seconds'],
    },
    releaseDate: {
      type: Date,
      default: null,
    },
    airDate: {
      type: Date,
      default: null,
    },
    status: {
      type: String,
      enum: CONTENT_STATUS_VALUES,
      default: 'draft',
      index: true,
    },
    published: {
      type: Boolean,
      default: false,
      index: true,
    },
    publishedAt: {
      type: Date,
      default: null,
    },
    subAvailable: {
      type: Boolean,
      default: false,
    },
    dubAvailable: {
      type: Boolean,
      default: false,
    },
    audioTracks: {
      type: [AudioTrackSchema],
      default: [],
      validate: {
        validator(value) {
          return isBoundedArray(value, { max: MAX_AUDIO_TRACKS });
        },
        message: `Audio tracks must not exceed ${MAX_AUDIO_TRACKS} entries`,
      },
    },
    subtitleTracks: {
      type: [SubtitleTrackSchema],
      default: [],
      validate: {
        validator(value) {
          return isBoundedArray(value, { max: MAX_SUBTITLE_TRACKS });
        },
        message: `Subtitle tracks must not exceed ${MAX_SUBTITLE_TRACKS} entries`,
      },
    },
    videoId: {
      type: Schema.Types.ObjectId,
      ref: 'Video',
      default: null,
      index: true,
    },
    processingStatus: {
      type: String,
      enum: EPISODE_PROCESSING_STATUS_VALUES,
      default: 'not_uploaded',
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform: (_doc, ret) => {
        delete ret._id;
        delete ret.deletedAt;
        return ret;
      },
    },
    toObject: { virtuals: true },
  },
);

EpisodeSchema.plugin(softDeletePlugin);

EpisodeSchema.index(
  { seasonId: 1, episodeNumber: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
EpisodeSchema.index({ animeId: 1, seasonId: 1, deletedAt: 1, episodeNumber: 1 });
EpisodeSchema.index({ animeId: 1, absoluteEpisodeNumber: 1, deletedAt: 1 });
EpisodeSchema.index({ status: 1, published: 1, deletedAt: 1 });
EpisodeSchema.index({ processingStatus: 1, deletedAt: 1 });
EpisodeSchema.index({ videoId: 1, deletedAt: 1 });

EpisodeSchema.pre('validate', function normalizeEpisodeBeforeValidation(next) {
  try {
    if (this.isNew && (this.slug === undefined || this.slug === null) && typeof this.title === 'string') {
      this.slug = createSlugFromTitle(this.title);
    } else if (this.isModified('slug')) {
      this.slug = normalizeSlug(this.slug);
    }

    if (this.published && !this.publishedAt) {
      this.publishedAt = new Date();
    }

    if (this.videoId && this.processingStatus === 'not_uploaded') {
      this.processingStatus = 'uploaded';
    }

    next();
  } catch (err) {
    next(err);
  }
});

EpisodeSchema.virtual('id').get(function getEpisodeId() {
  return this._id.toHexString();
});

EpisodeSchema.statics.PROCESSING_STATUSES = EPISODE_PROCESSING_STATUS_VALUES;
EpisodeSchema.statics.STATUSES = CONTENT_STATUS_VALUES;

const EpisodeModel = mongoose.model('Episode', EpisodeSchema);

export default EpisodeModel;
