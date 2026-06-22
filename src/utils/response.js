/**
 * src/utils/response.js — Standardised API Response Envelope
 *
 * Every API response follows the same JSON structure so clients never have
 * to guess the shape of a success or error payload.
 *
 * Success envelope:
 * {
 *   "success": true,
 *   "message": "...",
 *   "data": { ... } | [...],
 *   "pagination": { ... }    // present only on list endpoints
 * }
 *
 * Error envelope:
 * {
 *   "success": false,
 *   "message": "...",
 *   "detail": "..."          // optional, stack trace in dev mode only
 * }
 */

'use strict';

/**
 * successResponse — Build a successful API response object.
 *
 * @param {string} message      — Human-readable success message
 * @param {*}      [data]       — Response payload (object or array)
 * @param {object} [pagination] — Pagination metadata (list endpoints only)
 * @returns {object}
 */
function successResponse(message, data = null, pagination = null) {
  const envelope = {
    success: true,
    message,
  };

  if (data !== null && data !== undefined) {
    envelope.data = data;
  }

  if (pagination !== null && pagination !== undefined) {
    envelope.pagination = pagination;
  }

  return envelope;
}

/**
 * errorResponse — Build a failed API response object.
 *
 * @param {string} message  — Human-readable error message
 * @param {string} [detail] — Optional additional context (stack trace in dev)
 * @returns {object}
 */
function errorResponse(message, detail = null) {
  const envelope = {
    success: false,
    message,
  };

  if (detail !== null && detail !== undefined) {
    envelope.detail = detail;
  }

  return envelope;
}

export {
successResponse, errorResponse
};
