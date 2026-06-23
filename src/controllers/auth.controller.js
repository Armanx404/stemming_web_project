/**
 * src/controllers/auth.controller.js — Auth HTTP Layer
 *
 * Controllers are intentionally thin:
 *   1. Validate raw HTTP input (presence only — not business rules)
 *   2. Call the appropriate service method
 *   3. Format and send the HTTP response
 *
 * All business logic lives in auth.service.js.
 * All async errors are caught by asyncHandler and forwarded to globalErrorHandler.
 *
 * Refresh token transport:
 *   Sent as an httpOnly, Secure, SameSite=Strict cookie — never in the JSON body.
 *   This prevents XSS attacks from stealing the token via document.cookie.
 *   Mobile clients that cannot use cookies should send the refresh token in the
 *   request body; both paths are supported in the refresh handler.
 */

'use strict';

import { StatusCodes } from 'http-status-codes';
import {
  login as loginService,
  logout as logoutService,
  refresh as refreshService,
  register as registerService,
} from '../services/auth.service.js';
import { successResponse, errorResponse } from '../utils/response.js';

const DEFAULT_REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const EMAIL_PATTERN = /^\S+@\S+\.\S+$/;

// ─── Cookie Config ────────────────────────────────────────────────────────────

/**
 * refreshCookieOptions
 * Centralised cookie config so all handlers stay in sync.
 * secure:true is automatically applied in production.
 */
function getRefreshCookieMaxAge() {
  const configuredValue = Number(process.env.JWT_REFRESH_COOKIE_MAX_AGE_MS);
  return Number.isFinite(configuredValue) && configuredValue > 0
    ? configuredValue
    : DEFAULT_REFRESH_COOKIE_MAX_AGE_MS;
}

function refreshCookieOptions({
  nodeEnv = process.env.NODE_ENV,
  maxAge = getRefreshCookieMaxAge(),
} = {}) {
  return {
    httpOnly: true,
    secure: nodeEnv === 'production',
    sameSite: 'strict',
    maxAge,
  };
}

function clearRefreshCookieOptions({ nodeEnv = process.env.NODE_ENV } = {}) {
  return {
    httpOnly: true,
    secure: nodeEnv === 'production',
    sameSite: 'strict',
  };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateRegistrationPayload(body = {}) {
  const { username, email, password } = body;

  if (!isNonEmptyString(username) || !isNonEmptyString(email) || !isNonEmptyString(password)) {
    return { error: 'username, email, and password are all required.' };
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalizedEmail)) {
    return { error: 'A valid email address is required.' };
  }

  return {
    value: {
      username: username.trim(),
      email: normalizedEmail,
      password,
    },
  };
}

function validateLoginPayload(body = {}) {
  const { email, password } = body;

  if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
    return { error: 'Email and password are required.' };
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalizedEmail)) {
    return { error: 'A valid email address is required.' };
  }

  return {
    value: {
      email: normalizedEmail,
      password,
    },
  };
}

function getRefreshTokenFromRequest(req) {
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  return isNonEmptyString(token) ? token.trim() : null;
}

// ─── POST /auth/register ──────────────────────────────────────────────────────

/**
 * register — Create a new user account.
 *
 * Required body fields: username, email, password
 * Returns: accessToken in JSON body + refreshToken in httpOnly cookie
 */
const register = async (req, res) => {
  const { value, error } = validateRegistrationPayload(req.body);

  if (error) {
    return res
      .status(StatusCodes.BAD_REQUEST)
      .json(errorResponse(error));
  }

  const { username, email, password } = value;

  const { user, accessToken, refreshToken } = await registerService({
    username: username.trim(),
    email: email.trim().toLowerCase(),
    password, // do NOT trim passwords — spaces can be intentional
  });

  res.cookie('refreshToken', refreshToken, refreshCookieOptions());

  return res
    .status(StatusCodes.CREATED)
    .json(successResponse('Account created successfully.', { user, accessToken }));
};

// ─── POST /auth/login ─────────────────────────────────────────────────────────

/**
 * login — Authenticate with email + password.
 *
 * Required body fields: email, password
 * Returns: accessToken in JSON body + refreshToken in httpOnly cookie
 *
 * The service layer returns the same "Invalid email or password" message for
 * both "user not found" and "wrong password" — prevents user enumeration.
 */
const login = async (req, res) => {
  const { value, error } = validateLoginPayload(req.body);

  if (error) {
    return res
      .status(StatusCodes.BAD_REQUEST)
      .json(errorResponse(error));
  }

  const { email, password } = value;

  const { user, accessToken, refreshToken } = await loginService({
    email: email.trim().toLowerCase(),
    password, // do NOT trim passwords
  });

  res.cookie('refreshToken', refreshToken, refreshCookieOptions());

  return res
    .status(StatusCodes.OK)
    .json(successResponse('Login successful.', { user, accessToken }));
};

// ─── POST /auth/refresh ───────────────────────────────────────────────────────

/**
 * refresh — Issue a new access token using the refresh token.
 *
 * Token source priority:
 *   1. httpOnly cookie (web clients)
 *   2. Request body field "refreshToken" (mobile clients)
 *
 * On success: old refresh token is invalidated, new pair issued.
 * Old refresh token presented again → all sessions wiped (reuse detection).
 */
const refresh = async (req, res) => {
  const token = getRefreshTokenFromRequest(req);

  if (!token) {
    return res
      .status(StatusCodes.UNAUTHORIZED)
      .json(errorResponse('Refresh token is required. Provide it in the cookie or request body.'));
  }

  const { accessToken, refreshToken } = await refreshService(token);

  res.cookie('refreshToken', refreshToken, refreshCookieOptions());

  return res
    .status(StatusCodes.OK)
    .json(successResponse('Token refreshed successfully.', { accessToken }));
};

// ─── POST /auth/logout ────────────────────────────────────────────────────────

/**
 * logout — Invalidate the current session.
 *
 * Requires: valid Bearer token (protect middleware populates req.user)
 * Clears the httpOnly cookie and nullifies the stored refresh token hash in DB.
 */
const logout = async (req, res) => {
  await logoutService(req.user.id);

  res.clearCookie('refreshToken', clearRefreshCookieOptions());

  return res
    .status(StatusCodes.OK)
    .json(successResponse('Logged out successfully.'));
};

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

/**
 * me — Return the authenticated user's profile.
 *
 * req.user is attached by the protect middleware.
 * Password and refreshToken are excluded by the UserSchema toJSON transform.
 */
const me = async (req, res) => {
  return res
    .status(StatusCodes.OK)
    .json(successResponse('User profile retrieved.', req.user));
};

export {
register,
login,
refresh,
logout,
me,
refreshCookieOptions,
clearRefreshCookieOptions,
};
