import 'dotenv/config';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.RATE_LIMIT_MAX_REQUESTS = '500';
process.env.AUTH_RATE_LIMIT_WINDOW_MS = '60000';
process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '500';

const [
  { default: request },
  { default: mongoose },
  { default: jwt },
  { default: app },
  { default: connectDB },
  { default: AnimeModel },
  { default: UserModel },
  { default: VideoModel },
  { getRedisClient },
] = await Promise.all([
  import('supertest'),
  import('mongoose'),
  import('jsonwebtoken'),
  import('../src/app.js'),
  import('../src/config/db.js'),
  import('../src/models/anime.model.js'),
  import('../src/models/user.model.js'),
  import('../src/models/video.model.js'),
  import('../src/config/redis.config.js'),
]);

const TEST_RUN_ID = Date.now().toString(36).slice(-8);
const TEST_PREFIX = `g4${TEST_RUN_ID}`;
const TEST_EMAIL_PREFIX = `${TEST_PREFIX}_`;
const VALID_PASSWORD = 'Phase3Group4Pass123!';

const users = {};
const tokens = {};
let primaryVideo;

function usernameFor(label) {
  return `${TEST_PREFIX}_${label}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 30);
}

function emailFor(label) {
  return `${TEST_EMAIL_PREFIX}${label}@example.test`;
}

function slugFor(label) {
  return `${TEST_PREFIX}-${label}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function bearer(token) {
  return `Bearer ${token}`;
}

function signUserToken(user, role = user.role) {
  return jwt.sign(
    { sub: user.id, role },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '15m' },
  );
}

function baseAnimePayload(label, overrides = {}) {
  return {
    title: `${TEST_PREFIX} ${label} Anime`,
    description: `Description for ${label}`,
    type: 'series',
    genres: ['Action', 'Drama'],
    releaseStatus: 'upcoming',
    contentRating: 'PG-13',
    releaseDate: '2025-01-01',
    endDate: '2025-03-01',
    trailerUrl: 'https://example.test/trailer.mp4',
    ...overrides,
  };
}

async function createUser(label, role) {
  const user = await UserModel.create({
    username: usernameFor(label),
    email: emailFor(label),
    password: VALID_PASSWORD,
    role,
  });

  users[label] = user;
  tokens[label] = signUserToken(user);
  return user;
}

async function cleanupTestData() {
  await Promise.all([
    AnimeModel.deleteMany({
      $or: [
        { slug: { $regex: `^${TEST_PREFIX}` } },
        { title: { $regex: `^${TEST_PREFIX}` } },
      ],
    }),
    VideoModel.deleteMany({
      title: { $regex: `^${TEST_PREFIX}` },
    }),
    UserModel.deleteMany({
      email: { $regex: `^${TEST_EMAIL_PREFIX}` },
    }),
  ]);
}

async function postAnime(label, payloadOverrides = {}, token = tokens.admin) {
  return request(app)
    .post('/api/admin/anime')
    .set('Authorization', bearer(token))
    .send(baseAnimePayload(label, payloadOverrides));
}

async function getAnimeList(query = {}, token = tokens.admin) {
  return request(app)
    .get('/api/admin/anime')
    .set('Authorization', bearer(token))
    .query(query);
}

async function getAnimeDetail(animeId, token = tokens.admin) {
  return request(app)
    .get(`/api/admin/anime/${animeId}`)
    .set('Authorization', bearer(token));
}

async function patchAnime(animeId, payload, token = tokens.admin) {
  return request(app)
    .patch(`/api/admin/anime/${animeId}`)
    .set('Authorization', bearer(token))
    .send(payload);
}

async function publishAnime(animeId, token = tokens.admin) {
  return request(app)
    .patch(`/api/admin/anime/${animeId}/publish`)
    .set('Authorization', bearer(token))
    .send({});
}

async function unpublishAnime(animeId, token = tokens.admin) {
  return request(app)
    .patch(`/api/admin/anime/${animeId}/unpublish`)
    .set('Authorization', bearer(token))
    .send({});
}

