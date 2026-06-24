'use strict';

import mongoose from 'mongoose';
import {
  ANIME_TYPE_VALUES,
  CONTENT_RATING_VALUES,
  CONTENT_STATUS_VALUES,
  RELEASE_STATUS_VALUES,
  SEASON_NAME_VALUES,
} from './content.enums.js';
import { MediaAssetSchema } from './content.subschemas.js';
import softDeletePlugin from './softDelete.plugin.js';
import { createSlugFromTitle, normalizeSlug } from '../utils/slug.js';
import {
  isBoundedArray,
  isDateOrderValid,
  isNonNegativeInteger,
  isOptionalUrl,
} from '../utils/validation.js';

const { Schema } = mongoose;

const MAX_TAGS = 25;
const MAX_NAMES = 20;
const RELEASE_YEAR_MIN = 1900;
const RELEASE_YEAR_MAX = 2100;

function nonEmptyStringArray(max) {
  return {
    validator(value) {
      return isBoundedArray(value, {
        max,
        itemValidator: (item) => typeof item === 'string' && item.trim().length > 0,
      });
    },
    message: `Array must contain no more than ${max} non-empty strings`,
  };
}

function optionalReleaseYear(value) {
  return (
    value === null ||
    value === undefined ||
    (
      Number.isInteger(value) &&
      value >= RELEASE_YEAR_MIN &&
      value <= RELEASE_YEAR_MAX
    )
  );
}

