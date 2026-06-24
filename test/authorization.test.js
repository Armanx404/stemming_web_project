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
  { default: jwt },
  { default: app },
  { default: connectDB },
  { default: UserModel },
  {
    protect,
    requireAdmin,
    requireRole,
    requireSuperadmin,
  },
  { globalErrorHandler },
  { getRedisClient },
] = await Promise.all([
  import('supertest'),
  import('express'),
  import('mongoose'),
  import('jsonwebtoken'),
  import('../src/app.js'),
  import('../src/config/db.js'),
  import('../src/models/user.model.js'),
  import('../src/middleware/auth.middleware.js'),
  import('../src/middleware/error.middleware.js'),
  import('../src/config/redis.config.js'),
]);

const TEST_RUN_ID = Date.now().toString(36).slice(-8);
const TEST_PREFIX = `authz${TEST_RUN_ID}`;
const TEST_EMAIL_PREFIX = `${TEST_PREFIX}_`;
const VALID_PASSWORD = 'Phase3AuthzPass123!';

const users = {};
const tokens = {};

function usernameFor(label) {
  return `${TEST_PREFIX}_${label}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 30);
}

function emailFor(label) {
  return `${TEST_EMAIL_PREFIX}${label}@example.test`;
}

async function cleanupTestUsers() {
  await UserModel.deleteMany({
    email: { $regex: `^${TEST_EMAIL_PREFIX}` },
  });
}

async function createUser(label, role = 'user', overrides = {}) {
  return UserModel.create({
    username: usernameFor(label),
    email: emailFor(label),
    password: VALID_PASSWORD,
    role,
    ...overrides,
  });
}

function signPayload(payload, options = {}) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '10m',
    ...options,
  });
}

function signUserToken(user, payloadOverrides = {}, options = {}) {
  return signPayload(
    {
      sub: user.id,
      role: user.role,
      ...payloadOverrides,
    },
    options,
  );
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

function bearer(token) {
  return `Bearer ${token}`;
}

function assertErrorEnvelope(res, statusCode) {
  assert.equal(res.status, statusCode, res.text);
  assert.equal(res.body.success, false);
  assert.equal(typeof res.body.message, 'string');
  assert.equal(res.body.data, undefined);
}

function assertNoSensitiveFields(data) {
  assert.equal(data.hasPassword, false);
  assert.equal(data.hasRefreshToken, false);
  assert.equal(data.password, undefined);
  assert.equal(data.refreshToken, undefined);
}

function okRoute(name) {
  return (req, res) => {
    res.status(200).json({
      success: true,
      route: name,
      user: {
        id: req.user.id,
        role: req.user.role,
        hasPassword: req.user.password !== undefined,
        hasRefreshToken: req.user.refreshToken !== undefined,
        password: req.user.password,
        refreshToken: req.user.refreshToken,
      },
    });
  };
}

function buildAuthorizationApp() {
  const authorizationApp = express();
  authorizationApp.use(express.json());

  authorizationApp.get('/auth-only', protect, okRoute('auth-only'));
  authorizationApp.get('/moderator-only', protect, requireRole('moderator'), okRoute('moderator-only'));
  authorizationApp.get(
    '/moderator-content',
    protect,
    requireRole('moderator', 'admin', 'superadmin'),
    okRoute('moderator-content'),
  );
  authorizationApp.get('/admin-only', protect, requireAdmin, okRoute('admin-only'));
  authorizationApp.get('/superadmin-only', protect, requireSuperadmin, okRoute('superadmin-only'));
  authorizationApp.get('/missing-user-role', requireRole('admin'), okRoute('missing-user-role'));
  authorizationApp.get('/boom', (_req, _res, next) => {
    next(new Error('Authorization stack marker'));
  });
  authorizationApp.use(globalErrorHandler);

  return authorizationApp;
}

function mockResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

const authorizationApp = buildAuthorizationApp();

before(async () => {
  await connectDB();
  await cleanupTestUsers();

  users.regular = await createUser('regular', 'user');
  users.moderator = await createUser('moderator', 'moderator');
  users.admin = await createUser('admin', 'admin');
  users.superadmin = await createUser('superadmin', 'superadmin');
  users.inactive = await createUser('inactive', 'user', { isActive: false });

  await UserModel.findByIdAndUpdate(users.regular._id, {
    refreshToken: 'a'.repeat(64),
  });

  tokens.regular = signUserToken(users.regular);
  tokens.moderator = signUserToken(users.moderator);
  tokens.admin = signUserToken(users.admin);
  tokens.superadmin = signUserToken(users.superadmin);
  tokens.inactive = signUserToken(users.inactive);
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

test('no Authorization header returns 401 with a safe error envelope', async () => {
  const res = await request(authorizationApp).get('/auth-only');

  assertErrorEnvelope(res, 401);
  assert.match(res.body.message, /Bearer token/i);
});

test('wrong authorization scheme returns 401', async () => {
  const res = await request(authorizationApp)
    .get('/auth-only')
    .set('Authorization', `Token ${tokens.regular}`);

  assertErrorEnvelope(res, 401);
});

test('malformed JWT returns 401', async () => {
  const res = await request(authorizationApp)
    .get('/auth-only')
    .set('Authorization', 'Bearer not-a-jwt');

  assertErrorEnvelope(res, 401);
  assert.equal(res.body.message, 'Access token is invalid.');
});

test('expired JWT returns 401', async () => {
  const expiredToken = signUserToken(users.regular, {}, { expiresIn: -1 });

  const res = await request(authorizationApp)
    .get('/auth-only')
    .set('Authorization', bearer(expiredToken));

  assertErrorEnvelope(res, 401);
  assert.match(res.body.message, /expired/i);
});

test('JWT signed with an unapproved algorithm is rejected', async () => {
  const hs384Token = jwt.sign(
    { sub: users.regular.id, role: 'user' },
    process.env.JWT_SECRET,
    { algorithm: 'HS384', expiresIn: '10m' },
  );

  const res = await request(authorizationApp)
    .get('/auth-only')
    .set('Authorization', bearer(hs384Token));

  assertErrorEnvelope(res, 401);
  assert.equal(res.body.message, 'Access token is invalid.');
});

test('tokens without a valid subject are rejected', async () => {
  const missingSubject = signPayload({ role: 'user' });
  const invalidSubject = signPayload({ sub: 'not-an-object-id', role: 'user' });

  for (const token of [missingSubject, invalidSubject]) {
    const res = await request(authorizationApp)
      .get('/auth-only')
      .set('Authorization', bearer(token));

    assertErrorEnvelope(res, 401);
    assert.equal(res.body.message, 'Access token is invalid.');
  }
});

test('token for a nonexistent user returns 401', async () => {
  const nonexistentToken = signPayload({
    sub: new mongoose.Types.ObjectId().toString(),
    role: 'admin',
  });

  const res = await request(authorizationApp)
    .get('/auth-only')
    .set('Authorization', bearer(nonexistentToken));

  assertErrorEnvelope(res, 401);
});

test('valid user token allows the authenticated route', async () => {
  const res = await request(authorizationApp)
    .get('/auth-only')
    .set('Authorization', bearer(tokens.regular));

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data, undefined);
  assert.equal(res.body.user.role, 'user');
});

test('protect does not expose password or refresh-token fields on req.user', async () => {
  const res = await request(authorizationApp)
    .get('/auth-only')
    .set('Authorization', bearer(tokens.regular));

  assert.equal(res.status, 200, res.text);
  assertNoSensitiveFields(res.body.user);
});

test('normal user passes authenticated-user route', async () => {
  const res = await request(authorizationApp)
    .get('/auth-only')
    .set('Authorization', bearer(tokens.regular));

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.user.role, 'user');
});

test('normal user fails moderator route', async () => {
  const res = await request(authorizationApp)
    .get('/moderator-only')
    .set('Authorization', bearer(tokens.regular));

  assertErrorEnvelope(res, 403);
});

test('normal user fails admin route', async () => {
  const res = await request(authorizationApp)
    .get('/admin-only')
    .set('Authorization', bearer(tokens.regular));

  assertErrorEnvelope(res, 403);
});

test('normal user fails superadmin route', async () => {
  const res = await request(authorizationApp)
    .get('/superadmin-only')
    .set('Authorization', bearer(tokens.regular));

  assertErrorEnvelope(res, 403);
});

test('moderator passes moderator-authorized route', async () => {
  const res = await request(authorizationApp)
    .get('/moderator-only')
    .set('Authorization', bearer(tokens.moderator));

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.user.role, 'moderator');
});

test('moderator fails admin route', async () => {
  const res = await request(authorizationApp)
    .get('/admin-only')
    .set('Authorization', bearer(tokens.moderator));

  assertErrorEnvelope(res, 403);
});

test('moderator fails superadmin route', async () => {
  const res = await request(authorizationApp)
    .get('/superadmin-only')
    .set('Authorization', bearer(tokens.moderator));

  assertErrorEnvelope(res, 403);
});

test('admin passes admin route', async () => {
  const res = await request(authorizationApp)
    .get('/admin-only')
    .set('Authorization', bearer(tokens.admin));

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.user.role, 'admin');
});

test('admin fails moderator-only route because requireRole is exact-match', async () => {
  const res = await request(authorizationApp)
    .get('/moderator-only')
    .set('Authorization', bearer(tokens.admin));

  assertErrorEnvelope(res, 403);
});

test('admin fails superadmin route', async () => {
  const res = await request(authorizationApp)
    .get('/superadmin-only')
    .set('Authorization', bearer(tokens.admin));

  assertErrorEnvelope(res, 403);
});

test('superadmin passes admin route', async () => {
  const res = await request(authorizationApp)
    .get('/admin-only')
    .set('Authorization', bearer(tokens.superadmin));

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.user.role, 'superadmin');
});

test('superadmin passes superadmin route', async () => {
  const res = await request(authorizationApp)
    .get('/superadmin-only')
    .set('Authorization', bearer(tokens.superadmin));

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.user.role, 'superadmin');
});

test('moderator content route explicitly allows moderator, admin, and superadmin', async () => {
  for (const token of [tokens.moderator, tokens.admin, tokens.superadmin]) {
    const res = await request(authorizationApp)
      .get('/moderator-content')
      .set('Authorization', bearer(token));

    assert.equal(res.status, 200, res.text);
  }
});

test('unknown configured role fails safely at route construction', () => {
  assert.throws(
    () => requireRole('owner'),
    /Unknown authorization role configured/,
  );
});

test('role middleware without req.user fails safely', async () => {
  const res = await request(authorizationApp).get('/missing-user-role');

  assertErrorEnvelope(res, 401);
});

test('registration request containing role admin still creates a normal user', async () => {
  const res = await request(app)
    .post('/auth/register')
    .send({
      username: usernameFor('reg_admin'),
      email: emailFor('reg_admin'),
      password: VALID_PASSWORD,
      role: 'admin',
    });

  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.data.user.role, 'user');

  const dbUser = await UserModel.findOne({ email: emailFor('reg_admin') });
  assert.equal(dbUser.role, 'user');
});

test('registration request containing role moderator still creates a normal user', async () => {
  const res = await request(app)
    .post('/auth/register')
    .send({
      username: usernameFor('reg_mod'),
      email: emailFor('reg_mod'),
      password: VALID_PASSWORD,
      role: 'moderator',
    });

  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.data.user.role, 'user');

  const dbUser = await UserModel.findOne({ email: emailFor('reg_mod') });
  assert.equal(dbUser.role, 'user');
});

test('registration request containing role superadmin still creates a normal user', async () => {
  const res = await request(app)
    .post('/auth/register')
    .send({
      username: usernameFor('reg_super'),
      email: emailFor('reg_super'),
      password: VALID_PASSWORD,
      role: 'superadmin',
    });

  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.data.user.role, 'user');

  const dbUser = await UserModel.findOne({ email: emailFor('reg_super') });
  assert.equal(dbUser.role, 'user');
});

test('auth endpoints do not let API clients change roles', async () => {
  const account = await createUser('rolechange', 'user');

  const loginRes = await request(app)
    .post('/auth/login')
    .send({
      email: account.email,
      password: VALID_PASSWORD,
      role: 'admin',
    });

  assert.equal(loginRes.status, 200, loginRes.text);
  assert.equal(loginRes.body.data.user.role, 'user');

  const refreshToken = refreshTokenFromSetCookie(getRefreshSetCookie(loginRes));
  const refreshRes = await request(app)
    .post('/auth/refresh')
    .send({
      refreshToken,
      role: 'superadmin',
    });

  assert.equal(refreshRes.status, 200, refreshRes.text);

  const dbUser = await UserModel.findById(account._id);
  assert.equal(dbUser.role, 'user');
});

test('JWT role claim does not override the database role', async () => {
  const elevatedClaimToken = signUserToken(users.regular, { role: 'superadmin' });

  const res = await request(authorizationApp)
    .get('/admin-only')
    .set('Authorization', bearer(elevatedClaimToken));

  assertErrorEnvelope(res, 403);
});

test('inactive user token is rejected', async () => {
  const res = await request(authorizationApp)
    .get('/auth-only')
    .set('Authorization', bearer(tokens.inactive));

  assertErrorEnvelope(res, 401);
});

test('previously valid token fails after the database user is disabled', async () => {
  const account = await createUser('disable_after', 'user');
  const token = signUserToken(account);

  const allowedRes = await request(authorizationApp)
    .get('/auth-only')
    .set('Authorization', bearer(token));
  assert.equal(allowedRes.status, 200, allowedRes.text);

  await UserModel.findByIdAndUpdate(account._id, { isActive: false });

  const disabledRes = await request(authorizationApp)
    .get('/auth-only')
    .set('Authorization', bearer(token));
  assertErrorEnvelope(disabledRes, 401);
});

test('previously valid token fails after the database user is deleted', async () => {
  const account = await createUser('delete_after', 'user');
  const token = signUserToken(account);

  const allowedRes = await request(authorizationApp)
    .get('/auth-only')
    .set('Authorization', bearer(token));
  assert.equal(allowedRes.status, 200, allowedRes.text);

  await UserModel.findByIdAndDelete(account._id);

  const deletedRes = await request(authorizationApp)
    .get('/auth-only')
    .set('Authorization', bearer(token));
  assertErrorEnvelope(deletedRes, 401);
});

test('forbidden role returns a consistent response shape', async () => {
  const res = await request(authorizationApp)
    .get('/admin-only')
    .set('Authorization', bearer(tokens.moderator));

  assertErrorEnvelope(res, 403);
  assert.equal(res.body.detail, undefined);
});

test('raw JWT is not logged during authorization rejection', async () => {
  const rawToken = 'raw.jwt.value';
  const captured = [];
  const originalError = console.error;

  console.error = (...args) => {
    captured.push(args.join(' '));
  };

  try {
    const res = await request(authorizationApp)
      .get('/auth-only')
      .set('Authorization', bearer(rawToken));

    assertErrorEnvelope(res, 401);
  } finally {
    console.error = originalError;
  }

  assert.equal(captured.join('\n').includes(rawToken), false);
});

test('production-style error responses do not expose stack traces', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  try {
    const res = await request(authorizationApp).get('/boom');

    assert.equal(res.status, 500, res.text);
    assert.equal(res.body.success, false);
    assert.equal(res.body.message, 'An unexpected error occurred. Please try again later.');
    assert.equal(res.body.detail, undefined);
    assert.doesNotMatch(res.text, /Authorization stack marker/);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test('existing /auth/me without token behavior remains 401', async () => {
  const res = await request(app).get('/auth/me');

  assertErrorEnvelope(res, 401);
});

test('existing /auth/me valid-token behavior remains correct', async () => {
  const res = await request(app)
    .get('/auth/me')
    .set('Authorization', bearer(tokens.regular));

  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.email, users.regular.email);
  assert.equal(res.body.data.password, undefined);
  assert.equal(res.body.data.refreshToken, undefined);
});

test('requireAdmin remains backward-compatible for admin and superadmin roles', () => {
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
