import PlexTvAPI from '@server/api/plextv';
import type { SortOptions } from '@server/api/themoviedb';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbKeyword,
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import type { UserContentRatingLimits } from '@server/constants/contentRatings';
import {
  isUnrated,
  MOVIE_RATING_ORDER,
  shouldFilterMovie,
  shouldFilterTv,
  UNRATED_VALUES,
} from '@server/constants/contentRatings';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import type {
  GenreSliderItem,
  WatchlistResponse,
} from '@server/interfaces/api/discoverInterfaces';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapProductionCompany } from '@server/models/Movie';
import {
  mapCollectionResult,
  mapMovieResult,
  mapPersonResult,
  mapTvResult,
} from '@server/models/Search';
import { mapNetwork } from '@server/models/Tv';
import { isCollection, isMovie, isPerson } from '@server/utils/typeHelpers';
import { Router } from 'express';
import { sortBy } from 'lodash';
import { z } from 'zod';

export const createTmdbWithRegionLanguage = (user?: User): TheMovieDb => {
  const settings = getSettings();

  const discoverRegion =
    user?.settings?.streamingRegion === 'all'
      ? ''
      : user?.settings?.streamingRegion
      ? user?.settings?.streamingRegion
      : settings.main.discoverRegion;

  const originalLanguage =
    user?.settings?.originalLanguage === 'all'
      ? ''
      : user?.settings?.originalLanguage
      ? user?.settings?.originalLanguage
      : settings.main.originalLanguage;

  return new TheMovieDb({
    discoverRegion,
    originalLanguage,
  });
};

// ----- Parental Controls helpers -----

/**
 * Load the requesting user's content-rating limits from their settings.
 * Returns null if no limits are configured.
 */
export function getUserContentRatingLimits(
  user?: User
): UserContentRatingLimits | null {
  const settings = user?.settings;
  if (!settings) return null;

  const maxMovie = settings.maxMovieRating ?? null;
  const maxTv = settings.maxTvRating ?? null;
  const blockUnrated = settings.blockUnrated ?? false;
  const blockAdult = settings.blockAdult ?? false;

  if (!maxMovie && !maxTv && !blockUnrated && !blockAdult) return null;

  return {
    maxMovieRating: maxMovie,
    maxTvRating: maxTv,
    blockUnrated,
    blockAdult,
  };
}

/**
 * Apply `certification.lte` pre-filtering to TMDB discover-movie params.
 * This lets TMDB do the heavy lifting server-side.
 */
function applyMovieCertificationLimits(
  params: Record<string, unknown>,
  limits: UserContentRatingLimits
): Record<string, unknown> {
  if (limits.maxMovieRating) {
    params.certificationLte = limits.maxMovieRating;
    params.certificationCountry = params.certificationCountry ?? 'US';
  }
  return params;
}

/**
 * Apply `certification.lte` pre-filtering to TMDB discover-tv params.
 */
function applyTvCertificationLimits(
  params: Record<string, unknown>,
  limits: UserContentRatingLimits
): Record<string, unknown> {
  if (limits.maxTvRating) {
    params.certificationLte = limits.maxTvRating;
    params.certificationCountry = params.certificationCountry ?? 'US';
  }
  return params;
}

/**
 * Enhanced movie certification lookup.
 * Collects ALL US release-date certs, excludes NR/unrated values,
 * and returns the most restrictive rated certification.
 * Falls back to international certs if no US cert found.
 */
export function getMovieCertFromDetails(
  releaseResults: {
    iso_3166_1: string;
    release_dates: { certification: string }[];
  }[]
): string {
  // First try US certs
  const usRelease = releaseResults?.find((r) => r.iso_3166_1 === 'US');
  if (usRelease) {
    const allCerts = usRelease.release_dates
      .map((rd) => rd.certification)
      .filter((c) => c && !UNRATED_VALUES.includes(c));

    if (allCerts.length > 0) {
      // Return the most restrictive (highest index) US cert
      let mostRestrictiveIdx = -1;
      let mostRestrictive = allCerts[0];
      for (const cert of allCerts) {
        const idx = MOVIE_RATING_ORDER.indexOf(cert);
        if (idx > mostRestrictiveIdx) {
          mostRestrictiveIdx = idx;
          mostRestrictive = cert;
        }
      }
      return mostRestrictive;
    }
  }

  // Fallback: check international release certs
  for (const release of releaseResults ?? []) {
    for (const rd of release.release_dates) {
      if (rd.certification && !UNRATED_VALUES.includes(rd.certification)) {
        return rd.certification;
      }
    }
  }

  return '';
}

