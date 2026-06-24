'use strict';

import mongoose from 'mongoose';
import { CONTENT_STATUS_VALUES } from './content.enums.js';
import { MediaAssetSchema } from './content.subschemas.js';
import softDeletePlugin from './softDelete.plugin.js';
import { createSlugFromTitle, normalizeSlug } from '../utils/slug.js';
import {
  isDateOrderValid,
  isNonNegativeInteger,
  isPositiveInteger,
} from '../utils/validation.js';

const { Schema } = mongoose;

const SeasonSchema = new Schema(
  {
    animeId: {
      type: Schema.Types.ObjectId,
      ref: 'Anime',
      required: [true, 'Anime id is required'],
      index: true,
    },
    seasonNumber: {
      type: Number,
      required: [true, 'Season number is required'],
      min: [1, 'Season number must be positive'],
      validate: {
        validator: isPositiveInteger,
        message: 'Season number must be a positive integer',
      },
    },
    title: {
      type: String,
      required: [true, 'Season title is required'],
      trim: true,
      maxlength: [200, 'Season title must not exceed 200 characters'],
    },
    slug: {
      type: String,
      required: [true, 'Season slug is required'],
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
    poster: {
      type: MediaAssetSchema,
      default: null,
    },
    releaseDate: {
      type: Date,
      default: null,
    },
    endDate: {
      type: Date,
      default: null,
      validate: {
        validator(value) {
          return isDateOrderValid(this.releaseDate, value);
        },
        message: 'End date must be on or after release date',
      },
    },
    episodeCount: {
      type: Number,
      default: 0,
      min: [0, 'Episode count cannot be negative'],
      validate: {
        validator: isNonNegativeInteger,
        message: 'Episode count must be a non-negative integer',
      },
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

SeasonSchema.plugin(softDeletePlugin);

SeasonSchema.index(
  { animeId: 1, seasonNumber: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
SeasonSchema.index(
  { animeId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
SeasonSchema.index({ animeId: 1, published: 1, deletedAt: 1, seasonNumber: 1 });
SeasonSchema.index({ status: 1, published: 1, deletedAt: 1 });

SeasonSchema.pre('validate', function normalizeSeasonBeforeValidation(next) {
  try {
    if (this.isNew && (this.slug === undefined || this.slug === null) && typeof this.title === 'string') {
      this.slug = createSlugFromTitle(this.title);
    } else if (this.isModified('slug')) {
      this.slug = normalizeSlug(this.slug);
    }

    if (this.published && !this.publishedAt) {
      this.publishedAt = new Date();
    }

    next();
  } catch (err) {
    next(err);
  }
});

SeasonSchema.virtual('id').get(function getSeasonId() {
  return this._id.toHexString();
});

SeasonSchema.statics.STATUSES = CONTENT_STATUS_VALUES;

const SeasonModel = mongoose.model('Season', SeasonSchema);

export default SeasonModel;