async function deleteAnime(animeId, token = tokens.admin) {
  return request(app)
    .delete(`/api/admin/anime/${animeId}`)
    .set('Authorization', bearer(token));
}

function assertErrorEnvelope(res, statusCode) {
  assert.equal(res.status, statusCode, res.text);
  assert.equal(res.body.success, false);
  assert.equal(typeof res.body.message, 'string');
  assert.equal(res.body.data, undefined);
}

function assertSuccessEnvelope(res, statusCode) {
  assert.equal(res.status, statusCode, res.text);
  assert.equal(res.body.success, true);
  assert.equal(typeof res.body.message, 'string');
  assert.ok(res.body.data);
}

before(async () => {
  await connectDB();
  await cleanupTestData();

  await createUser('user', 'user');
  await createUser('moderator', 'moderator');
  await createUser('admin', 'admin');
  await createUser('superadmin', 'superadmin');

  primaryVideo = await VideoModel.create({
    title: `${TEST_PREFIX} Primary Video`,
    description: 'Primary movie video fixture',
    videoUrl: 'https://example.test/video.mp4',
    uploadedBy: users.admin._id,
    status: 'ready',
  });
});

after(async () => {
  await cleanupTestData();
  await mongoose.disconnect();
  try {
    getRedisClient().disconnect();
  } catch {
    // No Redis client was created.
  }
});

test('create Anime without token returns 401', async () => {
  const res = await request(app)
    .post('/api/admin/anime')
    .send(baseAnimePayload('no-token'));

  assertErrorEnvelope(res, 401);
});

test('create Anime as normal user returns 403', async () => {
  const res = await postAnime('as-user', {}, tokens.user);

  assertErrorEnvelope(res, 403);
});

test('create Anime as moderator returns 403', async () => {
  const res = await postAnime('as-moderator', {}, tokens.moderator);

  assertErrorEnvelope(res, 403);
});

test('create Anime as admin returns 201', async () => {
  const res = await postAnime('as-admin');

  assertSuccessEnvelope(res, 201);
  assert.equal(res.body.data.createdBy, users.admin.id);
  assert.equal(res.body.data.updatedBy, users.admin.id);
  assert.equal(res.body.data.published, false);
  assert.equal(res.body.data.publishedAt, null);
});

test('create Anime as superadmin returns 201', async () => {
  const res = await postAnime('as-superadmin', {}, tokens.superadmin);

  assertSuccessEnvelope(res, 201);
  assert.equal(res.body.data.createdBy, users.superadmin.id);
  assert.equal(res.body.data.updatedBy, users.superadmin.id);
});

test('creates a valid series Anime', async () => {
  const res = await postAnime('valid-series', {
    studios: ['Bones'],
    producers: ['Aniplex'],
    languages: ['Japanese'],
    originalLanguage: 'Japanese',
    countryOfOrigin: 'Japan',
    averageEpisodeDuration: 1440,
    subAvailable: true,
    dubAvailable: false,
    featured: true,
    trending: false,
  });

  assertSuccessEnvelope(res, 201);
  assert.equal(res.body.data.type, 'series');
  assert.equal(res.body.data.published, false);
  assert.equal(res.body.data.totalSeasons, 0);
  assert.equal(res.body.data.totalEpisodes, 0);
  assert.equal(res.body.data.views, 0);
  assert.equal(res.body.data.watchCount, 0);
});

test('creates a valid movie Anime', async () => {
  const res = await postAnime('valid-movie', {
    type: 'movie',
    slug: slugFor('valid-movie'),
    releaseStatus: 'completed',
  });

  assertSuccessEnvelope(res, 201);
  assert.equal(res.body.data.type, 'movie');
  assert.equal(res.body.data.slug, slugFor('valid-movie'));
  assert.equal(res.body.data.primaryVideoId, null);
});

