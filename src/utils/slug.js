'use strict';

function normalizeSlug(value, { maxLength = 140 } = {}) {
  if (typeof value !== 'string') {
    throw new TypeError('Slug must be a string.');
  }

  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!normalized) {
    throw new Error('Slug cannot be empty.');
  }

  if (normalized.length > maxLength) {
    throw new RangeError(`Slug must not exceed ${maxLength} characters.`);
  }

  return normalized;
}

function createSlugFromTitle(title, options = {}) {
  return normalizeSlug(title, options);
}

async function createUniqueSlug({
  model,
  value,
  field = 'slug',
  filter = {},
  maxAttempts = 100,
} = {}) {
  if (!model || typeof model.exists !== 'function') {
    throw new TypeError('A Mongoose model with exists() is required.');
  }

  const baseSlug = normalizeSlug(value);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = attempt === 1 ? baseSlug : `${baseSlug}-${attempt}`;
    const exists = await model.exists({ ...filter, [field]: candidate });

    if (!exists) return candidate;
  }

  throw new Error(`Unable to create a unique slug after ${maxAttempts} attempts.`);
}

export {
  createSlugFromTitle,
  createUniqueSlug,
  normalizeSlug,
};
