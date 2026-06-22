/**
 * src/middleware/asyncHandler.middleware.js
 *
 * Wraps an async route handler so any rejected promise is forwarded to
 * Express's next(err) — eliminating the need for try-catch boilerplate
 * in every controller method.
 *
 * Usage:
 *   router.get('/path', asyncHandler(myAsyncController));
 *
 * @param {Function} fn — An async Express route handler
 * @returns {Function} A standard Express middleware function
 */

'use strict';

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

export {
asyncHandler
};
