'use strict';

import { StatusCodes } from 'http-status-codes';
import AnimeModel from '../models/anime.model.js';
import VideoModel from '../models/video.model.js';
import {
  ANIME_TYPE_VALUES,
  CONTENT_RATING_VALUES,
  CONTENT_STATUS_VALUES,
  RELEASE_STATUS_VALUES,
  SEASON_NAME_VALUES,
} from '../models/content.enums.js';
import { createSlugFromTitle, normalizeSlug } from '../utils/slug.js';
import {
  isDateOrderValid,
  isOptionalUrl,
  isValidObjectId,
  normalizeSafeString,
} from '../utils/validation.js';
import {
  buildPaginationMetadata,
  buildSearchRegex,
  escapeRegexString,
  parsePagination,
} from '../utils/pagination.js';

const RELEASE_YEAR_MIN = 1900;
const RELEASE_YEAR_MAX = 2100;
const MAX_ALT_TITLES = 20;
const MAX_TAGS = 25;
const MAX_NAMES = 20;

const CREATE_ALLOWED_FIELDS = Object.freeze([
  'title',
  'englishTitle',
  'japaneseTitle',
  'alternativeTitles',
  'slug',
  'description',
  'shortDescription',
  'type',
  'status',
  'releaseStatus',
  'contentRating',
  'genres',
  'studios',
  'producers',
  'languages',
  'originalLanguage',
  'countryOfOrigin',
  'releaseDate',
  'endDate',
  'releaseYear',
  'seasonName',
  'poster',
  'banner',
  'trailerUrl',
  'primaryVideoId',
  'averageEpisodeDuration',
  'subAvailable',
  'dubAvailable',
  'featured',
  'trending',
]);

const UPDATE_ALLOWED_FIELDS = Object.freeze([...CREATE_ALLOWED_FIELDS]);

const CREATE_ALLOWED_FIELD_SET = new Set(CREATE_ALLOWED_FIELDS);
const UPDATE_ALLOWED_FIELD_SET = new Set(UPDATE_ALLOWED_FIELDS);

const FORBIDDEN_FIELDS = new Set([
  '_id',
  'id',
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'published',
  'publishedAt',
  'views',
  'watchCount',
  'ratingAverage',
  'ratingCount',
  'totalSeasons',
  'totalEpisodes',
  'role',
]);

const MEDIA_ASSET_ALLOWED_FIELDS = new Set(['key', 'url', 'alt']);

const SORT_OPTIONS = Object.freeze({
  latest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  title: { title: 1 },
  'release-year': { releaseYear: -1, createdAt: -1 },
  'most-watched': { watchCount: -1, views: -1 },
  trending: { trending: -1, watchCount: -1, createdAt: -1 },
  rating: { ratingAverage: -1, ratingCount: -1 },
  'recently-updated': { updatedAt: -1 },
});

function httpError(message, statusCode = StatusCodes.BAD_REQUEST) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function getScalarQueryValue(value) {
  if (Array.isArray(value)) return getScalarQueryValue(value[0]);
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object') return undefined;
  return value;
}

function assertNoUnsafeKeys(value, path = 'body') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnsafeKeys(item, `${path}[${index}]`));
    return;
  }

  if (!isPlainObject(value)) return;

  for (const [key, entryValue] of Object.entries(value)) {
    if (
      key.startsWith('$') ||
      key.includes('.') ||
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype'
    ) {
      throw httpError(`Unsafe field "${path}.${key}" is not allowed.`);
    }

    assertNoUnsafeKeys(entryValue, `${path}.${key}`);
  }
}

function assertAllowedTopLevelFields(input, allowedFields) {
  for (const field of Object.keys(input)) {
    if (FORBIDDEN_FIELDS.has(field)) {
      throw httpError(`Field "${field}" cannot be set directly.`);
    }

    if (!allowedFields.has(field)) {
      throw httpError(`Field "${field}" is not allowed.`);
    }
  }
}