test('creates a movie Anime with a valid primaryVideoId', async () => {
  const res = await postAnime('movie-video', {
    type: 'movie',
    primaryVideoId: primaryVideo.id,
  });

  assertSuccessEnvelope(res, 201);
  assert.equal(res.body.data.type, 'movie');
  assert.equal(res.body.data.primaryVideoId, primaryVideo.id);
});

test('rejects invalid primaryVideoId format', async () => {
  const res = await postAnime('movie-bad-video-id', {
    type: 'movie',
    primaryVideoId: 'not-an-object-id',
  });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /primaryVideoId/i);
});

test('missing primaryVideoId reference returns 404', async () => {
  const res = await postAnime('movie-missing-video', {
    type: 'movie',
    primaryVideoId: new mongoose.Types.ObjectId().toString(),
  });

  assertErrorEnvelope(res, 404);
  assert.match(res.body.message, /primary video/i);
});

test('rejects primaryVideoId for a series Anime', async () => {
  const res = await postAnime('series-video', {
    type: 'series',
    primaryVideoId: primaryVideo.id,
  });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /primaryVideoId/i);
});

test('rejects missing title', async () => {
  const payload = baseAnimePayload('missing-title');
  delete payload.title;

  const res = await request(app)
    .post('/api/admin/anime')
    .set('Authorization', bearer(tokens.admin))
    .send(payload);

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /title/i);
});

test('rejects invalid enum values', async () => {
  const res = await postAnime('bad-enum', { type: 'documentary' });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /type/i);
});

test('rejects invalid URL fields', async () => {
  const res = await postAnime('bad-url', { trailerUrl: 'javascript:alert(1)' });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /trailerUrl/i);
});

test('rejects duplicate normalized array entries', async () => {
  const res = await postAnime('duplicate-array', {
    genres: ['Action', ' action '],
  });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /duplicate/i);
});

test('rejects release years outside the allowed range', async () => {
  const res = await postAnime('bad-release-year', {
    releaseYear: 1800,
  });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /releaseYear/i);
});

test('rejects invalid date order', async () => {
  const res = await postAnime('bad-date', {
    releaseDate: '2025-04-01',
    endDate: '2025-03-01',
  });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /endDate/i);
});

test('generates slug from title when slug is omitted', async () => {
  const res = await postAnime('generated-slug', {
    title: `${TEST_PREFIX} Generated Slug Title!!`,
  });

  assertSuccessEnvelope(res, 201);
  assert.equal(res.body.data.slug, `${TEST_PREFIX}-generated-slug-title`.toLowerCase());
});

test('normalizes explicitly supplied slug', async () => {
  const res = await postAnime('explicit-slug', {
    slug: `  ${TEST_PREFIX} Explicit SLUG!!  `,
  });

  assertSuccessEnvelope(res, 201);
  assert.equal(res.body.data.slug, `${TEST_PREFIX}-explicit-slug`.toLowerCase());
});

test('duplicate active slug returns 409', async () => {
  const slug = slugFor('duplicate-active');
  const first = await postAnime('duplicate-first', { slug });
  assertSuccessEnvelope(first, 201);

  const second = await postAnime('duplicate-second', { slug });
  assertErrorEnvelope(second, 409);
});

test('forbidden system fields return 400', async () => {
  const res = await postAnime('forbidden-field', {
    createdBy: users.user.id,
  });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /createdBy/i);
});

test('MongoDB operator payload returns 400', async () => {
  const res = await request(app)
    .post('/api/admin/anime')
    .set('Authorization', bearer(tokens.admin))
    .send({
      title: `${TEST_PREFIX} Operator Anime`,
      $set: { slug: slugFor('operator') },
    });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /Unsafe field/i);
});

test('role supplied in payload is rejected and cannot affect ownership', async () => {
  const res = await postAnime('role-payload', {
    role: 'superadmin',
  });

  assertErrorEnvelope(res, 400);

  const created = await AnimeModel.findOne({ title: `${TEST_PREFIX} role-payload Anime` });
  assert.equal(created, null);
});

