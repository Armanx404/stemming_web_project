'use strict';

import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { storageClient } from './storage.config.js';
import logger from '../utils/logger.js';

const PUBLIC_DOMAIN = process.env.R2_PUBLIC_DOMAIN || '';
const TTL_SECONDS = parseInt(process.env.R2_SIGNED_URL_TTL_SECONDS, 10) || 14400;

function buildPublicUrl(objectKey) {
  if (!PUBLIC_DOMAIN || !objectKey) return null;
  return `${PUBLIC_DOMAIN.replace(/\/$/, '')}/${objectKey}`;
}

async function buildSignedUrl(objectKey, ttl = TTL_SECONDS) {
  if (!objectKey) return null;

  if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    logger.warn('R2 credentials are not configured; returning public URL fallback.');
    return buildPublicUrl(objectKey);
  }

  const command = new GetObjectCommand({
    Bucket: process.env.STORAGE_BUCKET_NAME,
    Key: objectKey,
  });

  try {
    return await getSignedUrl(storageClient, command, { expiresIn: ttl });
  } catch (err) {
    logger.error(`Failed to generate R2 presigned URL for "${objectKey}": ${err.message}`);
    return buildPublicUrl(objectKey);
  }
}

async function buildHlsSignedUrl(videoId) {
  return buildSignedUrl(`videos/hls/${videoId}/master.m3u8`);
}

function buildThumbnailUrl(videoId) {
  return buildPublicUrl(`thumbnails/${videoId}.jpg`);
}

export {
  buildHlsSignedUrl,
  buildPublicUrl,
  buildSignedUrl,
  buildThumbnailUrl,
};