function optionalString(value, field, options = {}) {
  if (value === null || value === undefined) return value ?? null;
  return normalizeSafeString(value, {
    field,
    allowEmpty: true,
    ...options,
  });
}

function requiredString(value, field, options = {}) {
  if (value === null || value === undefined) {
    throw httpError(`${field} is required.`);
  }

  return normalizeSafeString(value, {
    field,
    allowEmpty: false,
    ...options,
  });
}

function optionalEnum(value, field, allowedValues) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value !== 'string' || !allowedValues.includes(value)) {
    throw httpError(`${field} must be one of: ${allowedValues.join(', ')}.`);
  }
  return value;
}

function optionalBoolean(value, field) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value !== 'boolean') {
    throw httpError(`${field} must be a boolean.`);
  }
  return value;
}

function optionalNonNegativeNumber(value, field, { max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    throw httpError(`${field} must be a number from 0 to ${max}.`);
  }
  return value;
}

function optionalReleaseYear(value) {
  if (value === null || value === undefined) return value ?? null;
  if (
    !Number.isInteger(value) ||
    value < RELEASE_YEAR_MIN ||
    value > RELEASE_YEAR_MAX
  ) {
    throw httpError(`releaseYear must be an integer from ${RELEASE_YEAR_MIN} to ${RELEASE_YEAR_MAX}.`);
  }
  return value;
}

function parseQueryEnum(query, field, allowedValues) {
  const value = getScalarQueryValue(query[field]);
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !allowedValues.includes(value)) {
    throw httpError(`${field} must be one of: ${allowedValues.join(', ')}.`);
  }
  return value;
}

function parseQueryBoolean(query, field) {
  const value = getScalarQueryValue(query[field]);
  if (value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') {
    throw httpError(`${field} must be true or false.`);
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw httpError(`${field} must be true or false.`);
}

function parseQueryYear(query, field) {
  const value = getScalarQueryValue(query[field]);
  if (value === undefined || value === '') return null;
  const normalized = typeof value === 'string' ? value.trim() : value;
  const parsed = typeof normalized === 'number' ? normalized : Number.parseInt(normalized, 10);

  if (
    !Number.isInteger(parsed) ||
    String(parsed) !== String(normalized) ||
    parsed < RELEASE_YEAR_MIN ||
    parsed > RELEASE_YEAR_MAX
  ) {
    throw httpError(`${field} must be an integer from ${RELEASE_YEAR_MIN} to ${RELEASE_YEAR_MAX}.`);
  }

  return parsed;
}

function parseSortOption(query = {}) {
  const rawSort = getScalarQueryValue(query.sort);
  if (rawSort === undefined || rawSort === '') return SORT_OPTIONS.latest;
  if (typeof rawSort !== 'string' || !SORT_OPTIONS[rawSort]) {
    throw httpError(`sort must be one of: ${Object.keys(SORT_OPTIONS).join(', ')}.`);
  }

  return SORT_OPTIONS[rawSort];
}

function optionalDate(value, field) {
  if (value === null || value === undefined || value === '') return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw httpError(`${field} must be a valid date.`);
  }

  return date;
}

function optionalUrl(value, field) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !isOptionalUrl(value)) {
    throw httpError(`${field} must be a valid HTTP or HTTPS URL.`);
  }
  return value.trim();
}

function stringArray(value, field, { max, maxLength }) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw httpError(`${field} must be an array.`);
  }
  if (value.length > max) {
    throw httpError(`${field} must contain no more than ${max} items.`);
  }

  const seen = new Set();
  return value.map((item, index) => {
    const normalized = requiredString(item, `${field}[${index}]`, { maxLength });
    const duplicateKey = normalized.toLowerCase();
    if (seen.has(duplicateKey)) {
      throw httpError(`${field} contains duplicate value "${normalized}".`);
    }
    seen.add(duplicateKey);
    return normalized;
  });
}