test('list Anime without token returns 401', async () => {
  const res = await request(app).get('/api/admin/anime');

  assertErrorEnvelope(res, 401);
});

test('admin list returns default pagination', async () => {
  const res = await getAnimeList();

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.data));
  assert.equal(res.body.pagination.page, 1);
  assert.equal(res.body.pagination.limit, 20);
  assert.equal(typeof res.body.pagination.totalItems, 'number');
});

test('admin list enforces maximum limit', async () => {
  const res = await getAnimeList({ limit: 999 });

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.pagination.limit, 50);
});

test('admin list searches by title', async () => {
  const marker = `${TEST_PREFIX} Unique Search Title`;
  await postAnime('search-title', { title: marker });

  const res = await getAnimeList({ search: 'Unique Search Title' });

  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.data.some((anime) => anime.title === marker));
});

test('admin list escapes special-character search input', async () => {
  await postAnime('search-special', {
    title: `${TEST_PREFIX} Brackets [literal] Anime`,
  });

  const res = await getAnimeList({ search: '[literal]' });

  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.data.every((anime) => anime.title.includes('[literal]')));
});

test('admin list filters by type', async () => {
  const res = await getAnimeList({ type: 'movie' });

  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.data.length > 0);
  assert.ok(res.body.data.every((anime) => anime.type === 'movie'));
});

test('admin list filters by status', async () => {
  await postAnime('scheduled-filter', { status: 'scheduled' });

  const res = await getAnimeList({ status: 'scheduled' });

  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.data.length > 0);
  assert.ok(res.body.data.every((anime) => anime.status === 'scheduled'));
});

test('admin list filters by release status', async () => {
  await postAnime('release-filter', { releaseStatus: 'airing' });

  const res = await getAnimeList({ releaseStatus: 'airing' });

  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.data.length > 0);
  assert.ok(res.body.data.every((anime) => anime.releaseStatus === 'airing'));
});

test('admin list filters by published state', async () => {
  const created = await postAnime('published-filter');
  assertSuccessEnvelope(created, 201);
  await AnimeModel.findByIdAndUpdate(created.body.data.id, {
    published: true,
    status: 'published',
    publishedAt: new Date(),
  });

  const res = await getAnimeList({ published: 'true' });

  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.data.length > 0);
  assert.ok(res.body.data.every((anime) => anime.published === true));
});

test('admin list filters by genre', async () => {
  await postAnime('genre-filter', { genres: ['Mystery', 'Adventure'] });

  const res = await getAnimeList({ genre: 'mystery' });

  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.data.length > 0);
  assert.ok(res.body.data.every((anime) => anime.genres.some((genre) => genre.toLowerCase() === 'mystery')));
});

test('admin list filters by release year', async () => {
  await postAnime('year-filter', { releaseYear: 2030 });

  const res = await getAnimeList({ year: '2030' });

  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.data.length > 0);
  assert.ok(res.body.data.every((anime) => anime.releaseYear === 2030));
});

test('admin list accepts valid sort values', async () => {
  for (const sort of ['latest', 'oldest', 'title', 'release-year', 'most-watched', 'trending', 'rating', 'recently-updated']) {
    const res = await getAnimeList({ sort, limit: 5 });

    assert.equal(res.status, 200, `${sort}: ${res.text}`);
    assert.ok(Array.isArray(res.body.data));
  }
});

test('admin list rejects invalid sort values', async () => {
  const res = await getAnimeList({ sort: '$where' });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /sort/i);
});

test('admin list includes draft Anime for admins', async () => {
  const created = await postAnime('draft-visible', { status: 'draft' });
  assertSuccessEnvelope(created, 201);

  const res = await getAnimeList({ status: 'draft', search: 'draft-visible' });

  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.data.some((anime) => anime.slug === created.body.data.slug));
});

