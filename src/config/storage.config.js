'use strict';

import { S3Client } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import multerS3 from 'multer-s3';
import path from 'path';

const R2_ENDPOINT = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const storageClient = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

function createStorageEngine(getVideoId) {
  return multerS3({
    s3: storageClient,
    bucket: process.env.STORAGE_BUCKET_NAME,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    cacheControl: 'max-age=31536000',
    key: (req, file, cb) => {
      const videoId = getVideoId(req);
      const ext = path.extname(file.originalname).toLowerCase();
      const uniqueSuffix = crypto.randomBytes(8).toString('hex');

      if (file.fieldname === 'video') {
        return cb(null, `videos/raw/${videoId}/${uniqueSuffix}${ext}`);
      }

      if (file.fieldname === 'thumbnail') {
        return cb(null, `thumbnails/${videoId}-${uniqueSuffix}${ext}`);
      }

      return cb(new Error(`Unexpected multipart field: ${file.fieldname}`));
    },
  });
}

function getHlsKeyPrefix(videoId) {
  return `videos/hls/${videoId}/`;
}

function getThumbnailKey(videoId) {
  return `thumbnails/${videoId}.jpg`;
}

export {
  createStorageEngine,
  getHlsKeyPrefix,
  getThumbnailKey,
  storageClient,
};
