'use strict';

import mongoose from 'mongoose';

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

function isValidObjectId(value) {
  if (value instanceof mongoose.Types.ObjectId) return true;
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value);
}

function normalizeSafeString(
  value,
  {
    field = 'value',
    lowercase = false,
    maxLength = null,
    allowEmpty = true,
  } = {},
) {
  if (value === null || value === undefined) return value;

  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string.`);
  }

  const normalized = value.trim().replace(/\s+/g, ' ');

  if (!allowEmpty && normalized.length === 0) {
    throw new Error(`${field} cannot be empty.`);
  }

  if (Number.isInteger(maxLength) && normalized.length > maxLength) {
    throw new RangeError(`${field} must not exceed ${maxLength} characters.`);
  }

  return lowercase ? normalized.toLowerCase() : normalized;
}

function isEnumValue(value, allowedValues) {
  return Array.isArray(allowedValues) && allowedValues.includes(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isBoundedArray(value, { max, min = 0, itemValidator = () => true } = {}) {
  if (!Array.isArray(value)) return false;
  if (Number.isInteger(min) && value.length < min) return false;
  if (Number.isInteger(max) && value.length > max) return false;
  return value.every((item) => itemValidator(item));
}

function escapeRegexString(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isOptionalUrl(value) {
  if (value === null || value === undefined || value === '') return true;

  if (typeof value !== 'string') return false;

  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isDateOrderValid(startDate, endDate) {
  if (!startDate || !endDate) return true;

  const start = new Date(startDate);
  const end = new Date(endDate);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;

  return end >= start;
}

export {
  escapeRegexString,
  isBoundedArray,
  isDateOrderValid,
  isEnumValue,
  isNonNegativeInteger,
  isOptionalUrl,
  isPositiveInteger,
  isValidObjectId,
  normalizeSafeString,
};