test('admin list excludes deleted Anime', async () => {
  const created = await postAnime('deleted-list');
  assertSuccessEnvelope(created, 201);
  await AnimeModel.findByIdAndUpdate(created.body.data.id, { deletedAt: new Date() });

  const res = await getAnimeList({ search: 'deleted-list' });

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.data.some((anime) => anime.id === created.body.data.id), false);
});

test('admin list handles NoSQL-like query values safely', async () => {
  const res = await request(app)
    .get('/api/admin/anime?type[$ne]=movie&published[$ne]=true')
    .set('Authorization', bearer(tokens.admin));

  assert.equal(res.status, 200, res.text);
  assert.ok(Array.isArray(res.body.data));
});

test('admin Anime detail as normal user returns 403', async () => {
  const created = await postAnime('detail-user');
  assertSuccessEnvelope(created, 201);

  const res = await getAnimeDetail(created.body.data.id, tokens.user);

  assertErrorEnvelope(res, 403);
});

test('admin Anime detail rejects invalid ObjectId', async () => {
  const res = await getAnimeDetail('not-an-object-id');

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /animeId/i);
});

test('admin Anime detail returns 404 for missing Anime', async () => {
  const missingId = new mongoose.Types.ObjectId().toString();
  const res = await getAnimeDetail(missingId);

  assertErrorEnvelope(res, 404);
});

test('admin Anime detail returns an existing Anime', async () => {
  const created = await postAnime('detail-existing');
  assertSuccessEnvelope(created, 201);

  const res = await getAnimeDetail(created.body.data.id);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.id, created.body.data.id);
  assert.equal(res.body.data.slug, created.body.data.slug);
  assert.equal(res.body.data.deletedAt, undefined);
});

test('admin Anime detail hides deleted Anime', async () => {
  const created = await postAnime('detail-deleted');
  assertSuccessEnvelope(created, 201);
  await AnimeModel.findByIdAndUpdate(created.body.data.id, { deletedAt: new Date() });

  const res = await getAnimeDetail(created.body.data.id);

  assertErrorEnvelope(res, 404);
});

test('update Anime as moderator returns 403', async () => {
  const created = await postAnime('update-moderator');
  assertSuccessEnvelope(created, 201);

  const res = await patchAnime(created.body.data.id, { shortDescription: 'Nope' }, tokens.moderator);

  assertErrorEnvelope(res, 403);
});

test('delete Anime as normal user returns 403', async () => {
  const created = await postAnime('delete-user');
  assertSuccessEnvelope(created, 201);

  const res = await deleteAnime(created.body.data.id, tokens.user);

  assertErrorEnvelope(res, 403);
});

test('updates Anime with a valid partial update', async () => {
  const created = await postAnime('update-valid');
  assertSuccessEnvelope(created, 201);

  const res = await patchAnime(created.body.data.id, {
    shortDescription: 'Updated short description',
    genres: ['Action', 'Mystery'],
    featured: true,
  });

  assertSuccessEnvelope(res, 200);
  assert.equal(res.body.data.shortDescription, 'Updated short description');
  assert.deepEqual(res.body.data.genres, ['Action', 'Mystery']);
  assert.equal(res.body.data.featured, true);
});

test('title update preserves the existing slug', async () => {
  const created = await postAnime('title-preserve-slug', {
    slug: slugFor('title-preserve-slug'),
  });
  assertSuccessEnvelope(created, 201);

  const res = await patchAnime(created.body.data.id, {
    title: `${TEST_PREFIX} Renamed Title`,
  });

  assertSuccessEnvelope(res, 200);
  assert.equal(res.body.data.title, `${TEST_PREFIX} Renamed Title`);
  assert.equal(res.body.data.slug, slugFor('title-preserve-slug'));
});

test('explicit slug update normalizes the replacement slug', async () => {
  const created = await postAnime('update-slug');
  assertSuccessEnvelope(created, 201);

  const res = await patchAnime(created.body.data.id, {
    slug: ` ${TEST_PREFIX} Replacement SLUG!! `,
  });

  assertSuccessEnvelope(res, 200);
  assert.equal(res.body.data.slug, `${TEST_PREFIX}-replacement-slug`.toLowerCase());
});