function optionalMediaAsset(value, field) {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) {
    throw httpError(`${field} must be an object.`);
  }

  for (const key of Object.keys(value)) {
    if (!MEDIA_ASSET_ALLOWED_FIELDS.has(key)) {
      throw httpError(`${field}.${key} is not allowed.`);
    }
  }

  return {
    key: optionalString(value.key, `${field}.key`, { maxLength: 512 }),
    url: optionalUrl(value.url, `${field}.url`),
    alt: optionalString(value.alt, `${field}.alt`, { maxLength: 200 }),
  };
}

function normalizeSlugInput({ slug, title }) {
  try {
    return slug === undefined || slug === null
      ? createSlugFromTitle(title)
      : normalizeSlug(slug);
  } catch (err) {
    throw httpError(err.message);
  }
}

function assignOptionalField(input, output, field, normalizer) {
  if (hasOwn(input, field)) {
    output[field] = normalizer(input[field], field);
  }
}

function assignCommonAnimeFields(input, normalized, { requireTitle = false } = {}) {
  if (requireTitle || hasOwn(input, 'title')) {
    normalized.title = requiredString(input.title, 'title', { maxLength: 200 });
  }

  assignOptionalField(input, normalized, 'englishTitle', (value, field) => (
    optionalString(value, field, { maxLength: 200 })
  ));
  assignOptionalField(input, normalized, 'japaneseTitle', (value, field) => (
    optionalString(value, field, { maxLength: 200 })
  ));

  if (hasOwn(input, 'alternativeTitles')) {
    normalized.alternativeTitles = stringArray(input.alternativeTitles, 'alternativeTitles', {
      max: MAX_ALT_TITLES,
      maxLength: 200,
    });
  }
  if (hasOwn(input, 'description')) {
    normalized.description = optionalString(input.description, 'description', { maxLength: 10000 }) ?? '';
  }
  if (hasOwn(input, 'shortDescription')) {
    normalized.shortDescription = optionalString(input.shortDescription, 'shortDescription', { maxLength: 500 }) ?? '';
  }
  if (hasOwn(input, 'type')) {
    normalized.type = optionalEnum(input.type, 'type', ANIME_TYPE_VALUES) ?? 'series';
  }
  if (hasOwn(input, 'status')) {
    normalized.status = optionalEnum(input.status, 'status', CONTENT_STATUS_VALUES) ?? 'draft';
    if (normalized.status === 'published') {
      throw httpError('Use the publish endpoint to publish Anime.');
    }
  }
  if (hasOwn(input, 'releaseStatus')) {
    normalized.releaseStatus = optionalEnum(input.releaseStatus, 'releaseStatus', RELEASE_STATUS_VALUES) ?? 'upcoming';
  }
  if (hasOwn(input, 'contentRating')) {
    normalized.contentRating = optionalEnum(input.contentRating, 'contentRating', CONTENT_RATING_VALUES) ?? 'unrated';
  }
  if (hasOwn(input, 'genres')) {
    normalized.genres = stringArray(input.genres, 'genres', { max: MAX_TAGS, maxLength: 60 });
  }
  if (hasOwn(input, 'studios')) {
    normalized.studios = stringArray(input.studios, 'studios', { max: MAX_NAMES, maxLength: 120 });
  }
  if (hasOwn(input, 'producers')) {
    normalized.producers = stringArray(input.producers, 'producers', { max: MAX_NAMES, maxLength: 120 });
  }
  if (hasOwn(input, 'languages')) {
    normalized.languages = stringArray(input.languages, 'languages', { max: MAX_NAMES, maxLength: 50 });
  }
  assignOptionalField(input, normalized, 'originalLanguage', (value, field) => (
    optionalString(value, field, { maxLength: 50 })
  ));
  assignOptionalField(input, normalized, 'countryOfOrigin', (value, field) => (
    optionalString(value, field, { maxLength: 80 })
  ));
  if (hasOwn(input, 'releaseDate')) {
    normalized.releaseDate = optionalDate(input.releaseDate, 'releaseDate');
  }
  if (hasOwn(input, 'endDate')) {
    normalized.endDate = optionalDate(input.endDate, 'endDate');
  }
  if (hasOwn(input, 'releaseYear')) {
    normalized.releaseYear = optionalReleaseYear(input.releaseYear);
  }
  if (hasOwn(input, 'seasonName')) {
    normalized.seasonName = optionalEnum(input.seasonName, 'seasonName', SEASON_NAME_VALUES) ?? 'unknown';
  }
  if (hasOwn(input, 'poster')) {
    normalized.poster = optionalMediaAsset(input.poster, 'poster');
  }
  if (hasOwn(input, 'banner')) {
    normalized.banner = optionalMediaAsset(input.banner, 'banner');
  }
  if (hasOwn(input, 'trailerUrl')) {
    normalized.trailerUrl = optionalUrl(input.trailerUrl, 'trailerUrl');
  }
  if (hasOwn(input, 'primaryVideoId')) {
    normalized.primaryVideoId = input.primaryVideoId;
  }
  if (hasOwn(input, 'averageEpisodeDuration')) {
    normalized.averageEpisodeDuration = optionalNonNegativeNumber(
      input.averageEpisodeDuration,
      'averageEpisodeDuration',
      { max: 86400 },
    );
  }
  for (const field of ['subAvailable', 'dubAvailable', 'featured', 'trending']) {
    if (hasOwn(input, field)) {
      normalized[field] = optionalBoolean(input[field], field);
    }
  }
}

