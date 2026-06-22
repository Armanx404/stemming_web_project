/**
 * src/middleware/auth.middleware.js — JWT Verification + Ownership Guard
 *
 * Exports three middleware functions:
 *
 *   protect       — Requires a valid Bearer token. Attaches req.user.
 *   requireAdmin  — Requires role === 'admin'. Must come after protect.
 *   requireOwner  — Requires the requesting user to own the resource OR be admin.
 *                   Attach to DELETE / PATCH routes on resources with uploadedBy.
 *
 * Usage in routes:
 *   router.delete('/:id', protect, requireOwner(VideoModel, 'uploadedBy'), handler)
 *   router.post('/admin-only', protect, requireAdmin, handler)
 */

'use strict';

import jwt from 'jsonwebtoken';
import { StatusCodes } from 'http-status-codes';
import UserModel from '../models/user.model.js';
import { errorResponse } from '../utils/response.js';

// ─── protect ──────────────────────────────────────────────────────────────────

/**
 * Validates the Bearer token in Authorization header.
 * On success: attaches the full user document to req.user.
 * On failure: returns 401 immediately (never calls next with an error
 *   because we want a clean 401, not a 500 from the error handler).
 */
const protect = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res
      .status(StatusCodes.UNAUTHORIZED)
      .json(errorResponse('Authentication required. Provide a Bearer token.'));
  }

  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    const message =
      err.name === 'TokenExpiredError'
        ? 'Access token has expired. Please refresh your session.'
        : 'Access token is invalid.';
    return res.status(StatusCodes.UNAUTHORIZED).json(errorResponse(message));
  }

  // Fetch the user fresh on each request so deactivation takes immediate effect.
  // Phase 3 optimisation: cache this lookup in Redis with a short TTL (30s).
  const user = await UserModel.findById(decoded.sub).select('-refreshToken');

  if (!user || !user.isActive) {
    return res
      .status(StatusCodes.UNAUTHORIZED)
      .json(errorResponse('User account not found or deactivated.'));
  }

  req.user = user;
  next();
};

// ─── requireAdmin ─────────────────────────────────────────────────────────────

/**
 * Must be used AFTER protect.
 * Blocks non-admin users from accessing the route.
 */
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res
      .status(StatusCodes.FORBIDDEN)
      .json(errorResponse('Administrator access required.'));
  }
  next();
};

// ─── requireOwner ─────────────────────────────────────────────────────────────

/**
 * Factory middleware — returns a middleware that checks resource ownership.
 *
 * @param {mongoose.Model} Model          — The Mongoose model to query
 * @param {string}         ownerField     — The field on the document that holds the owner ID
 *
 * Usage:
 *   router.delete('/:id', protect, requireOwner(VideoModel, 'uploadedBy'), controller.deleteVideo)
 *
 * Logic:
 *   - Admin users bypass the ownership check entirely.
 *   - For regular users, the document's ownerField must match req.user.id.
 *   - Attaches the loaded document as req.resource so the controller
 *     doesn't need to fetch it again.
 */
const requireOwner = (Model, ownerField = 'uploadedBy') => async (req, res, next) => {
  const { id } = req.params;

  const resource = await Model.findById(id);

  if (!resource) {
    return res
      .status(StatusCodes.NOT_FOUND)
      .json(errorResponse('Resource not found.'));
  }

  // Admins can modify any resource
  if (req.user.role === 'admin') {
    req.resource = resource;
    return next();
  }

  // Handle legacy Phase 1 documents that have no owner — only admins can touch those
  if (!resource[ownerField]) {
    return res
      .status(StatusCodes.FORBIDDEN)
      .json(errorResponse('This resource has no owner record. Admin access required.'));
  }

  // Compare as strings to avoid ObjectId reference comparison issues
  if (resource[ownerField].toString() !== req.user.id) {
    return res
      .status(StatusCodes.FORBIDDEN)
      .json(errorResponse('You do not have permission to modify this resource.'));
  }

  req.resource = resource; // Attach so the controller can skip a second DB fetch
  next();
};

export {
protect, requireAdmin, requireOwner
};
