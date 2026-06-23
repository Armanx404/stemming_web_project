'use strict';

import { StatusCodes } from 'http-status-codes';
import { searchVideos as searchVideosService } from '../services/search.service.js';
import { successResponse } from '../utils/response.js';

const searchVideos = async (req, res) => {
  const { q, page, limit } = req.query;
  const result = await searchVideosService({ query: q, page, limit });
  const response = successResponse(
    'Search results retrieved successfully.',
    result.data,
    result.pagination
  );

  response.query = result.query;

  return res.status(StatusCodes.OK).json(response);
};

export {
  searchVideos
};