function validateDateRelationship({ releaseDate, endDate }) {
  if (!isDateOrderValid(releaseDate, endDate)) {
    throw httpError('endDate must be on or after releaseDate.');
  }
}

function normalizeAnimeCreateInput(input) {
  if (!isPlainObject(input)) {
    throw httpError('Request body must be a JSON object.');
  }

  assertNoUnsafeKeys(input);
  assertAllowedTopLevelFields(input, CREATE_ALLOWED_FIELD_SET);

  const normalized = {};
  assignCommonAnimeFields(input, normalized, { requireTitle: true });
  normalized.slug = normalizeSlugInput({ slug: input.slug, title: normalized.title });
  normalized.type = normalized.type ?? 'series';
  validateDateRelationship({
    releaseDate: normalized.releaseDate,
    endDate: normalized.endDate,
  });

  return normalized;
}

function normalizeAnimeUpdateInput(input, existingAnime) {
  if (!isPlainObject(input)) {
    throw httpError('Request body must be a JSON object.');
  }

  assertNoUnsafeKeys(input);
  assertAllowedTopLevelFields(input, UPDATE_ALLOWED_FIELD_SET);

  if (Object.keys(input).length === 0) {
    throw httpError('At least one allowed field is required for update.');
  }

  const normalized = {};
  assignCommonAnimeFields(input, normalized);

  if (hasOwn(input, 'slug')) {
    normalized.slug = normalizeSlugInput({ slug: input.slug, title: existingAnime.title });
  }

  const candidateReleaseDate = hasOwn(normalized, 'releaseDate')
    ? normalized.releaseDate
    : existingAnime.releaseDate;
  const candidateEndDate = hasOwn(normalized, 'endDate')
    ? normalized.endDate
    : existingAnime.endDate;

  validateDateRelationship({
    releaseDate: candidateReleaseDate,
    endDate: candidateEndDate,
  });

  if (Object.keys(normalized).length === 0) {
    throw httpError('At least one allowed field is required for update.');
  }

  return normalized;
}

async function assertActiveSlugAvailable(slug, excludeId = null) {
  const filter = { slug };
  if (excludeId) {
    filter._id = { $ne: excludeId };
  }

  const existing = await AnimeModel.exists(filter);
  if (existing) {
    throw httpError(`Anime slug "${slug}" is already in use.`, StatusCodes.CONFLICT);
  }
}

