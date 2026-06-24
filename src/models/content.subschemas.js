'use strict';

import mongoose from 'mongoose';
import { isOptionalUrl } from '../utils/validation.js';

const { Schema } = mongoose;

const MediaAssetSchema = new Schema(
  {
    key: {
      type: String,
      trim: true,
      maxlength: [512, 'Asset key must not exceed 512 characters'],
      default: null,
    },
    url: {
      type: String,
      trim: true,
      maxlength: [2048, 'Asset URL must not exceed 2048 characters'],
      validate: {
        validator: isOptionalUrl,
        message: 'Asset URL must be a valid HTTP or HTTPS URL',
      },
      default: null,
    },
    alt: {
      type: String,
      trim: true,
      maxlength: [200, 'Asset alt text must not exceed 200 characters'],
      default: null,
    },
  },
  { _id: false },
);

const AudioTrackSchema = new Schema(
  {
    language: {
      type: String,
      required: [true, 'Audio track language is required'],
      trim: true,
      maxlength: [50, 'Audio track language must not exceed 50 characters'],
    },
    label: {
      type: String,
      trim: true,
      maxlength: [100, 'Audio track label must not exceed 100 characters'],
      default: null,
    },
    codec: {
      type: String,
      trim: true,
      maxlength: [30, 'Audio track codec must not exceed 30 characters'],
      default: null,
    },
    channels: {
      type: Number,
      min: [1, 'Audio channels must be at least 1'],
      max: [16, 'Audio channels must not exceed 16'],
      default: null,
    },
    default: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false },
);

const SubtitleTrackSchema = new Schema(
  {
    language: {
      type: String,
      required: [true, 'Subtitle track language is required'],
      trim: true,
      maxlength: [50, 'Subtitle track language must not exceed 50 characters'],
    },
    label: {
      type: String,
      trim: true,
      maxlength: [100, 'Subtitle track label must not exceed 100 characters'],
      default: null,
    },
    format: {
      type: String,
      enum: ['vtt', 'srt', 'ass', 'ssa', 'unknown'],
      default: 'unknown',
    },
    kind: {
      type: String,
      enum: ['subtitles', 'captions', 'forced'],
      default: 'subtitles',
    },
    default: {
      type: Boolean,
      default: false,
    },
    forced: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false },
);

export {
  AudioTrackSchema,
  MediaAssetSchema,
  SubtitleTrackSchema,
};