/**
 * Post-filter a batch of movie results. Used when blockUnrated or blockAdult
 * is enabled and we need per-title detail lookups.
 */
export async function filterMovieBatch(
  tmdb: TheMovieDb,
  results: TmdbMovieResult[],
  limits: UserContentRatingLimits
): Promise<TmdbMovieResult[]> {
  // First pass: free in-memory adult filter (no API calls)
  let candidates = results;
  if (limits.blockAdult) {
    candidates = candidates.filter((movie) => {
      if (movie.adult) {
        logger.debug(`Parental filter: blocked adult movie id=${movie.id}`, {
          label: 'Discover',
        });
        return false;
      }
      return true;
    });
  }

  // Second pass: parallel cert lookups if needed
  if (!limits.blockUnrated && !limits.maxMovieRating) return candidates;

  const settled = await Promise.allSettled(
    candidates.map(async (movie) => {
      const details = await tmdb.getMovie({ movieId: movie.id });
      const cert = getMovieCertFromDetails(
        details.release_dates?.results ?? []
      );
      return { movie, cert };
    })
  );

  const filtered: TmdbMovieResult[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      // Fail-open: keep item if detail lookup fails
      filtered.push(candidates[settled.indexOf(outcome)]);
      continue;
    }
    const { movie, cert } = outcome.value;

    if (limits.blockUnrated && isUnrated(cert)) {
      logger.debug(`Parental filter: blocked unrated movie id=${movie.id}`, {
        label: 'Discover',
      });
      continue;
    }

    if (
      limits.maxMovieRating &&
      cert &&
      shouldFilterMovie(cert, limits.maxMovieRating)
    ) {
      logger.debug(
        `Parental filter: blocked movie id=${movie.id} cert=${cert} max=${limits.maxMovieRating}`,
        { label: 'Discover' }
      );
      continue;
    }

    filtered.push(movie);
  }

  return filtered;
}

/**
 * Post-filter a batch of TV results.
 */
export async function filterTvBatch(
  tmdb: TheMovieDb,
  results: TmdbTvResult[],
  limits: UserContentRatingLimits
): Promise<TmdbTvResult[]> {
  if (!limits.blockUnrated && !limits.maxTvRating) return results;

  const settled = await Promise.allSettled(
    results.map(async (show) => {
      const details = await tmdb.getTvShow({ tvId: show.id });
      const usRating = details.content_ratings?.results?.find(
        (r) => r.iso_3166_1 === 'US'
      );
      return { show, cert: usRating?.rating ?? '' };
    })
  );

  const filtered: TmdbTvResult[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      // Fail-open: keep item if detail lookup fails
      filtered.push(results[settled.indexOf(outcome)]);
      continue;
    }
    const { show, cert } = outcome.value;

    if (limits.blockUnrated && isUnrated(cert)) {
      logger.debug(`Parental filter: blocked unrated TV id=${show.id}`, {
        label: 'Discover',
      });
      continue;
    }

    if (
      limits.maxTvRating &&
      cert &&
      shouldFilterTv(cert, limits.maxTvRating)
    ) {
      logger.debug(
        `Parental filter: blocked TV id=${show.id} cert=${cert} max=${limits.maxTvRating}`,
        { label: 'Discover' }
      );
      continue;
    }

    filtered.push(show);
  }

  return filtered;
}

/**
 * Wrapper for movie discover routes. Applies TMDB pre-filtering via
 * certification.lte, then post-filters with backfill if blockUnrated
 * or blockAdult is enabled.
 */
async function postFilterDiscoverMovies(
  tmdb: TheMovieDb,
  results: TmdbMovieResult[],
  limits: UserContentRatingLimits | null,
  totalResults: number,
  totalPages: number
): Promise<{
  results: TmdbMovieResult[];
  totalResults: number;
  totalPages: number;
}> {
  if (!limits) return { results, totalResults, totalPages };

  // Only post-filter when blockUnrated, blockAdult, or detailed cert check needed
  const needsPostFilter = limits.blockUnrated || limits.blockAdult;

  if (!needsPostFilter) return { results, totalResults, totalPages };

  const filtered = await filterMovieBatch(tmdb, results, limits);

  return {
    results: filtered,
    totalResults: Math.max(
      0,
      totalResults - (results.length - filtered.length)
    ),
    totalPages,
  };
}

/**
 * Wrapper for TV discover routes.
 */
