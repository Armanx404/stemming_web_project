import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import mongoose from 'mongoose';

import AnimeModel from '../src/models/anime.model.js';
import {
  ANIME_TYPE_VALUES,
  CONTENT_RATING_VALUES,
  CONTENT_STATUS_VALUES,
  EPISODE_PROCESSING_STATUS_VALUES,
  RELEASE_STATUS_VALUES,
  SEASON_NAME_VALUES,
} from '../src/models/content.enums.js';
import EpisodeModel from '../src/models/episode.model.js';
import SeasonModel from '../src/models/season.model.js';
import UserModel from '../src/models/user.model.js';
import { requireAdmin } from '../src/middleware/auth.middleware.js';
import {
  buildPaginationMetadata,
  buildSearchRegex,
  escapeRegexString,
  parsePagination,
  parseSort,
} from '../src/utils/pagination.js';
import { createSlugFromTitle, createUniqueSlug, normalizeSlug } from '../src/utils/slug.js';
import {
  isBoundedArray,
  isDateOrderValid,
  isEnumValue,
  isOptionalUrl,
  isPositiveInteger,
  isValidObjectId,
  normalizeSafeString,
} from '../src/utils/validation.js';

const TEST_RUN_ID = Date.now().toString(36).slice(-8);
const TEST_PREFIX = `group2_${TEST_RUN_ID}`;

function objectId() {
  return new mongoose.Types.ObjectId();
}

async function assertValidationError(doc, path) {
  await assert.rejects(
    () => doc.validate(),
    (err) => err?.name === 'ValidationError' && Boolean(err.errors?.[path]),
  );
}

function findIndex(model, fields, predicate = () => true) {
  return model.schema.indexes().find(([indexFields, options]) => {
    return isDeepStrictEqual(indexFields, fields) && predicate(options || {});
  });
}

function mockResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function runFindPreHooks(model, query) {
  await new Promise((resolve, reject) => {
    model.schema.s.hooks.execPre('find', query, [], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

test('user role enum keeps existing roles and adds moderator and superadmin', () => {
  const rolePath = UserModel.schema.path('role');

  assert.deepEqual(rolePath.enumValues, ['user', 'moderator', 'admin', 'superadmin']);
  assert.equal(rolePath.defaultValue, 'user');

  const user = new UserModel({
    username: `${TEST_PREFIX}_role_user`,
    email: `${TEST_PREFIX}_role@example.test`,
    password: 'ValidPassword123!',
  });
  assert.equal(user.role, 'user');
});

test('shared content enums match Group 2 model requirements', () => {
  assert.deepEqual(ANIME_TYPE_VALUES, ['series', 'movie', 'ova', 'ona', 'special']);
  assert.deepEqual(CONTENT_STATUS_VALUES, ['draft', 'scheduled', 'published', 'archived']);
  assert.deepEqual(RELEASE_STATUS_VALUES, ['upcoming', 'airing', 'completed', 'hiatus', 'cancelled']);
  assert.deepEqual(CONTENT_RATING_VALUES, ['G', 'PG', 'PG-13', 'R', 'R+', 'NC-17', 'unrated']);
  assert.deepEqual(SEASON_NAME_VALUES, ['winter', 'spring', 'summer', 'fall', 'unknown']);
  assert.deepEqual(EPISODE_PROCESSING_STATUS_VALUES, [
    'not_uploaded',
    'uploaded',
    'queued',
    'processing',
    'ready',
    'failed',
  ]);
});

test('admin authorization allows admin and superadmin while rejecting moderator', () => {
  for (const role of ['admin', 'superadmin']) {
    const req = { user: { role } };
    const res = mockResponse();
    let nextCalled = false;

    requireAdmin(req, res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
  }

  const req = { user: { role: 'moderator' } };
  const res = mockResponse();
  let nextCalled = false;

  requireAdmin(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
});

test('anime model validates a normal series and applies safe defaults', async () => {
  const anime = new AnimeModel({
    title: `${TEST_PREFIX} Action Series`,
    type: 'series',
    releaseDate: new Date('2025-01-10T00:00:00.000Z'),
    genres: ['Action', 'Adventure'],
    published: true,
  });

  await anime.validate();

  assert.equal(anime.slug, createSlugFromTitle(`${TEST_PREFIX} Action Series`));
  assert.equal(anime.type, 'series');
  assert.equal(anime.primaryVideoId, null);
  assert.equal(anime.releaseYear, 2025);
  assert.equal(anime.views, 0);
  assert.equal(anime.watchCount, 0);
  assert.equal(anime.ratingAverage, 0);
  assert.equal(anime.deletedAt, null);
  assert.ok(anime.publishedAt instanceof Date);
});

test('anime model validates a movie with an existing primary video reference', async () => {
  const videoId = objectId();
  const anime = new AnimeModel({
    title: `${TEST_PREFIX} Feature Movie`,
    type: 'movie',
    primaryVideoId: videoId,
    totalSeasons: 0,
    totalEpisodes: 1,
    averageEpisodeDuration: 7200,
  });

  await anime.validate();

  assert.equal(anime.type, 'movie');
  assert.equal(anime.primaryVideoId.toString(), videoId.toString());
});

test('anime model rejects invalid enum values', async () => {
  await assertValidationError(
    new AnimeModel({
      title: `${TEST_PREFIX} Bad Type`,
      type: 'documentary',
    }),
    'type',
  );
});

test('anime model rejects out-of-range release years and ratings', async () => {
  await assertValidationError(
    new AnimeModel({
      title: `${TEST_PREFIX} Bad Release Year`,
      releaseYear: 1800,
    }),
    'releaseYear',
  );

  await assertValidationError(
    new AnimeModel({
      title: `${TEST_PREFIX} Bad Rating`,
      ratingAverage: 11,
    }),
    'ratingAverage',
  );
});

test('anime schema references Video and does not store temporary signed URL fields', () => {
  assert.equal(AnimeModel.schema.path('primaryVideoId').options.ref, 'Video');
  assert.equal(AnimeModel.schema.options.timestamps, true);

  const schemaPaths = Object.keys(AnimeModel.schema.paths);
  assert.equal(schemaPaths.some((path) => /signed/i.test(path)), false);
});

test('slug utilities normalize titles, symbols, whitespace, and reject empty slugs', () => {
  assert.equal(createSlugFromTitle('  My Hero Academia!!  '), 'my-hero-academia');
  assert.equal(normalizeSlug(' Symbols &   Space: The Movie '), 'symbols-and-space-the-movie');
  assert.equal(normalizeSlug('some_title__with symbols'), 'some-title-with-symbols');
  assert.equal(normalizeSlug('---One---Piece---'), 'one-piece');
  assert.throws(() => normalizeSlug(' !!! '), /empty/i);
});

test('slug utility creates predictable duplicate candidates', async () => {
  const existingSlugs = new Set(['one-piece', 'one-piece-2']);
  const fakeModel = {
    async exists(query) {
      return existingSlugs.has(query.slug) ? { _id: objectId() } : null;
    },
  };

  assert.equal(await createUniqueSlug({ model: fakeModel, value: 'One Piece' }), 'one-piece-3');
});

test('anime validation does not silently regenerate an existing slug on title update', async () => {
  const anime = new AnimeModel({
    title: `${TEST_PREFIX} Original Title`,
  });

  await anime.validate();
  const originalSlug = anime.slug;

  anime.title = `${TEST_PREFIX} Updated Title`;
  await anime.validate();

  assert.equal(anime.slug, originalSlug);
});

test('pagination utilities apply defaults, maximums, invalid fallbacks, and whitelisted sort', () => {
  assert.deepEqual(parsePagination({}), { page: 1, limit: 20, skip: 0 });
  assert.deepEqual(parsePagination({ page: '3', limit: '999' }), { page: 3, limit: 50, skip: 100 });
  assert.deepEqual(parsePagination({ page: '-2', limit: { $gt: 1 } }), { page: 1, limit: 20, skip: 0 });

  assert.deepEqual(
    buildPaginationMetadata({ page: 2, limit: 20, totalItems: 45 }),
    {
      page: 2,
      limit: 20,
      totalItems: 45,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    },
  );

  assert.deepEqual(parseSort({ sort: '-releaseYear' }, ['releaseYear']), { releaseYear: -1 });
  assert.deepEqual(parseSort({ sort: 'unsafeField' }, ['releaseYear']), { createdAt: -1 });
  assert.deepEqual(parseSort({ sort: { $where: 'bad' } }, ['releaseYear']), { createdAt: -1 });
});

test('search helpers escape unsafe regex input', () => {
  const unsafe = 'a+b (test).*';
  const escaped = escapeRegexString(unsafe);
  const regex = buildSearchRegex(unsafe);

  assert.equal(escaped, 'a\\+b \\(test\\)\\.\\*');
  assert.equal(regex.test(unsafe), true);
  assert.equal(regex.test('aab test anything'), false);
});

test('validation utilities cover ObjectId, enums, strings, arrays, URLs, and positive integers', () => {
  assert.equal(isValidObjectId(objectId()), true);
  assert.equal(isValidObjectId(objectId().toString()), true);
  assert.equal(isValidObjectId('not-an-object-id'), false);

  assert.equal(isEnumValue('series', ['series', 'movie']), true);
  assert.equal(isEnumValue('bad', ['series', 'movie']), false);

  assert.equal(normalizeSafeString('  Hello    World  ', { field: 'title' }), 'Hello World');
  assert.equal(normalizeSafeString('  Mixed Case  ', { lowercase: true }), 'mixed case');
  assert.throws(() => normalizeSafeString('   ', { field: 'title', allowEmpty: false }), /title/i);

  assert.equal(isBoundedArray(['a', 'b'], { max: 2, itemValidator: (item) => typeof item === 'string' }), true);
  assert.equal(isBoundedArray(['a', 'b', 'c'], { max: 2 }), false);

  assert.equal(isOptionalUrl(null), true);
  assert.equal(isOptionalUrl('https://example.test/trailer'), true);
  assert.equal(isOptionalUrl('ftp://example.test/file'), false);

  assert.equal(isPositiveInteger(1), true);
  assert.equal(isPositiveInteger(0), false);
  assert.equal(isPositiveInteger(1.5), false);
});

test('season and episode numbers must be positive integers', async () => {
  await assertValidationError(
    new SeasonModel({
      animeId: objectId(),
      seasonNumber: 0,
      title: `${TEST_PREFIX} Season Zero`,
    }),
    'seasonNumber',
  );

  await assertValidationError(
    new EpisodeModel({
      animeId: objectId(),
      seasonId: objectId(),
      episodeNumber: 0,
      title: `${TEST_PREFIX} Episode Zero`,
    }),
    'episodeNumber',
  );
});

test('season model validates Anime reference, defaults, timestamps, and slug', async () => {
  const animeId = objectId();
  const season = new SeasonModel({
    animeId,
    seasonNumber: 1,
    title: `${TEST_PREFIX} Season One`,
    published: true,
  });

  await season.validate();

  assert.equal(SeasonModel.schema.path('animeId').options.ref, 'Anime');
  assert.equal(SeasonModel.schema.options.timestamps, true);
  assert.equal(season.animeId.toString(), animeId.toString());
  assert.equal(season.episodeCount, 0);
  assert.equal(season.slug, createSlugFromTitle(`${TEST_PREFIX} Season One`));
  assert.equal(season.deletedAt, null);
  assert.ok(season.publishedAt instanceof Date);
});

test('episode model validates references, processing status, timestamps, and avoids HLS duplication', async () => {
  const animeId = objectId();
  const seasonId = objectId();
  const videoId = objectId();
  const episode = new EpisodeModel({
    animeId,
    seasonId,
    videoId,
    episodeNumber: 1,
    absoluteEpisodeNumber: 7,
    title: `${TEST_PREFIX} Episode One`,
    published: true,
    audioTracks: [{ language: 'Japanese', codec: 'aac', channels: 2 }],
    subtitleTracks: [{ language: 'English', format: 'vtt', kind: 'subtitles' }],
  });

  await episode.validate();

  assert.equal(EpisodeModel.schema.path('animeId').options.ref, 'Anime');
  assert.equal(EpisodeModel.schema.path('seasonId').options.ref, 'Season');
  assert.equal(EpisodeModel.schema.path('videoId').options.ref, 'Video');
  assert.equal(EpisodeModel.schema.path('hlsUrl'), undefined);
  assert.equal(EpisodeModel.schema.options.timestamps, true);
  assert.equal(episode.animeId.toString(), animeId.toString());
  assert.equal(episode.seasonId.toString(), seasonId.toString());
  assert.equal(episode.videoId.toString(), videoId.toString());
  assert.equal(episode.processingStatus, 'uploaded');
  assert.equal(episode.slug, createSlugFromTitle(`${TEST_PREFIX} Episode One`));
  assert.equal(episode.deletedAt, null);
  assert.ok(episode.publishedAt instanceof Date);
});

test('model indexes include soft-delete-aware uniqueness and search support', () => {
  assert.ok(findIndex(
    AnimeModel,
    { slug: 1 },
    (options) => options.unique === true && options.partialFilterExpression?.deletedAt === null,
  ));
  assert.ok(findIndex(
    AnimeModel,
    {
      title: 'text',
      englishTitle: 'text',
      japaneseTitle: 'text',
      alternativeTitles: 'text',
      description: 'text',
      genres: 'text',
    },
  ));
  assert.ok(findIndex(
    SeasonModel,
    { animeId: 1, seasonNumber: 1 },
    (options) => options.unique === true && options.partialFilterExpression?.deletedAt === null,
  ));
  assert.ok(findIndex(
    EpisodeModel,
    { seasonId: 1, episodeNumber: 1 },
    (options) => options.unique === true && options.partialFilterExpression?.deletedAt === null,
  ));
  assert.ok(findIndex(AnimeModel, { type: 1, published: 1, deletedAt: 1, releaseYear: -1 }));
  assert.ok(findIndex(AnimeModel, { status: 1, published: 1, deletedAt: 1 }));
  assert.ok(findIndex(AnimeModel, { releaseStatus: 1, published: 1, deletedAt: 1 }));
  assert.ok(findIndex(AnimeModel, { releaseYear: -1, deletedAt: 1 }));
});

test('date relationship validation rejects end dates before start dates', async () => {
  assert.equal(
    isDateOrderValid(new Date('2024-01-01T00:00:00.000Z'), new Date('2024-01-02T00:00:00.000Z')),
    true,
  );
  assert.equal(
    isDateOrderValid(new Date('2024-01-02T00:00:00.000Z'), new Date('2024-01-01T00:00:00.000Z')),
    false,
  );

  await assertValidationError(
    new AnimeModel({
      title: `${TEST_PREFIX} Bad Date Anime`,
      releaseDate: new Date('2024-06-10T00:00:00.000Z'),
      endDate: new Date('2024-06-09T00:00:00.000Z'),
    }),
    'endDate',
  );

  await assertValidationError(
    new SeasonModel({
      animeId: objectId(),
      seasonNumber: 1,
      title: `${TEST_PREFIX} Bad Date Season`,
      releaseDate: new Date('2024-06-10T00:00:00.000Z'),
      endDate: new Date('2024-06-09T00:00:00.000Z'),
    }),
    'endDate',
  );
});

test('bounded arrays reject oversized anime metadata and episode tracks', async () => {
  await assertValidationError(
    new AnimeModel({
      title: `${TEST_PREFIX} Too Many Genres`,
      genres: Array.from({ length: 26 }, (_, index) => `genre-${index}`),
    }),
    'genres',
  );

  await assertValidationError(
    new EpisodeModel({
      animeId: objectId(),
      seasonId: objectId(),
      episodeNumber: 1,
      title: `${TEST_PREFIX} Too Many Audio Tracks`,
      audioTracks: Array.from({ length: 11 }, (_, index) => ({
        language: `lang-${index}`,
      })),
    }),
    'audioTracks',
  );

  await assertValidationError(
    new EpisodeModel({
      animeId: objectId(),
      seasonId: objectId(),
      episodeNumber: 2,
      title: `${TEST_PREFIX} Too Many Subtitle Tracks`,
      subtitleTracks: Array.from({ length: 21 }, (_, index) => ({
        language: `lang-${index}`,
      })),
    }),
    'subtitleTracks',
  );
});

test('shared media, audio, and subtitle subschemas validate nested metadata', async () => {
  await assertValidationError(
    new AnimeModel({
      title: `${TEST_PREFIX} Bad Poster URL`,
      poster: { url: 'ftp://example.test/poster.jpg' },
    }),
    'poster.url',
  );

  await assertValidationError(
    new EpisodeModel({
      animeId: objectId(),
      seasonId: objectId(),
      episodeNumber: 3,
      title: `${TEST_PREFIX} Missing Audio Language`,
      audioTracks: [{ label: 'English' }],
    }),
    'audioTracks.0.language',
  );

  await assertValidationError(
    new EpisodeModel({
      animeId: objectId(),
      seasonId: objectId(),
      episodeNumber: 4,
      title: `${TEST_PREFIX} Bad Subtitle Format`,
      subtitleTracks: [{ language: 'English', format: 'txt' }],
    }),
    'subtitleTracks.0.format',
  );
});

test('soft-delete plugin adds default deletedAt filtering and preserves explicit deletedAt queries', async () => {
  const anime = new AnimeModel({
    title: `${TEST_PREFIX} Soft Delete Default`,
  });

  await anime.validate();
  assert.equal(anime.deletedAt, null);

  const defaultQuery = AnimeModel.find({ title: anime.title });
  await runFindPreHooks(AnimeModel, defaultQuery);
  assert.deepEqual(defaultQuery.getFilter(), {
    title: anime.title,
    deletedAt: null,
  });

  const explicitQuery = AnimeModel.find({ deletedAt: { $ne: null } });
  await runFindPreHooks(AnimeModel, explicitQuery);
  assert.deepEqual(explicitQuery.getFilter(), {
    deletedAt: { $ne: null },
  });
});