test('duplicate replacement slug returns 409', async () => {
  const first = await postAnime('slug-owner', { slug: slugFor('slug-owner') });
  const second = await postAnime('slug-taker', { slug: slugFor('slug-taker') });
  assertSuccessEnvelope(first, 201);
  assertSuccessEnvelope(second, 201);

  const res = await patchAnime(second.body.data.id, { slug: first.body.data.slug });

  assertErrorEnvelope(res, 409);
});

test('empty update returns 400', async () => {
  const created = await postAnime('empty-update');
  assertSuccessEnvelope(created, 201);

  const res = await patchAnime(created.body.data.id, {});

  assertErrorEnvelope(res, 400);
});

test('forbidden counter update returns 400', async () => {
  const created = await postAnime('counter-update');
  assertSuccessEnvelope(created, 201);

  const res = await patchAnime(created.body.data.id, { views: 999 });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /views/i);
});

test('direct published update returns 400', async () => {
  const created = await postAnime('direct-published');
  assertSuccessEnvelope(created, 201);

  const res = await patchAnime(created.body.data.id, { published: true });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /published/i);
});

test('ordinary PATCH cannot publish by setting status to published', async () => {
  const created = await postAnime('patch-status-published');
  assertSuccessEnvelope(created, 201);

  const res = await patchAnime(created.body.data.id, { status: 'published' });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /publish endpoint/i);
});

test('operator injection attempt during update returns 400', async () => {
  const created = await postAnime('update-operator');
  assertSuccessEnvelope(created, 201);

  const res = await request(app)
    .patch(`/api/admin/anime/${created.body.data.id}`)
    .set('Authorization', bearer(tokens.admin))
    .send({ $inc: { views: 1 } });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /Unsafe field/i);
});

test('update validates date relationships against existing values', async () => {
  const created = await postAnime('update-date-cross-field', {
    releaseDate: '2025-01-01',
    endDate: '2025-03-01',
  });
  assertSuccessEnvelope(created, 201);

  const res = await patchAnime(created.body.data.id, {
    releaseDate: '2025-04-01',
  });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /endDate/i);
});

test('changing movie to non-movie is rejected while primaryVideoId remains set', async () => {
  const created = await postAnime('movie-type-transition', {
    type: 'movie',
    primaryVideoId: primaryVideo.id,
  });
  assertSuccessEnvelope(created, 201);

  const res = await patchAnime(created.body.data.id, { type: 'series' });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /primaryVideoId/i);
});

test('updatedBy comes from the authenticated database user', async () => {
  const created = await postAnime('updated-by-admin');
  assertSuccessEnvelope(created, 201);

  const res = await patchAnime(
    created.body.data.id,
    { shortDescription: 'Changed by superadmin' },
    tokens.superadmin,
  );

  assertSuccessEnvelope(res, 200);
  assert.equal(res.body.data.createdBy, users.admin.id);
  assert.equal(res.body.data.updatedBy, users.superadmin.id);
});

test('createdBy and updatedBy cannot be spoofed on update', async () => {
  const created = await postAnime('spoof-update');
  assertSuccessEnvelope(created, 201);

  const res = await patchAnime(created.body.data.id, {
    updatedBy: users.user.id,
  });

  assertErrorEnvelope(res, 400);
  assert.match(res.body.message, /updatedBy/i);
});

test('publish Anime returns 200', async () => {
  const created = await postAnime('publish-once');
  assertSuccessEnvelope(created, 201);

  const res = await publishAnime(created.body.data.id);

  assertSuccessEnvelope(res, 200);
});

test('published state fields are consistent', async () => {
  const created = await postAnime('publish-fields');
  assertSuccessEnvelope(created, 201);

  const res = await publishAnime(created.body.data.id);

  assertSuccessEnvelope(res, 200);
  assert.equal(res.body.data.published, true);
  assert.equal(res.body.data.status, 'published');
  assert.equal(typeof res.body.data.publishedAt, 'string');
  assert.equal(res.body.data.updatedBy, users.admin.id);
});