async function postFilterDiscoverTv(
  tmdb: TheMovieDb,
  results: TmdbTvResult[],
  limits: UserContentRatingLimits | null,
  totalResults: number,
  totalPages: number
): Promise<{
  results: TmdbTvResult[];
  totalResults: number;
  totalPages: number;
}> {
  if (!limits) return { results, totalResults, totalPages };

  const needsPostFilter = limits.blockUnrated;
  if (!needsPostFilter) return { results, totalResults, totalPages };

  const filtered = await filterTvBatch(tmdb, results, limits);

  return {
    results: filtered,
    totalResults: Math.max(
      0,
      totalResults - (results.length - filtered.length)
    ),
    totalPages,
  };
}

const discoverRoutes = Router();

const QueryFilterOptions = z.object({
  page: z.coerce.string().optional(),
  sortBy: z.coerce.string().optional(),
  primaryReleaseDateGte: z.coerce.string().optional(),
  primaryReleaseDateLte: z.coerce.string().optional(),
  firstAirDateGte: z.coerce.string().optional(),
  firstAirDateLte: z.coerce.string().optional(),
  studio: z.coerce.string().optional(),
  genre: z.coerce.string().optional(),
  keywords: z.coerce.string().optional(),
  excludeKeywords: z.coerce.string().optional(),
  language: z.coerce.string().optional(),
  withRuntimeGte: z.coerce.string().optional(),
  withRuntimeLte: z.coerce.string().optional(),
  voteAverageGte: z.coerce.string().optional(),
  voteAverageLte: z.coerce.string().optional(),
  voteCountGte: z.coerce.string().optional(),
  voteCountLte: z.coerce.string().optional(),
  network: z.coerce.string().optional(),
  watchProviders: z.coerce.string().optional(),
  watchRegion: z.coerce.string().optional(),
  status: z.coerce.string().optional(),
  certification: z.coerce.string().optional(),
  certificationGte: z.coerce.string().optional(),
  certificationLte: z.coerce.string().optional(),
  certificationCountry: z.coerce.string().optional(),
  certificationMode: z.enum(['exact', 'range']).optional(),
});

export type FilterOptions = z.infer<typeof QueryFilterOptions>;
const ApiQuerySchema = QueryFilterOptions.omit({
  certificationMode: true,
});

