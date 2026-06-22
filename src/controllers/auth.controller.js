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
import authService from '../services/auth.service.js';
import { successResponse, errorResponse } from '../utils/response.js';

// ─── Cookie Config ────────────────────────────────────────────────────────────

/**
 * refreshCookieOptions
 * Centralised cookie config so all handlers stay in sync.
 * secure:true is automatically applied in production.
 */
function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in ms
  };
}

// ─── POST /auth/register ──────────────────────────────────────────────────────

/**
 * register — Create a new user account.
 *
 * Required body fields: username, email, password
 * Returns: accessToken in JSON body + refreshToken in httpOnly cookie
 */
const register = async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res
      .status(StatusCodes.BAD_REQUEST)
      .json(errorResponse('username, email, and password are all required.'));
  }

  const { user, accessToken, refreshToken } = await authService.register({
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
  const { email, password } = req.body;

  if (!email || !password) {
    return res
      .status(StatusCodes.BAD_REQUEST)
      .json(errorResponse('Email and password are required.'));
  }

  const { user, accessToken, refreshToken } = await authService.login({
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
  const token = req.cookies?.refreshToken || req.body?.refreshToken;

  if (!token) {
    return res
      .status(StatusCodes.UNAUTHORIZED)
      .json(errorResponse('Refresh token is required. Provide it in the cookie or request body.'));
  }

  const { accessToken, refreshToken } = await authService.refresh(token);

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
  await authService.logout(req.user.id);

  res.clearCookie('refreshToken', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  });

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
register, login, refresh, logout, me
};