function normalizePrimaryVideoValue(value) {
  if (value === null || value === undefined || value === '') return null;
  return value;
}

async function assertPrimaryVideoExists(primaryVideoId) {
  if (!isValidObjectId(primaryVideoId)) {
    throw httpError('primaryVideoId must be a valid ObjectId.');
  }

  const video = await VideoModel.exists({ _id: primaryVideoId });
  if (!video) {
    throw httpError('Referenced primary video was not found.', StatusCodes.NOT_FOUND);
  }
}

async function validatePrimaryVideoForCreate(payload) {
  payload.primaryVideoId = normalizePrimaryVideoValue(payload.primaryVideoId);
  if (!payload.primaryVideoId) return;

  if (payload.type !== 'movie') {
    throw httpError('primaryVideoId may only be set for movie Anime.');
  }

  await assertPrimaryVideoExists(payload.primaryVideoId);
}

async function validatePrimaryVideoForUpdate(payload, existingAnime) {
  const candidateType = hasOwn(payload, 'type') ? payload.type : existingAnime.type;

  if (hasOwn(payload, 'primaryVideoId')) {
    payload.primaryVideoId = normalizePrimaryVideoValue(payload.primaryVideoId);
  }

  const candidatePrimaryVideoId = hasOwn(payload, 'primaryVideoId')
    ? payload.primaryVideoId
    : existingAnime.primaryVideoId;

  if (!candidatePrimaryVideoId) return;

  if (candidateType !== 'movie') {
    throw httpError('primaryVideoId may only be set for movie Anime. Clear primaryVideoId before changing type.');
  }

  await assertPrimaryVideoExists(candidatePrimaryVideoId);
}

function convertMongoError(err) {
  if (err.code === 11000) {
    return httpError('Anime slug is already in use.', StatusCodes.CONFLICT);
  }

  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors)
      .map((entry) => entry.message)
      .join('. ');
    return httpError(`Validation failed: ${message}`);
  }

  return err;
}

function stringifyId(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value;
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (value._id && value._id !== value) return stringifyId(value._id);
  if (typeof value.toString === 'function') return value.toString();
  return value;
}

function serializeAnime(anime) {
  const raw = typeof anime?.toJSON === 'function' ? anime.toJSON() : anime;
  if (!raw) return raw;

  const serialized = { ...raw };
  if (!serialized.id && serialized._id) {
    serialized.id = stringifyId(serialized._id);
  }

  for (const field of ['primaryVideoId', 'createdBy', 'updatedBy']) {
    if (hasOwn(serialized, field)) {
      serialized[field] = stringifyId(serialized[field]);
    }
  }

  delete serialized._id;
  delete serialized.__v;
  delete serialized.deletedAt;
  return serialized;
}

async function findActiveAnimeById(animeId) {
  if (!isValidObjectId(animeId)) {
    throw httpError('animeId must be a valid ObjectId.');
  }

  const anime = await AnimeModel.findById(animeId);
  if (!anime) {
    throw httpError('Anime not found.', StatusCodes.NOT_FOUND);
  }

  return anime;
}

async function createAnime(input, currentUser) {
  const payload = normalizeAnimeCreateInput(input);

  await validatePrimaryVideoForCreate(payload);
  await assertActiveSlugAvailable(payload.slug);

  try {
    const anime = await AnimeModel.create({
      ...payload,
      createdBy: currentUser._id,
      updatedBy: currentUser._id,
      published: false,
      publishedAt: null,
    });
    return serializeAnime(anime);
  } catch (err) {
    throw convertMongoError(err);
  }
}