discoverRoutes.get('/movies', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage(req.user);
  const limits = getUserContentRatingLimits(req.user);

  try {
    const query = ApiQuerySchema.parse(req.query);
    const keywords = query.keywords;
    const excludeKeywords = query.excludeKeywords;

    let discoverParams: Record<string, unknown> = {
      page: Number(query.page),
      sortBy: query.sortBy as SortOptions,
      language: req.locale ?? query.language,
      originalLanguage: query.language,
      genre: query.genre,
      studio: query.studio,
      primaryReleaseDateLte: query.primaryReleaseDateLte
        ? new Date(query.primaryReleaseDateLte).toISOString().split('T')[0]
        : undefined,
      primaryReleaseDateGte: query.primaryReleaseDateGte
        ? new Date(query.primaryReleaseDateGte).toISOString().split('T')[0]
        : undefined,
      keywords,
      excludeKeywords,
      withRuntimeGte: query.withRuntimeGte,
      withRuntimeLte: query.withRuntimeLte,
      voteAverageGte: query.voteAverageGte,
      voteAverageLte: query.voteAverageLte,
      voteCountGte: query.voteCountGte,
      voteCountLte: query.voteCountLte,
      watchProviders: query.watchProviders,
      watchRegion: query.watchRegion,
      certification: query.certification,
      certificationGte: query.certificationGte,
      certificationLte: query.certificationLte,
      certificationCountry: query.certificationCountry,
    };

    if (limits) {
      discoverParams = applyMovieCertificationLimits(discoverParams, limits);
    }

    const data = await tmdb.getDiscoverMovies(discoverParams);

    const postFiltered = await postFilterDiscoverMovies(
      tmdb,
      data.results,
      limits,
      data.total_results,
      data.total_pages
    );

    const media = await Media.getRelatedMedia(
      req.user,
      postFiltered.results.map((result) => result.id)
    );

    let keywordData: TmdbKeyword[] = [];
    if (keywords) {
      const splitKeywords = keywords.split(',');

      const keywordResults = await Promise.all(
        splitKeywords.map(async (keywordId) => {
          return await tmdb.getKeywordDetails({ keywordId: Number(keywordId) });
        })
      );

      keywordData = keywordResults.filter(
        (keyword): keyword is TmdbKeyword => keyword !== null
      );
    }

    return res.status(200).json({
      page: data.page,
      totalPages: postFiltered.totalPages,
      totalResults: postFiltered.totalResults,
      keywords: keywordData,
      results: postFiltered.results.map((result) =>
        mapMovieResult(
          result,
          media.find(
            (req) =>
              req.tmdbId === result.id && req.mediaType === MediaType.MOVIE
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving popular movies', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve popular movies.',
    });
  }
});

discoverRoutes.get<{ language: string }>(
  '/movies/language/:language',
  async (req, res, next) => {
    const tmdb = createTmdbWithRegionLanguage(req.user);
    const limits = getUserContentRatingLimits(req.user);

    try {
      const languages = await tmdb.getLanguages();

      const language = languages.find(
        (lang) => lang.iso_639_1 === req.params.language
      );

      if (!language) {
        return next({ status: 404, message: 'Language not found.' });
      }

      let discoverParams: Record<string, unknown> = {
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
        originalLanguage: req.params.language,
      };

      if (limits) {
        discoverParams = applyMovieCertificationLimits(discoverParams, limits);
      }

      const data = await tmdb.getDiscoverMovies(discoverParams);

      const postFiltered = await postFilterDiscoverMovies(
        tmdb,
        data.results,
        limits,
        data.total_results,
        data.total_pages
      );

      const media = await Media.getRelatedMedia(
        req.user,
        postFiltered.results.map((result) => result.id)
      );

      return res.status(200).json({
        page: data.page,
        totalPages: postFiltered.totalPages,
        totalResults: postFiltered.totalResults,
        language,
        results: postFiltered.results.map((result) =>
          mapMovieResult(
            result,
            media.find(
              (req) =>
                req.tmdbId === result.id && req.mediaType === MediaType.MOVIE
            )
          )
        ),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving movies by language', {
        label: 'API',
        errorMessage: e.message,
        language: req.params.language,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movies by language.',
      });
    }
  }
);

discoverRoutes.get<{ genreId: string }>(
  '/movies/genre/:genreId',
  async (req, res, next) => {
    const tmdb = createTmdbWithRegionLanguage(req.user);
    const limits = getUserContentRatingLimits(req.user);

    try {
      const genres = await tmdb.getMovieGenres({
        language: (req.query.language as string) ?? req.locale,
      });

      const genre = genres.find(
        (genre) => genre.id === Number(req.params.genreId)
      );

      if (!genre) {
        return next({ status: 404, message: 'Genre not found.' });
      }

      let discoverParams: Record<string, unknown> = {
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
        genre: req.params.genreId as string,
      };

      if (limits) {
        discoverParams = applyMovieCertificationLimits(discoverParams, limits);
      }

      const data = await tmdb.getDiscoverMovies(discoverParams);

      const postFiltered = await postFilterDiscoverMovies(
        tmdb,
        data.results,
        limits,
        data.total_results,
        data.total_pages
      );

      const media = await Media.getRelatedMedia(
        req.user,
        postFiltered.results.map((result) => result.id)
      );

      return res.status(200).json({
        page: data.page,
        totalPages: postFiltered.totalPages,
        totalResults: postFiltered.totalResults,
        genre,
        results: postFiltered.results.map((result) =>
          mapMovieResult(
            result,
            media.find(
              (req) =>
                req.tmdbId === result.id && req.mediaType === MediaType.MOVIE
            )
          )
        ),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving movies by genre', {
        label: 'API',
        errorMessage: e.message,
        genreId: req.params.genreId,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movies by genre.',
      });
    }
  }
);

discoverRoutes.get<{ studioId: string }>(
  '/movies/studio/:studioId',
  async (req, res, next) => {
    const tmdb = new TheMovieDb();
    const limits = getUserContentRatingLimits(req.user);

    try {
      const studio = await tmdb.getStudio(Number(req.params.studioId));

      let discoverParams: Record<string, unknown> = {
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
        studio: req.params.studioId as string,
      };

      if (limits) {
        discoverParams = applyMovieCertificationLimits(discoverParams, limits);
      }

      const data = await tmdb.getDiscoverMovies(discoverParams);

      const postFiltered = await postFilterDiscoverMovies(
        tmdb,
        data.results,
        limits,
        data.total_results,
        data.total_pages
      );

      const media = await Media.getRelatedMedia(
        req.user,
        postFiltered.results.map((result) => result.id)
      );

      return res.status(200).json({
        page: data.page,
        totalPages: postFiltered.totalPages,
        totalResults: postFiltered.totalResults,
        studio: mapProductionCompany(studio),
        results: postFiltered.results.map((result) =>
          mapMovieResult(
            result,
            media.find(
              (med) =>
                med.tmdbId === result.id && med.mediaType === MediaType.MOVIE
            )
          )
        ),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving movies by studio', {
        label: 'API',
        errorMessage: e.message,
        studioId: req.params.studioId,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movies by studio.',
      });
    }
  }
);

discoverRoutes.get('/movies/upcoming', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage(req.user);
  const limits = getUserContentRatingLimits(req.user);

  const now = new Date();
  const offset = now.getTimezoneOffset();
  const date = new Date(now.getTime() - offset * 60 * 1000)
    .toISOString()
    .split('T')[0];

  try {
    let discoverParams: Record<string, unknown> = {
      page: Number(req.query.page),
      language: (req.query.language as string) ?? req.locale,
      primaryReleaseDateGte: date,
    };

    if (limits) {
      discoverParams = applyMovieCertificationLimits(discoverParams, limits);
    }

    const data = await tmdb.getDiscoverMovies(discoverParams);

    const postFiltered = await postFilterDiscoverMovies(
      tmdb,
      data.results,
      limits,
      data.total_results,
      data.total_pages
    );

    const media = await Media.getRelatedMedia(
      req.user,
      postFiltered.results.map((result) => result.id)
    );

    return res.status(200).json({
      page: data.page,
      totalPages: postFiltered.totalPages,
      totalResults: postFiltered.totalResults,
      results: postFiltered.results.map((result) =>
        mapMovieResult(
          result,
          media.find(
            (med) =>
              med.tmdbId === result.id && med.mediaType === MediaType.MOVIE
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving upcoming movies', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve upcoming movies.',
    });
  }
});

discoverRoutes.get('/tv', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage(req.user);
  const limits = getUserContentRatingLimits(req.user);

  try {
    const query = ApiQuerySchema.parse(req.query);
    const keywords = query.keywords;
    const excludeKeywords = query.excludeKeywords;

    let discoverParams: Record<string, unknown> = {
      page: Number(query.page),
      sortBy: query.sortBy as SortOptions,
      language: req.locale ?? query.language,
      genre: query.genre,
      network: query.network ? Number(query.network) : undefined,
      firstAirDateLte: query.firstAirDateLte
        ? new Date(query.firstAirDateLte).toISOString().split('T')[0]
        : undefined,
      firstAirDateGte: query.firstAirDateGte
        ? new Date(query.firstAirDateGte).toISOString().split('T')[0]
        : undefined,
      originalLanguage: query.language,
      keywords,
      excludeKeywords,
      withRuntimeGte: query.withRuntimeGte,
      withRuntimeLte: query.withRuntimeLte,
      voteAverageGte: query.voteAverageGte,
      voteAverageLte: query.voteAverageLte,
      voteCountGte: query.voteCountGte,
      voteCountLte: query.voteCountLte,
      watchProviders: query.watchProviders,
      watchRegion: query.watchRegion,
      withStatus: query.status,
      certification: query.certification,
      certificationGte: query.certificationGte,
      certificationLte: query.certificationLte,
      certificationCountry: query.certificationCountry,
    };

    if (limits) {
      discoverParams = applyTvCertificationLimits(discoverParams, limits);
    }

    const data = await tmdb.getDiscoverTv(discoverParams);

    const postFiltered = await postFilterDiscoverTv(
      tmdb,
      data.results,
      limits,
      data.total_results,
      data.total_pages
    );

    const media = await Media.getRelatedMedia(
      req.user,
      postFiltered.results.map((result) => result.id)
    );

    let keywordData: TmdbKeyword[] = [];
    if (keywords) {
      const splitKeywords = keywords.split(',');

      const keywordResults = await Promise.all(
        splitKeywords.map(async (keywordId) => {
          return await tmdb.getKeywordDetails({ keywordId: Number(keywordId) });
        })
      );

      keywordData = keywordResults.filter(
        (keyword): keyword is TmdbKeyword => keyword !== null
      );
    }

    return res.status(200).json({
      page: data.page,
      totalPages: postFiltered.totalPages,
      totalResults: postFiltered.totalResults,
      keywords: keywordData,
      results: postFiltered.results.map((result) =>
        mapTvResult(
          result,
          media.find(
            (med) => med.tmdbId === result.id && med.mediaType === MediaType.TV
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving popular series', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve popular series.',
    });
  }
});

discoverRoutes.get<{ language: string }>(
  '/tv/language/:language',
  async (req, res, next) => {
    const tmdb = createTmdbWithRegionLanguage(req.user);
    const limits = getUserContentRatingLimits(req.user);

    try {
      const languages = await tmdb.getLanguages();

      const language = languages.find(
        (lang) => lang.iso_639_1 === req.params.language
      );

      if (!language) {
        return next({ status: 404, message: 'Language not found.' });
      }

      let discoverParams: Record<string, unknown> = {
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
        originalLanguage: req.params.language,
      };

      if (limits) {
        discoverParams = applyTvCertificationLimits(discoverParams, limits);
      }

      const data = await tmdb.getDiscoverTv(discoverParams);

      const postFiltered = await postFilterDiscoverTv(
        tmdb,
        data.results,
        limits,
        data.total_results,
        data.total_pages
      );

      const media = await Media.getRelatedMedia(
        req.user,
        postFiltered.results.map((result) => result.id)
      );

      return res.status(200).json({
        page: data.page,
        totalPages: postFiltered.totalPages,
        totalResults: postFiltered.totalResults,
        language,
        results: postFiltered.results.map((result) =>
          mapTvResult(
            result,
            media.find(
              (med) =>
                med.tmdbId === result.id && med.mediaType === MediaType.TV
            )
          )
        ),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving series by language', {
        label: 'API',
        errorMessage: e.message,
        language: req.params.language,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve series by language.',
      });
    }
  }
);

discoverRoutes.get<{ genreId: string }>(
  '/tv/genre/:genreId',
  async (req, res, next) => {
    const tmdb = createTmdbWithRegionLanguage(req.user);
    const limits = getUserContentRatingLimits(req.user);

    try {
      const genres = await tmdb.getTvGenres({
        language: (req.query.language as string) ?? req.locale,
      });

      const genre = genres.find(
        (genre) => genre.id === Number(req.params.genreId)
      );

      if (!genre) {
        return next({ status: 404, message: 'Genre not found.' });
      }

      let discoverParams: Record<string, unknown> = {
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
        genre: req.params.genreId,
      };

      if (limits) {
        discoverParams = applyTvCertificationLimits(discoverParams, limits);
      }

      const data = await tmdb.getDiscoverTv(discoverParams);

      const postFiltered = await postFilterDiscoverTv(
        tmdb,
        data.results,
        limits,
        data.total_results,
        data.total_pages
      );

      const media = await Media.getRelatedMedia(
        req.user,
        postFiltered.results.map((result) => result.id)
      );

      return res.status(200).json({
        page: data.page,
        totalPages: postFiltered.totalPages,
        totalResults: postFiltered.totalResults,
        genre,
        results: postFiltered.results.map((result) =>
          mapTvResult(
            result,
            media.find(
              (med) =>
                med.tmdbId === result.id && med.mediaType === MediaType.TV
            )
          )
        ),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving series by genre', {
        label: 'API',
        errorMessage: e.message,
        genreId: req.params.genreId,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve series by genre.',
      });
    }
  }
);

discoverRoutes.get<{ networkId: string }>(
  '/tv/network/:networkId',
  async (req, res, next) => {
    const tmdb = new TheMovieDb();
    const limits = getUserContentRatingLimits(req.user);

    try {
      const network = await tmdb.getNetwork(Number(req.params.networkId));

      let discoverParams: Record<string, unknown> = {
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
        network: Number(req.params.networkId),
      };

      if (limits) {
        discoverParams = applyTvCertificationLimits(discoverParams, limits);
      }

      const data = await tmdb.getDiscoverTv(discoverParams);

      const postFiltered = await postFilterDiscoverTv(
        tmdb,
        data.results,
        limits,
        data.total_results,
        data.total_pages
      );

      const media = await Media.getRelatedMedia(
        req.user,
        postFiltered.results.map((result) => result.id)
      );

      return res.status(200).json({
        page: data.page,
        totalPages: postFiltered.totalPages,
        totalResults: postFiltered.totalResults,
        network: mapNetwork(network),
        results: postFiltered.results.map((result) =>
          mapTvResult(
            result,
            media.find(
              (med) =>
                med.tmdbId === result.id && med.mediaType === MediaType.TV
            )
          )
        ),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving series by network', {
        label: 'API',
        errorMessage: e.message,
        networkId: req.params.networkId,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve series by network.',
      });
    }
  }
);

discoverRoutes.get('/tv/upcoming', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage(req.user);
  const limits = getUserContentRatingLimits(req.user);

  const now = new Date();
  const offset = now.getTimezoneOffset();
  const date = new Date(now.getTime() - offset * 60 * 1000)
    .toISOString()
    .split('T')[0];

  try {
    let discoverParams: Record<string, unknown> = {
      page: Number(req.query.page),
      language: (req.query.language as string) ?? req.locale,
      firstAirDateGte: date,
    };

    if (limits) {
      discoverParams = applyTvCertificationLimits(discoverParams, limits);
    }

    const data = await tmdb.getDiscoverTv(discoverParams);

    const postFiltered = await postFilterDiscoverTv(
      tmdb,
      data.results,
      limits,
      data.total_results,
      data.total_pages
    );

    const media = await Media.getRelatedMedia(
      req.user,
      postFiltered.results.map((result) => result.id)
    );

    return res.status(200).json({
      page: data.page,
      totalPages: postFiltered.totalPages,
      totalResults: postFiltered.totalResults,
      results: postFiltered.results.map((result) =>
        mapTvResult(
          result,
          media.find(
            (med) => med.tmdbId === result.id && med.mediaType === MediaType.TV
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving upcoming series', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve upcoming series.',
    });
  }
});

discoverRoutes.get('/trending', async (req, res, next) => {
  const tmdb = createTmdbWithRegionLanguage(req.user);
  const limits = getUserContentRatingLimits(req.user);

  try {
    const data = await tmdb.getAllTrending({
      page: Number(req.query.page),
      language: (req.query.language as string) ?? req.locale,
    });

    // Trending doesn't support certification.lte, so we filter in-memory.
    let filteredResults = data.results;

    if (limits) {
      // Filter out adult movies
      if (limits.blockAdult) {
        filteredResults = filteredResults.filter((result) => {
          if (isMovie(result) && result.adult) {
            logger.debug(
              `Parental filter: blocked adult trending movie id=${result.id}`,
              { label: 'Discover' }
            );
            return false;
          }
          return true;
        });
      }

      // Post-filter movies and TV by cert (requires detail lookups)
      if (limits.maxMovieRating || limits.maxTvRating || limits.blockUnrated) {
        const kept = [];
        for (const result of filteredResults) {
          if (isMovie(result)) {
            const batch = await filterMovieBatch(tmdb, [result], limits);
            if (batch.length > 0) kept.push(result);
          } else if (
            !isMovie(result) &&
            !isPerson(result) &&
            !isCollection(result)
          ) {
            // It's a TV result
            const batch = await filterTvBatch(
              tmdb,
              [result as TmdbTvResult],
              limits
            );
            if (batch.length > 0) kept.push(result);
          } else {
            // Person or Collection — keep as-is
            kept.push(result);
          }
        }
        filteredResults = kept;
      }
    }

    const media = await Media.getRelatedMedia(
      req.user,
      filteredResults.map((result) => result.id)
    );

    return res.status(200).json({
      page: data.page,
      totalPages: data.total_pages,
      totalResults: data.total_results,
      results: filteredResults.map((result) =>
        isMovie(result)
          ? mapMovieResult(
              result,
              media.find(
                (med) =>
                  med.tmdbId === result.id && med.mediaType === MediaType.MOVIE
              )
            )
          : isPerson(result)
          ? mapPersonResult(result)
          : isCollection(result)
          ? mapCollectionResult(result)
          : mapTvResult(
              result,
              media.find(
                (med) =>
                  med.tmdbId === result.id && med.mediaType === MediaType.TV
              )
            )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving trending items', {
      label: 'API',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve trending items.',
    });
  }
});

discoverRoutes.get<{ keywordId: string }>(
  '/keyword/:keywordId/movies',
  async (req, res, next) => {
    const tmdb = new TheMovieDb();
    const limits = getUserContentRatingLimits(req.user);

    try {
      const data = await tmdb.getMoviesByKeyword({
        keywordId: Number(req.params.keywordId),
        page: Number(req.query.page),
        language: (req.query.language as string) ?? req.locale,
      });

      const postFiltered = await postFilterDiscoverMovies(
        tmdb,
        data.results,
        limits,
        data.total_results,
        data.total_pages
      );

      const media = await Media.getRelatedMedia(
        req.user,
        postFiltered.results.map((result) => result.id)
      );

      return res.status(200).json({
        page: data.page,
        totalPages: postFiltered.totalPages,
        totalResults: postFiltered.totalResults,
        results: postFiltered.results.map((result) =>
          mapMovieResult(
            result,
            media.find(
              (med) =>
                med.tmdbId === result.id && med.mediaType === MediaType.MOVIE
            )
          )
        ),
      });
    } catch (e) {
      logger.debug('Something went wrong retrieving movies by keyword', {
        label: 'API',
        errorMessage: e.message,
        keywordId: req.params.keywordId,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movies by keyword.',
      });
    }
  }
);

discoverRoutes.get<{ language: string }, GenreSliderItem[]>(
  '/genreslider/movie',
  async (req, res, next) => {
    const tmdb = new TheMovieDb();

    try {
      const mappedGenres: GenreSliderItem[] = [];

      const genres = await tmdb.getMovieGenres({
        language: (req.query.language as string) ?? req.locale,
      });

      await Promise.all(
        genres.map(async (genre) => {
          const genreData = await tmdb.getDiscoverMovies({
            genre: genre.id.toString(),
          });

          mappedGenres.push({
            id: genre.id,
            name: genre.name,
            backdrops: genreData.results
              .filter((title) => !!title.backdrop_path)
              .map((title) => title.backdrop_path) as string[],
          });
        })
      );

      const sortedData = sortBy(mappedGenres, 'name');

      return res.status(200).json(sortedData);
    } catch (e) {
      logger.debug('Something went wrong retrieving the movie genre slider', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movie genre slider.',
      });
    }
  }
);

discoverRoutes.get<{ language: string }, GenreSliderItem[]>(
  '/genreslider/tv',
  async (req, res, next) => {
    const tmdb = new TheMovieDb();

    try {
      const mappedGenres: GenreSliderItem[] = [];

      const genres = await tmdb.getTvGenres({
        language: (req.query.language as string) ?? req.locale,
      });

      await Promise.all(
        genres.map(async (genre) => {
          const genreData = await tmdb.getDiscoverTv({
            genre: genre.id.toString(),
          });

          mappedGenres.push({
            id: genre.id,
            name: genre.name,
            backdrops: genreData.results
              .filter((title) => !!title.backdrop_path)
              .map((title) => title.backdrop_path) as string[],
          });
        })
      );

      const sortedData = sortBy(mappedGenres, 'name');

      return res.status(200).json(sortedData);
    } catch (e) {
      logger.debug('Something went wrong retrieving the series genre slider', {
        label: 'API',
        errorMessage: e.message,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve series genre slider.',
      });
    }
  }
);

discoverRoutes.get<Record<string, unknown>, WatchlistResponse>(
  '/watchlist',
  async (req, res) => {
    const userRepository = getRepository(User);
    const itemsPerPage = 20;
    const page = Number(req.query.page) ?? 1;
    const offset = (page - 1) * itemsPerPage;

    const activeUser = await userRepository.findOne({
      where: { id: req.user?.id },
      select: ['id', 'plexToken'],
    });

    if (activeUser && !activeUser?.plexToken) {
      // Non-Plex users can only see their own watchlist
      const [result, total] = await getRepository(Watchlist).findAndCount({
        where: { requestedBy: { id: activeUser?.id } },
        relations: {
          /*requestedBy: true,media:true*/
        },
        // loadRelationIds: true,
        take: itemsPerPage,
        skip: offset,
      });
      if (total) {
        return res.json({
          page: page,
          totalPages: Math.ceil(total / itemsPerPage),
          totalResults: total,
          results: result,
        });
      }
    }
    if (!activeUser?.plexToken) {
      // We will just return an empty array if the user has no Plex token
      return res.json({
        page: 1,
        totalPages: 1,
        totalResults: 0,
        results: [],
      });
    }

    // List watchlist from Plex
    const plexTV = new PlexTvAPI(activeUser.plexToken);

    const watchlist = await plexTV.getWatchlist({ offset });

    return res.json({
      page,
      totalPages: Math.ceil(watchlist.totalSize / itemsPerPage),
      totalResults: watchlist.totalSize,
      results: watchlist.items.map((item) => ({
        id: item.tmdbId,
        ratingKey: item.ratingKey,
        title: item.title,
        mediaType: item.type === 'show' ? 'tv' : 'movie',
        tmdbId: item.tmdbId,
      })),
    });
  }
);

export default discoverRoutes;
