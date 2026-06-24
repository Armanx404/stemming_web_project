'use strict';

const CONTENT_STATUS_VALUES = Object.freeze([
  'draft',
  'scheduled',
  'published',
  'archived',
]);

const ANIME_TYPE_VALUES = Object.freeze([
  'series',
  'movie',
  'ova',
  'ona',
  'special',
]);

const RELEASE_STATUS_VALUES = Object.freeze([
  'upcoming',
  'airing',
  'completed',
  'hiatus',
  'cancelled',
]);

const CONTENT_RATING_VALUES = Object.freeze([
  'G',
  'PG',
  'PG-13',
  'R',
  'R+',
  'NC-17',
  'unrated',
]);

const SEASON_NAME_VALUES = Object.freeze([
  'winter',
  'spring',
  'summer',
  'fall',
  'unknown',
]);

const EPISODE_PROCESSING_STATUS_VALUES = Object.freeze([
  'not_uploaded',
  'uploaded',
  'queued',
  'processing',
  'ready',
  'failed',
]);

export {
  ANIME_TYPE_VALUES,
  CONTENT_RATING_VALUES,
  CONTENT_STATUS_VALUES,
  EPISODE_PROCESSING_STATUS_VALUES,
  RELEASE_STATUS_VALUES,
  SEASON_NAME_VALUES,
};