const AnimeSchema = new Schema(
  {
    title: {
      type: String,
      required: [true, 'Anime title is required'],
      trim: true,
      maxlength: [200, 'Title must not exceed 200 characters'],
    },
    englishTitle: {
      type: String,
      trim: true,
      maxlength: [200, 'English title must not exceed 200 characters'],
      default: null,
    },
    japaneseTitle: {
      type: String,
      trim: true,
      maxlength: [200, 'Japanese title must not exceed 200 characters'],
      default: null,
    },
    alternativeTitles: {
      type: [{
        type: String,
        trim: true,
        maxlength: [200, 'Alternative title must not exceed 200 characters'],
      }],
      default: [],
      validate: nonEmptyStringArray(MAX_NAMES),
    },
    slug: {
      type: String,
      required: [true, 'Anime slug is required'],
      trim: true,
      lowercase: true,
      maxlength: [140, 'Slug must not exceed 140 characters'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [10000, 'Description must not exceed 10000 characters'],
      default: '',
    },
    shortDescription: {
      type: String,
      trim: true,
      maxlength: [500, 'Short description must not exceed 500 characters'],
      default: '',
    },
    type: {
      type: String,
      enum: ANIME_TYPE_VALUES,
      default: 'series',
      index: true,
    },
    status: {
      type: String,
      enum: CONTENT_STATUS_VALUES,
      default: 'draft',
      index: true,
    },
    releaseStatus: {
      type: String,
      enum: RELEASE_STATUS_VALUES,
      default: 'upcoming',
      index: true,
    },
    contentRating: {
      type: String,
      enum: CONTENT_RATING_VALUES,
      default: 'unrated',
    },
    genres: {
      type: [{
        type: String,
        trim: true,
        maxlength: [60, 'Genre must not exceed 60 characters'],
      }],
      default: [],
      validate: nonEmptyStringArray(MAX_TAGS),
    },
    studios: {
      type: [{
        type: String,
        trim: true,
        maxlength: [120, 'Studio must not exceed 120 characters'],
      }],
      default: [],
      validate: nonEmptyStringArray(MAX_NAMES),
    },
    producers: {
      type: [{
        type: String,
        trim: true,
        maxlength: [120, 'Producer must not exceed 120 characters'],
      }],
      default: [],
      validate: nonEmptyStringArray(MAX_NAMES),
    },
    languages: {
      type: [{
        type: String,
        trim: true,
        maxlength: [50, 'Language must not exceed 50 characters'],
      }],
      default: [],
      validate: nonEmptyStringArray(MAX_NAMES),
    },
    originalLanguage: {
      type: String,
      trim: true,
      maxlength: [50, 'Original language must not exceed 50 characters'],
      default: null,
    },
    countryOfOrigin: {
      type: String,
      trim: true,
      maxlength: [80, 'Country of origin must not exceed 80 characters'],
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
    releaseYear: {
      type: Number,
      default: null,
      validate: {
        validator: optionalReleaseYear,
        message: `Release year must be an integer from ${RELEASE_YEAR_MIN} to ${RELEASE_YEAR_MAX}`,
      },
      index: true,
    },
    seasonName: {
      type: String,
      enum: SEASON_NAME_VALUES,
      default: 'unknown',
    },
    poster: {
      type: MediaAssetSchema,
      default: null,
    },
    banner: {
      type: MediaAssetSchema,
      default: null,
    },
    trailerUrl: {
      type: String,
      trim: true,
      maxlength: [2048, 'Trailer URL must not exceed 2048 characters'],
      validate: {
        validator: isOptionalUrl,
        message: 'Trailer URL must be a valid HTTP or HTTPS URL',
      },
      default: null,
    },
    primaryVideoId: {
      type: Schema.Types.ObjectId,
      ref: 'Video',
      default: null,
      index: true,
    },
    totalSeasons: {
      type: Number,
      default: 0,
      min: [0, 'Total seasons cannot be negative'],
      validate: {
        validator: isNonNegativeInteger,
        message: 'Total seasons must be a non-negative integer',
      },
    },
    totalEpisodes: {
      type: Number,
      default: 0,
      min: [0, 'Total episodes cannot be negative'],
      validate: {
        validator: isNonNegativeInteger,
        message: 'Total episodes must be a non-negative integer',
      },
    },
    averageEpisodeDuration: {
      type: Number,
      default: 0,
      min: [0, 'Average episode duration cannot be negative'],
      max: [86400, 'Average episode duration must not exceed 86400 seconds'],
    },
    subAvailable: {
      type: Boolean,
      default: false,
    },
    dubAvailable: {
      type: Boolean,
      default: false,
    },
    featured: {
      type: Boolean,
      default: false,
      index: true,
    },
    trending: {
      type: Boolean,
      default: false,
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
    views: {
      type: Number,
      default: 0,
      min: [0, 'Views cannot be negative'],
      validate: {
        validator: isNonNegativeInteger,
        message: 'Views must be a non-negative integer',
      },
    },
    watchCount: {
      type: Number,
      default: 0,
      min: [0, 'Watch count cannot be negative'],
      validate: {
        validator: isNonNegativeInteger,
        message: 'Watch count must be a non-negative integer',
      },
    },
    ratingAverage: {
      type: Number,
      default: 0,
      min: [0, 'Rating average cannot be negative'],
      max: [10, 'Rating average must not exceed 10'],
    },
    ratingCount: {
      type: Number,
      default: 0,
      min: [0, 'Rating count cannot be negative'],
      validate: {
        validator: isNonNegativeInteger,
        message: 'Rating count must be a non-negative integer',
      },
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

AnimeSchema.plugin(softDeletePlugin);

AnimeSchema.index(
  { slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
AnimeSchema.index({
  title: 'text',
  englishTitle: 'text',
  japaneseTitle: 'text',
  alternativeTitles: 'text',
  description: 'text',
  genres: 'text',
});
AnimeSchema.index({ type: 1, published: 1, deletedAt: 1, releaseYear: -1 });
AnimeSchema.index({ status: 1, published: 1, deletedAt: 1 });
AnimeSchema.index({ releaseStatus: 1, published: 1, deletedAt: 1 });
AnimeSchema.index({ releaseYear: -1, deletedAt: 1 });
AnimeSchema.index({ featured: 1, published: 1, deletedAt: 1 });
AnimeSchema.index({ trending: 1, published: 1, deletedAt: 1 });

AnimeSchema.pre('validate', function normalizeAnimeBeforeValidation(next) {
  try {
    if (this.isNew && (this.slug === undefined || this.slug === null) && typeof this.title === 'string') {
      this.slug = createSlugFromTitle(this.title);
    } else if (this.isModified('slug')) {
      this.slug = normalizeSlug(this.slug);
    }

    if (!this.releaseYear && this.releaseDate) {
      this.releaseYear = this.releaseDate.getUTCFullYear();
    }

    if (this.published && !this.publishedAt) {
      this.publishedAt = new Date();
    }

    next();
  } catch (err) {
    next(err);
  }
});

AnimeSchema.virtual('id').get(function getAnimeId() {
  return this._id.toHexString();
});

AnimeSchema.statics.TYPES = ANIME_TYPE_VALUES;
AnimeSchema.statics.STATUSES = CONTENT_STATUS_VALUES;
AnimeSchema.statics.RELEASE_STATUSES = RELEASE_STATUS_VALUES;

const AnimeModel = mongoose.model('Anime', AnimeSchema);

export default AnimeModel;
