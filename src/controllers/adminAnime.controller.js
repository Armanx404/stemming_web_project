'use strict';

import { StatusCodes } from 'http-status-codes';
import {
  createAnime as createAnimeService,
  getAnimeById as getAnimeByIdService,
  listAnime as listAnimeService,
  publishAnime as publishAnimeService,
  softDeleteAnime as softDeleteAnimeService,
  unpublishAnime as unpublishAnimeService,
  updateAnime as updateAnimeService,
} from '../services/adminAnime.service.js';
import { successResponse } from '../utils/response.js';

const createAnime = async (req, res) => {
  const anime = await createAnimeService(req.body, req.user);

  return res
    .status(StatusCodes.CREATED)
    .json(successResponse('Anime created successfully.', anime));
};

const listAnime = async (req, res) => {
  const result = await listAnimeService(req.query);

  return res
    .status(StatusCodes.OK)
    .json(successResponse('Anime retrieved successfully.', result.data, result.pagination));
};

const getAnimeById = async (req, res) => {
  const anime = await getAnimeByIdService(req.params.animeId);

  return res
    .status(StatusCodes.OK)
    .json(successResponse('Anime retrieved successfully.', anime));
};

const updateAnime = async (req, res) => {
  const anime = await updateAnimeService(req.params.animeId, req.body, req.user);

  return res
    .status(StatusCodes.OK)
    .json(successResponse('Anime updated successfully.', anime));
};

const publishAnime = async (req, res) => {
  const anime = await publishAnimeService(req.params.animeId, req.user);

  return res
    .status(StatusCodes.OK)
    .json(successResponse('Anime published successfully.', anime));
};

const unpublishAnime = async (req, res) => {
  const anime = await unpublishAnimeService(req.params.animeId, req.user);

  return res
    .status(StatusCodes.OK)
    .json(successResponse('Anime unpublished successfully.', anime));
};

const deleteAnime = async (req, res) => {
  const anime = await softDeleteAnimeService(req.params.animeId, req.user);

  return res
    .status(StatusCodes.OK)
    .json(successResponse('Anime deleted successfully.', anime));
};

export {
  createAnime,
  deleteAnime,
  getAnimeById,
  listAnime,
  publishAnime,
  unpublishAnime,
  updateAnime,
};