test('repeated publish is idempotent success', async () => {
  const created = await postAnime('publish-repeat');
  assertSuccessEnvelope(created, 201);
  const first = await publishAnime(created.body.data.id);
  assertSuccessEnvelope(first, 200);

  const second = await publishAnime(created.body.data.id);

  assertSuccessEnvelope(second, 200);
  assert.equal(second.body.data.published, true);
  assert.equal(second.body.data.status, 'published');
});

test('publish rejects invalid ObjectId', async () => {
  const res = await publishAnime('not-an-object-id');

  assertErrorEnvelope(res, 400);
});

test('unpublish Anime returns 200', async () => {
  const created = await postAnime('unpublish-once');
  assertSuccessEnvelope(created, 201);
  const published = await publishAnime(created.body.data.id);
  assertSuccessEnvelope(published, 200);

  const res = await unpublishAnime(created.body.data.id);

  assertSuccessEnvelope(res, 200);
});

test('unpublished state fields are consistent', async () => {
  const created = await postAnime('unpublish-fields');
  assertSuccessEnvelope(created, 201);
  const published = await publishAnime(created.body.data.id);
  assertSuccessEnvelope(published, 200);

  const res = await unpublishAnime(created.body.data.id);

  assertSuccessEnvelope(res, 200);
  assert.equal(res.body.data.published, false);
  assert.equal(res.body.data.status, 'draft');
  assert.equal(res.body.data.publishedAt, null);
  assert.equal(res.body.data.updatedBy, users.admin.id);
});

test('repeated unpublish is idempotent success', async () => {
  const created = await postAnime('unpublish-repeat');
  assertSuccessEnvelope(created, 201);

  const res = await unpublishAnime(created.body.data.id);

  assertSuccessEnvelope(res, 200);
  assert.equal(res.body.data.published, false);
  assert.equal(res.body.data.status, 'draft');
});

test('delete Anime soft deletes the document successfully', async () => {
  const created = await postAnime('delete-success');
  assertSuccessEnvelope(created, 201);

  const res = await deleteAnime(created.body.data.id);

  assertSuccessEnvelope(res, 200);
  assert.equal(res.body.data.published, false);
  assert.equal(res.body.data.status, 'archived');
});

test('soft-deleted Anime document remains in MongoDB with deletedAt set', async () => {
  const created = await postAnime('delete-retained');
  assertSuccessEnvelope(created, 201);
  const deleted = await deleteAnime(created.body.data.id);
  assertSuccessEnvelope(deleted, 200);

  const dbAnime = await AnimeModel.findOne({
    _id: created.body.data.id,
    deletedAt: { $ne: null },
  });

  assert.ok(dbAnime);
  assert.ok(dbAnime.deletedAt instanceof Date);
});

test('soft delete clears publication state and archives status', async () => {
  const created = await postAnime('delete-published', { status: 'scheduled' });
  assertSuccessEnvelope(created, 201);
  const published = await publishAnime(created.body.data.id);
  assertSuccessEnvelope(published, 200);

  const deleted = await deleteAnime(created.body.data.id);
  assertSuccessEnvelope(deleted, 200);

  const dbAnime = await AnimeModel.findOne({
    _id: created.body.data.id,
    deletedAt: { $ne: null },
  });
  assert.equal(dbAnime.published, false);
  assert.equal(dbAnime.publishedAt, null);
  assert.equal(dbAnime.status, 'archived');
});

test('deleted Anime is hidden from admin list', async () => {
  const created = await postAnime('delete-hidden-list');
  assertSuccessEnvelope(created, 201);
  const deleted = await deleteAnime(created.body.data.id);
  assertSuccessEnvelope(deleted, 200);

  const res = await getAnimeList({ search: 'delete-hidden-list' });

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.data.some((anime) => anime.id === created.body.data.id), false);
});

