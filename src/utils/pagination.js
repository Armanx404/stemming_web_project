'use strict';

import { escapeRegexString } from './validation.js';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function getScalarQueryValue(value) {
  if (Array.isArray(value)) return getScalarQueryValue(value[0]);
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object') return undefined;
  return value;
}

function parseSafeInteger(value, fallback) {
  const scalarValue = getScalarQueryValue(value);

  if (typeof scalarValue === 'number' && Number.isInteger(scalarValue)) {
    return scalarValue > 0 ? scalarValue : fallback;
  }

  if (typeof scalarValue !== 'string' || !/^\d+$/.test(scalarValue.trim())) {
    return fallback;
  }

  const parsed = Number.parseInt(scalarValue, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePagination(query = {}) {
  const page = parseSafeInteger(query.page, DEFAULT_PAGE);
  const requestedLimit = parseSafeInteger(query.limit, DEFAULT_LIMIT);
  const limit = Math.min(requestedLimit, MAX_LIMIT);

  return {
    page,
    limit,
    skip: (page - 1) * limit,
  };
}

function buildPaginationMetadata({ page, limit, totalItems }) {
  const safeTotal = Number.isInteger(totalItems) && totalItems > 0 ? totalItems : 0;
  const totalPages = Math.ceil(safeTotal / limit);

  return {
    page,
    limit,
    totalItems: safeTotal,
    totalPages,
    hasNextPage: totalPages > 0 && page < totalPages,
    hasPreviousPage: page > 1 && totalPages > 0,
  };
}

function parseSort(query = {}, allowedFields = [], defaultSort = { createdAt: -1 }) {
  const rawSort = getScalarQueryValue(query.sort ?? query.sortBy);
  const rawOrder = getScalarQueryValue(query.order ?? query.sortOrder);

  if (typeof rawSort !== 'string' || rawSort.trim().length === 0) {
    return { ...defaultSort };
  }

  const trimmed = rawSort.trim();
  const descendingByPrefix = trimmed.startsWith('-');
  const field = descendingByPrefix ? trimmed.slice(1) : trimmed;

  if (!allowedFields.includes(field)) {
    return { ...defaultSort };
  }

  const normalizedOrder = typeof rawOrder === 'string' ? rawOrder.trim().toLowerCase() : '';
  const direction = descendingByPrefix || normalizedOrder === 'desc' || normalizedOrder === '-1'
    ? -1
    : 1;

  return { [field]: direction };
}

function buildSearchRegex(value, options = 'i') {
  const scalarValue = getScalarQueryValue(value);

  if (typeof scalarValue !== 'string' || scalarValue.trim().length === 0) {
    return null;
  }

  return new RegExp(escapeRegexString(scalarValue.trim()), options);
}

export {
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
  buildPaginationMetadata,
  buildSearchRegex,
  escapeRegexString,
  parsePagination,
  parseSafeInteger,
  parseSort,
};
