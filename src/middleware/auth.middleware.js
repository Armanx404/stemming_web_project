/**
 * src/middleware/auth.middleware.js - JWT authentication and authorization guards
 *
 * Role policy:
 *   - user: authenticated user only; no admin or moderator privileges.
 *   - moderator: authenticated user; can pass only routes that explicitly allow
 *     "moderator". Moderators do not pass requireAdmin.
 *   - admin: passes requireAdmin; does not pass superadmin-only checks.
 *   - superadmin: passes requireAdmin and requireSuperadmin.
 *
 * requireRole() uses exact role matching. Admin and superadmin access must be
 * listed explicitly on each route unless the route uses requireAdmin().
 */

'use strict';

import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { StatusCodes } from 'http-status-codes';
import UserModel from '../models/user.model.js';
import { errorResponse } from '../utils/response.js';

const JWT_VERIFY_OPTIONS = Object.freeze({ algorithms: ['HS256'] });

const AUTH_REQUIRED_MESSAGE = 'Authentication required. Provide a Bearer token.';
const INVALID_TOKEN_MESSAGE = 'Access token is invalid.';
const EXPIRED_TOKEN_MESSAGE = 'Access token has expired. Please refresh your session.';
const INACTIVE_USER_MESSAGE = 'User account not found or deactivated.';
const FORBIDDEN_MESSAGE = 'You do not have permission to access this resource.';
const ADMIN_REQUIRED_MESSAGE = 'Administrator access required.';
const SUPERADMIN_REQUIRED_MESSAGE = 'Superadmin access required.';

const VALID_ROLES = new Set(UserModel.schema.path('role').enumValues);
const ADMIN_ROLE_NAMES = ['admin', 'superadmin'];

function sendError(res, statusCode, message) {
  return res.status(statusCode).json(errorResponse(message));
}

function parseBearerToken(authHeader) {
  if (typeof authHeader !== 'string') return null;

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || !/^Bearer$/i.test(parts[0]) || !parts[1]) {
    return null;
  }

  return parts[1];
}

function isValidObjectId(value) {
  return typeof value === 'string' && mongoose.isObjectIdOrHexString(value);
}

function getUserId(user) {
  if (!user) return null;
  if (typeof user.id === 'string') return user.id;
  if (user._id) return user._id.toString();
  return null;
}

function isUnavailableUser(user) {
  if (!user) return true;
  if (user.isActive === false) return true;
  if (user.isDeleted === true) return true;
  if (user.disabled === true || user.isDisabled === true) return true;

  const deletedAt = typeof user.get === 'function' ? user.get('deletedAt') : user.deletedAt;
  return Boolean(deletedAt);
}

function normalizeConfiguredRoles(allowedRoles) {
  const roles = allowedRoles.flat();

  if (roles.length === 0) {
    throw new TypeError('requireRole requires at least one role.');
  }

  for (const role of roles) {
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      throw new TypeError(`Unknown authorization role configured: ${String(role)}`);
    }
  }

  return roles;
}

function createRoleMiddleware(allowedRoles, forbiddenMessage = FORBIDDEN_MESSAGE) {
  const roles = normalizeConfiguredRoles(allowedRoles);
  const allowed = new Set(roles);

  return (req, res, next) => {
    if (!req.user) {
      return sendError(res, StatusCodes.UNAUTHORIZED, AUTH_REQUIRED_MESSAGE);
    }

    if (!VALID_ROLES.has(req.user.role) || !allowed.has(req.user.role)) {
      return sendError(res, StatusCodes.FORBIDDEN, forbiddenMessage);
    }

    return next();
  };
}

/**
 * Validates a Bearer access token and attaches the current database user.
 * The database user is the source of truth for role authorization.
 */
const protect = async (req, res, next) => {
  const token = parseBearerToken(req.headers.authorization);
  if (!token) {
    return sendError(res, StatusCodes.UNAUTHORIZED, AUTH_REQUIRED_MESSAGE);
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, JWT_VERIFY_OPTIONS);
  } catch (err) {
    const message = err.name === 'TokenExpiredError'
      ? EXPIRED_TOKEN_MESSAGE
      : INVALID_TOKEN_MESSAGE;
    return sendError(res, StatusCodes.UNAUTHORIZED, message);
  }

  if (!isValidObjectId(decoded?.sub)) {
    return sendError(res, StatusCodes.UNAUTHORIZED, INVALID_TOKEN_MESSAGE);
  }

  let user;
  try {
    user = await UserModel.findById(decoded.sub).select('-password -refreshToken');
  } catch (err) {
    return next(err);
  }

  if (isUnavailableUser(user)) {
    return sendError(res, StatusCodes.UNAUTHORIZED, INACTIVE_USER_MESSAGE);
  }

  req.user = user;
  return next();
};

const requireRole = (...allowedRoles) => createRoleMiddleware(allowedRoles);

const requireAdmin = createRoleMiddleware(ADMIN_ROLE_NAMES, ADMIN_REQUIRED_MESSAGE);

const requireSuperadmin = createRoleMiddleware(['superadmin'], SUPERADMIN_REQUIRED_MESSAGE);

/**
 * Checks ownership of a stored resource. Owner identity is read only from the
 * persisted resource, never from the request body.
 */
const requireOwner = (Model, ownerField = 'uploadedBy') => async (req, res, next) => {
  if (!req.user) {
    return sendError(res, StatusCodes.UNAUTHORIZED, AUTH_REQUIRED_MESSAGE);
  }

  const currentUserId = getUserId(req.user);
  if (!currentUserId) {
    return sendError(res, StatusCodes.UNAUTHORIZED, AUTH_REQUIRED_MESSAGE);
  }

  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return sendError(res, StatusCodes.BAD_REQUEST, 'Invalid resource id.');
  }

  let resource;
  try {
    resource = await Model.findById(id);
  } catch (err) {
    return next(err);
  }

  if (!resource) {
    return sendError(res, StatusCodes.NOT_FOUND, 'Resource not found.');
  }

  if (ADMIN_ROLE_NAMES.includes(req.user.role)) {
    req.resource = resource;
    return next();
  }

  const ownerValue = resource[ownerField];
  const ownerId = ownerValue?._id ? ownerValue._id.toString() : ownerValue?.toString();

  if (!ownerId) {
    return sendError(res, StatusCodes.FORBIDDEN, 'This resource has no owner record. Admin access required.');
  }

  if (ownerId !== currentUserId) {
    return sendError(res, StatusCodes.FORBIDDEN, 'You do not have permission to modify this resource.');
  }

  req.resource = resource;
  return next();
};

export {
  protect,
  requireAdmin,
  requireOwner,
  requireRole,
  requireSuperadmin,
};