test('deleted Anime is hidden from admin detail', async () => {
  const created = await postAnime('delete-hidden-detail');
  assertSuccessEnvelope(created, 201);
  const deleted = await deleteAnime(created.body.data.id);
  assertSuccessEnvelope(deleted, 200);

  const res = await getAnimeDetail(created.body.data.id);

  assertErrorEnvelope(res, 404);
});

test('deleted Anime slug can be reused', async () => {
  const slug = slugFor('reusable-after-delete');
  const created = await postAnime('delete-reuse-original', { slug });
  assertSuccessEnvelope(created, 201);
  const deleted = await deleteAnime(created.body.data.id);
  assertSuccessEnvelope(deleted, 200);

  const replacement = await postAnime('delete-reuse-replacement', { slug });

  assertSuccessEnvelope(replacement, 201);
  assert.equal(replacement.body.data.slug, slug);
});

test('soft deleting Anime does not delete related Video', async () => {
  const created = await postAnime('delete-video-retained', {
    type: 'movie',
    primaryVideoId: primaryVideo.id,
  });
  assertSuccessEnvelope(created, 201);
  const deleted = await deleteAnime(created.body.data.id);
  assertSuccessEnvelope(deleted, 200);

  const video = await VideoModel.findById(primaryVideo.id);

  assert.ok(video);
  assert.equal(video.isDeleted, false);
});

test('repeated delete returns 404 after soft deletion', async () => {
  const created = await postAnime('delete-repeat');
  assertSuccessEnvelope(created, 201);
  const first = await deleteAnime(created.body.data.id);
  assertSuccessEnvelope(first, 200);

  const second = await deleteAnime(created.body.data.id);

  assertErrorEnvelope(second, 404);
});

test('success envelope remains consistent for admin lifecycle responses', async () => {
  const created = await postAnime('success-envelope');
  assertSuccessEnvelope(created, 201);
  const updated = await patchAnime(created.body.data.id, { shortDescription: 'Envelope check' });

  assertSuccessEnvelope(updated, 200);
  assert.equal(updated.body.pagination, undefined);
});

test('error envelope remains consistent for admin Anime errors', async () => {
  const res = await getAnimeDetail('not-an-object-id');

  assertErrorEnvelope(res, 400);
  assert.equal(res.body.detail, undefined);
});

test('production-style admin errors do not expose stack traces', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  try {
    const res = await getAnimeDetail('not-an-object-id');

    assertErrorEnvelope(res, 400);
    assert.equal(res.body.detail, undefined);
    assert.doesNotMatch(res.text, /adminAnime\.service/);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test('admin Anime responses do not expose credentials or tokens', async () => {
  const created = await postAnime('no-credentials');
  assertSuccessEnvelope(created, 201);
  const list = await getAnimeList({ search: 'no-credentials' });

  const responseText = JSON.stringify({ created: created.body, list: list.body });
  assert.equal(responseText.includes('password'), false);
  assert.equal(responseText.includes('refreshToken'), false);
  assert.equal(responseText.includes('accessToken'), false);
});

test('admin Anime responses do not generate or persist signed media URLs', async () => {
  const created = await postAnime('no-media-urls', {
    type: 'movie',
    primaryVideoId: primaryVideo.id,
  });
  assertSuccessEnvelope(created, 201);

  assert.equal(created.body.data.videoUrl, undefined);
  assert.equal(created.body.data.hlsUrl, undefined);
  assert.equal(created.body.data.signedUrl, undefined);
});

test('admin Anime responses hide internal MongoDB fields', async () => {
  const created = await postAnime('hide-internals');
  assertSuccessEnvelope(created, 201);

  const detail = await getAnimeDetail(created.body.data.id);
  assertSuccessEnvelope(detail, 200);

  assert.equal(detail.body.data._id, undefined);
  assert.equal(detail.body.data.__v, undefined);
  assert.equal(detail.body.data.deletedAt, undefined);
});
