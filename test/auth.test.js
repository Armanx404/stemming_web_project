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
  { default: express },
  { default: mongoose },
  { default: bcrypt },
  { default: jwt },
  { default: app },
  { default: connectDB },
  { default: UserModel },
  { protect, requireAdmin },
  { refreshCookieOptions, clearRefreshCookieOptions },
  { sanitizeForLog },
  { hashRefreshToken },
  { getRedisClient },
] = await Promise.all([
  import('supertest'),
  import('express'),
  import('mongoose'),
  import('bcryptjs'),
  import('jsonwebtoken'),
  import('../src/app.js'),
  import('../src/config/db.js'),
  import('../src/models/user.model.js'),
  import('../src/middleware/auth.middleware.js'),
  import('../src/controllers/auth.controller.js'),
  import('../src/middleware/error.middleware.js'),
  import('../src/services/auth.service.js'),
  import('../src/config/redis.config.js'),
]);

const TEST_RUN_ID = Date.now().toString(36).slice(-8);
const TEST_PREFIX = `ct${TEST_RUN_ID}`;
const TEST_EMAIL_PREFIX = `${TEST_PREFIX}_`;
const VALID_PASSWORD = 'Phase2ValidPass123!';

function usernameFor(label) {
  return `${TEST_PREFIX}_${label}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 30);
}

function emailFor(label) {
  return `${TEST_EMAIL_PREFIX}${label}@example.test`;
}

function getRefreshSetCookie(res) {
  const setCookies = res.headers['set-cookie'];
  assert.ok(Array.isArray(setCookies), `expected Set-Cookie header, got ${res.text}`);

  const refreshCookie = setCookies.find((cookie) => cookie.startsWith('refreshToken='));
  assert.ok(refreshCookie, `expected refreshToken Set-Cookie header, got ${setCookies.join(' | ')}`);

  return refreshCookie;
}

function refreshTokenFromSetCookie(setCookie) {
  return decodeURIComponent(setCookie.split(';')[0].slice('refreshToken='.length));
}

function cookieHeaderFromSetCookie(setCookie) {
  return setCookie.split(';')[0];
}

function assertNoSensitiveUserFields(user) {
  assert.equal(user.password, undefined);
  assert.equal(user.refreshToken, undefined);
  assert.equal(user.isActive, undefined);
}

async function cleanupTestUsers() {
  await UserModel.deleteMany({
    email: { $regex: `^${TEST_EMAIL_PREFIX}` },
  });
}

async function registerUser(label, overrides = {}) {
  const email = overrides.email || emailFor(label);
  const username = overrides.username || usernameFor(label);
  const password = overrides.password || VALID_PASSWORD;

  const res = await request(app)
    .post('/auth/register')
    .send({ username, email, password });

  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.success, true);

  const refreshSetCookie = getRefreshSetCookie(res);

  return {
    email,
    username,
    password,
    res,
    user: res.body.data.user,
    accessToken: res.body.data.accessToken,
    refreshSetCookie,
    refreshCookieHeader: cookieHeaderFromSetCookie(refreshSetCookie),
    refreshToken: refreshTokenFromSetCookie(refreshSetCookie),
  };
}

async function loginUser(email, password = VALID_PASSWORD) {
  const res = await request(app)
    .post('/auth/login')
    .send({ email, password });

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.success, true);

  const refreshSetCookie = getRefreshSetCookie(res);

  return {
    res,
    user: res.body.data.user,
    accessToken: res.body.data.accessToken,
    refreshSetCookie,
    refreshCookieHeader: cookieHeaderFromSetCookie(refreshSetCookie),
    refreshToken: refreshTokenFromSetCookie(refreshSetCookie),
  };
}

before(async () => {
  await connectDB();
  await cleanupTestUsers();
});

after(async () => {
  await cleanupTestUsers();
  await mongoose.disconnect();
  try {
    getRedisClient().disconnect();
  } catch {
    // No Redis client was created.
  }
});

test('successful registration hashes password and stores a hashed refresh token', async () => {
  const account = await registerUser('regok');

  assert.ok(account.accessToken);
  assertNoSensitiveUserFields(account.user);

  assert.match(account.refreshSetCookie, /HttpOnly/i);
  assert.match(account.refreshSetCookie, /SameSite=Strict/i);
  assert.equal(/;\s*Secure/i.test(account.refreshSetCookie), false);

  const dbUser = await UserModel.findOne({ email: account.email }).select('+password +refreshToken');
  assert.ok(dbUser);
  assert.notEqual(dbUser.password, account.password);
  assert.equal(await bcrypt.compare(account.password, dbUser.password), true);
  assert.ok(dbUser.refreshToken);
  assert.notEqual(dbUser.refreshToken, account.refreshToken);
  assert.equal(dbUser.refreshToken, hashRefreshToken(account.refreshToken));
});

test('registration rejects invalid field types', async () => {
  const res = await request(app)
    .post('/auth/register')
    .send({ username: 123, email: ['bad@example.test'], password: { value: 'bad' } });

  assert.equal(res.status, 400, res.text);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /required/i);
});

test('duplicate email registration returns conflict', async () => {
  const account = await registerUser('dupe');

  const res = await request(app)
    .post('/auth/register')
    .send({
      username: usernameFor('dupe2'),
      email: account.email,
      password: VALID_PASSWORD,
    });

  assert.equal(res.status, 409, res.text);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /Duplicate value for email/i);
});

test('successful login returns tokens and no sensitive user fields', async () => {
  const account = await registerUser('loginok');
  const login = await loginUser(account.email, account.password);

  assert.ok(login.accessToken);
  assert.equal(login.user.email, account.email);
  assertNoSensitiveUserFields(login.user);
  assert.match(login.refreshSetCookie, /HttpOnly/i);
});

test('incorrect password returns the generic login failure', async () => {
  const account = await registerUser('badpass');

  const res = await request(app)
    .post('/auth/login')
    .send({ email: account.email, password: 'WrongPassword123!' });

  assert.equal(res.status, 401, res.text);
  assert.equal(res.body.success, false);
  assert.equal(res.body.message, 'Invalid email or password.');
  assert.equal(res.body.data, undefined);
});

test('login rejects malformed input', async () => {
  const typeRes = await request(app)
    .post('/auth/login')
    .send({ email: 42, password: 'x' });

  assert.equal(typeRes.status, 400, typeRes.text);
  assert.equal(typeRes.body.success, false);

  const emailRes = await request(app)
    .post('/auth/login')
    .send({ email: 'not-an-email', password: VALID_PASSWORD });

  assert.equal(emailRes.status, 400, emailRes.text);
  assert.equal(emailRes.body.success, false);
  assert.match(emailRes.body.message, /valid email/i);
});

test('GET /auth/me without a token returns 401', async () => {
  const res = await request(app).get('/auth/me');

  assert.equal(res.status, 401, res.text);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /Bearer token/i);
});

test('GET /auth/me with a valid access token returns the profile', async () => {
  const account = await registerUser('meok');

  const res = await request(app)
    .get('/auth/me')
    .set('Authorization', `Bearer ${account.accessToken}`);

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.email, account.email);
  assertNoSensitiveUserFields(res.body.data);
});

test('refresh-token rotation replaces the stored refresh hash', async () => {
  const account = await registerUser('rotate');

  const res = await request(app)
    .post('/auth/refresh')
    .set('Cookie', account.refreshCookieHeader)
    .send({});

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.success, true);
  assert.ok(res.body.data.accessToken);

  const newRefreshSetCookie = getRefreshSetCookie(res);
  const newRefreshToken = refreshTokenFromSetCookie(newRefreshSetCookie);
  assert.notEqual(newRefreshToken, account.refreshToken);

  const dbUser = await UserModel.findOne({ email: account.email }).select('+refreshToken');
  assert.ok(dbUser.refreshToken);
  assert.equal(dbUser.refreshToken, hashRefreshToken(newRefreshToken));
  assert.notEqual(dbUser.refreshToken, hashRefreshToken(account.refreshToken));
});

test('refresh-token reuse detection wipes the stored session', async () => {
  const account = await registerUser('reuse');

  const rotateRes = await request(app)
    .post('/auth/refresh')
    .set('Cookie', account.refreshCookieHeader)
    .send({});

  assert.equal(rotateRes.status, 200, rotateRes.text);
  const rotatedRefreshToken = refreshTokenFromSetCookie(getRefreshSetCookie(rotateRes));

  const reuseRes = await request(app)
    .post('/auth/refresh')
    .send({ refreshToken: account.refreshToken });

  assert.equal(reuseRes.status, 401, reuseRes.text);
  assert.equal(reuseRes.body.success, false);
  assert.match(reuseRes.body.message, /suspicious activity/i);

  const dbUser = await UserModel.findOne({ email: account.email }).select('+refreshToken');
  assert.equal(dbUser.refreshToken, null);

  const rotatedRes = await request(app)
    .post('/auth/refresh')
    .send({ refreshToken: rotatedRefreshToken });

  assert.equal(rotatedRes.status, 401, rotatedRes.text);
});

test('logout clears the refresh cookie and invalidates refresh', async () => {
  const account = await registerUser('logout');

  const res = await request(app)
    .post('/auth/logout')
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({});

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.success, true);

  const clearCookie = getRefreshSetCookie(res);
  assert.match(clearCookie, /^refreshToken=;/);
  assert.match(clearCookie, /Expires=Thu, 01 Jan 1970/i);
  assert.match(clearCookie, /HttpOnly/i);

  const dbUser = await UserModel.findOne({ email: account.email }).select('+refreshToken');
  assert.equal(dbUser.refreshToken, null);

  const refreshRes = await request(app)
    .post('/auth/refresh')
    .send({ refreshToken: account.refreshToken });

  assert.equal(refreshRes.status, 401, refreshRes.text);
});

test('JWT verification rejects unexpected algorithms and expired tokens', async () => {
  const account = await registerUser('jwtalg');

  const hs384Token = jwt.sign(
    { sub: account.user.id, role: 'user' },
    process.env.JWT_SECRET,
    { algorithm: 'HS384', expiresIn: '5m' }
  );

  const algorithmRes = await request(app)
    .get('/auth/me')
    .set('Authorization', `Bearer ${hs384Token}`);

  assert.equal(algorithmRes.status, 401, algorithmRes.text);
  assert.equal(algorithmRes.body.message, 'Access token is invalid.');

  const expiredAccessToken = jwt.sign(
    { sub: account.user.id, role: 'user' },
    process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: -1 }
  );

  const expiredAccessRes = await request(app)
    .get('/auth/me')
    .set('Authorization', `Bearer ${expiredAccessToken}`);

  assert.equal(expiredAccessRes.status, 401, expiredAccessRes.text);
  assert.match(expiredAccessRes.body.message, /expired/i);

  const expiredRefreshToken = jwt.sign(
    { sub: account.user.id, role: 'user' },
    process.env.JWT_REFRESH_SECRET,
    { algorithm: 'HS256', expiresIn: -1 }
  );

  const expiredRefreshRes = await request(app)
    .post('/auth/refresh')
    .send({ refreshToken: expiredRefreshToken });

  assert.equal(expiredRefreshRes.status, 401, expiredRefreshRes.text);
  assert.match(expiredRefreshRes.body.message, /expired/i);
});

test('password and refresh-token values are redacted from log metadata', () => {
  const sanitized = sanitizeForLog({
    email: 'safe@example.test',
    password: 'plain-password',
    nested: {
      refreshToken: 'refresh-token',
      accessToken: 'access-token',
      safe: 'visible',
    },
    list: [{ secret: 'hidden' }],
  });

  assert.equal(sanitized.email, 'safe@example.test');
  assert.equal(sanitized.password, '[REDACTED]');
  assert.equal(sanitized.nested.refreshToken, '[REDACTED]');
  assert.equal(sanitized.nested.accessToken, '[REDACTED]');
  assert.equal(sanitized.nested.safe, 'visible');
  assert.equal(sanitized.list[0].secret, '[REDACTED]');
});

test('development and production refresh-cookie options are secure', () => {
  const developmentCookie = refreshCookieOptions({
    nodeEnv: 'development',
    maxAge: 12345,
  });
  const productionCookie = refreshCookieOptions({
    nodeEnv: 'production',
    maxAge: 12345,
  });
  const productionClearCookie = clearRefreshCookieOptions({
    nodeEnv: 'production',
  });

  assert.deepEqual(developmentCookie, {
    httpOnly: true,
    secure: false,
    sameSite: 'strict',
    maxAge: 12345,
  });

  assert.deepEqual(productionCookie, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 12345,
  });

  assert.deepEqual(productionClearCookie, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
  });
});

test('role and admin authorization allows admins and rejects regular users', async () => {
  const regularUser = await registerUser('regular');
  const adminEmail = emailFor('admin');

  await UserModel.create({
    username: usernameFor('admin'),
    email: adminEmail,
    password: VALID_PASSWORD,
    role: 'admin',
  });

  const adminLogin = await loginUser(adminEmail, VALID_PASSWORD);

  const adminOnlyApp = express();
  adminOnlyApp.get('/admin-only', protect, requireAdmin, (_req, res) => {
    res.status(200).json({ success: true });
  });

  const regularRes = await request(adminOnlyApp)
    .get('/admin-only')
    .set('Authorization', `Bearer ${regularUser.accessToken}`);

  assert.equal(regularRes.status, 403, regularRes.text);
  assert.equal(regularRes.body.success, false);

  const adminRes = await request(adminOnlyApp)
    .get('/admin-only')
    .set('Authorization', `Bearer ${adminLogin.accessToken}`);

  assert.equal(adminRes.status, 200, adminRes.text);
  assert.equal(adminRes.body.success, true);
});
