/**
 * src/controllers/video.controller.js — Phase 2 Update
 *
 * Changes from Phase 1:
 *   - uploadVideo: passes req.user.id (owner) and req.videoId to service
 *   - deleteVideo: passes req.resource (pre-loaded by requireOwner) to service
 *   - All other handlers: unchanged
 */

'use strict';

import mongoose from 'mongoose';
import { StatusCodes } from 'http-status-codes';
import videoService from '../services/video.service.js';
import { successResponse, errorResponse } from '../utils/response.js';

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// POST /api/videos/upload
const uploadVideo = async (req, res) => {
  const { title, description } = req.body;

  if (!title || !title.trim()) {
    return res.status(StatusCodes.BAD_REQUEST).json(errorResponse('Title is required.'));
  }

  const videoFile     = req.files?.video?.[0] ?? null;
  const thumbnailFile = req.files?.thumbnail?.[0] ?? null;

  const video = await videoService.createVideo(
    {
      title: title.trim(),
      description: description?.trim() ?? '',
      userId: req.user?.id ?? null,        // Phase 2: link to authenticated user
    },
    { videoFile, thumbnailFile },
    req.videoId                            // Pre-generated ObjectId from upload middleware
  );

  return res.status(StatusCodes.CREATED).json(
    successResponse('Video upload accepted. Processing has started.', video)
  );
};

// GET /api/videos
const getAllVideos = async (req, res) => {
  const { page, limit, sort } = req.query;
  const result = await videoService.getAllVideos({ page, limit, sort });

  return res.status(StatusCodes.OK).json(
    successResponse('Videos retrieved successfully.', result.data, result.pagination)
  );
};

// GET /api/videos/:id
const getVideoById = async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    return res.status(StatusCodes.BAD_REQUEST).json(errorResponse(`"${id}" is not a valid video ID.`));
  }

  const video = await videoService.getVideoById(id);
  return res.status(StatusCodes.OK).json(successResponse('Video retrieved successfully.', video));
};

// DELETE /api/videos/:id
// req.resource is pre-loaded by the requireOwner middleware
const deleteVideo = async (req, res) => {
  await videoService.deleteVideo(req.resource);
  return res.status(StatusCodes.OK).json(successResponse('Video deleted successfully.'));
};

export {
uploadVideo, getAllVideos, getVideoById, deleteVideo
};