async function listAnime(query = {}) {
  const { page, limit, skip } = parsePagination(query);
  const filter = {};

  const searchRegex = buildSearchRegex(query.search);
  if (searchRegex) {
    filter.$or = [
      { title: searchRegex },
      { englishTitle: searchRegex },
      { japaneseTitle: searchRegex },
      { alternativeTitles: searchRegex },
      { description: searchRegex },
      { genres: searchRegex },
    ];
  }

  const type = parseQueryEnum(query, 'type', ANIME_TYPE_VALUES);
  if (type) filter.type = type;

  const status = parseQueryEnum(query, 'status', CONTENT_STATUS_VALUES);
  if (status) filter.status = status;

  const releaseStatus = parseQueryEnum(query, 'releaseStatus', RELEASE_STATUS_VALUES);
  if (releaseStatus) filter.releaseStatus = releaseStatus;

  const published = parseQueryBoolean(query, 'published');
  if (published !== null) filter.published = published;

  const genre = getScalarQueryValue(query.genre);
  if (typeof genre === 'string' && genre.trim().length > 0) {
    filter.genres = new RegExp(`^${escapeRegexString(genre.trim())}$`, 'i');
  }

  const year = parseQueryYear(query, 'year');
  if (year !== null) filter.releaseYear = year;

  const sort = parseSortOption(query);

  const [anime, totalItems] = await Promise.all([
    AnimeModel.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean({ virtuals: true }),
    AnimeModel.countDocuments(filter),
  ]);

  return {
    data: anime.map(serializeAnime),
    pagination: buildPaginationMetadata({ page, limit, totalItems }),
  };
}

async function getAnimeById(animeId) {
  const anime = await findActiveAnimeById(animeId);
  return serializeAnime(anime);
}

async function updateAnime(animeId, input, currentUser) {
  const anime = await findActiveAnimeById(animeId);
  const payload = normalizeAnimeUpdateInput(input, anime);

  await validatePrimaryVideoForUpdate(payload, anime);

  if (hasOwn(payload, 'slug') && payload.slug !== anime.slug) {
    await assertActiveSlugAvailable(payload.slug, anime._id);
  }

  Object.assign(anime, payload);
  anime.updatedBy = currentUser._id;

  try {
    await anime.save();
    return serializeAnime(anime);
  } catch (err) {
    throw convertMongoError(err);
  }
}

async function publishAnime(animeId, currentUser) {
  const anime = await findActiveAnimeById(animeId);

  if (!anime.title || !anime.slug || !ANIME_TYPE_VALUES.includes(anime.type)) {
    throw httpError('Anime is missing required metadata for publication.');
  }

  if (anime.type === 'movie' && anime.primaryVideoId) {
    await assertPrimaryVideoExists(anime.primaryVideoId);
  }

  anime.published = true;
  anime.status = 'published';
  anime.publishedAt = anime.publishedAt ?? new Date();
  anime.updatedBy = currentUser._id;

  try {
    await anime.save();
    return serializeAnime(anime);
  } catch (err) {
    throw convertMongoError(err);
  }
}

async function unpublishAnime(animeId, currentUser) {
  const anime = await findActiveAnimeById(animeId);

  anime.published = false;
  anime.status = 'draft';
  anime.publishedAt = null;
  anime.updatedBy = currentUser._id;

  try {
    await anime.save();
    return serializeAnime(anime);
  } catch (err) {
    throw convertMongoError(err);
  }
}

async function softDeleteAnime(animeId, currentUser) {
  const anime = await findActiveAnimeById(animeId);

  anime.deletedAt = new Date();
  anime.published = false;
  anime.status = 'archived';
  anime.publishedAt = null;
  anime.updatedBy = currentUser._id;

  try {
    await anime.save();
    return serializeAnime(anime);
  } catch (err) {
    throw convertMongoError(err);
  }
}

export {
  CREATE_ALLOWED_FIELDS,
  UPDATE_ALLOWED_FIELDS,
  createAnime,
  getAnimeById,
  listAnime,
  publishAnime,
  softDeleteAnime,
  unpublishAnime,
  updateAnime,
};
