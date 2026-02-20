import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbSearchMultiResponse,
} from '@server/api/themoviedb/interfaces';
import type { UserContentRatingLimits } from '@server/constants/contentRatings';
import {
  isUnrated,
  shouldFilterMovie,
  shouldFilterTv,
} from '@server/constants/contentRatings';
import Media from '@server/entity/Media';
import { findSearchProvider } from '@server/lib/search';
import logger from '@server/logger';
import { mapSearchResults } from '@server/models/Search';
import {
  getMovieCertFromDetails,
  getUserContentRatingLimits,
} from '@server/routes/discover';
import { Router } from 'express';

type SearchResult = TmdbSearchMultiResponse['results'][number];

/**
 * Filter a batch of search results by content rating.
 * Uses parallel TMDB detail lookups for performance.
 * Fail-open: items whose cert lookup fails are kept.
 */
async function filterSearchResults(
  tmdb: TheMovieDb,
  results: SearchResult[],
  limits: UserContentRatingLimits
): Promise<SearchResult[]> {
  const settled = await Promise.allSettled(
    results.map(async (result) => {
      if (result.media_type === 'movie') {
        const movie = result as TmdbMovieResult;

        // blockAdult — no API call needed
        if (limits.blockAdult && movie.adult) {
          return { result, blocked: true };
        }

        if (limits.blockUnrated || limits.maxMovieRating) {
          const details = await tmdb.getMovie({ movieId: movie.id });
          const cert = getMovieCertFromDetails(
            details.release_dates?.results ?? []
          );

          if (limits.blockUnrated && isUnrated(cert)) {
            return { result, blocked: true };
          }

          if (
            limits.maxMovieRating &&
            cert &&
            shouldFilterMovie(cert, limits.maxMovieRating)
          ) {
            return { result, blocked: true };
          }
        }

        return { result, blocked: false };
      } else if (result.media_type === 'tv') {
        if (limits.blockUnrated || limits.maxTvRating) {
          const details = await tmdb.getTvShow({ tvId: result.id });
          const usRating = details.content_ratings?.results?.find(
            (r) => r.iso_3166_1 === 'US'
          );
          const cert = usRating?.rating ?? '';

          if (limits.blockUnrated && isUnrated(cert)) {
            return { result, blocked: true };
          }

          if (
            limits.maxTvRating &&
            cert &&
            shouldFilterTv(cert, limits.maxTvRating)
          ) {
            return { result, blocked: true };
          }
        }

        return { result, blocked: false };
      }

      // Person, Collection — always pass through
      return { result, blocked: false };
    })
  );

  const filtered: SearchResult[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      // Fail-open: keep the item
      filtered.push(results[settled.indexOf(outcome)]);
      continue;
    }
    if (!outcome.value.blocked) {
      filtered.push(outcome.value.result);
    }
  }

  return filtered;
}

const searchRoutes = Router();

searchRoutes.get('/', async (req, res, next) => {
  const queryString = req.query.query as string;
  const searchProvider = findSearchProvider(queryString.toLowerCase());
  const tmdb = new TheMovieDb();
  const limits = getUserContentRatingLimits(req.user);
  const searchPage = Number(req.query.page) || 1;
  const searchLang = (req.query.language as string) ?? req.locale;

  let results: TmdbSearchMultiResponse;

  try {
    if (searchProvider) {
      const [id] = queryString
        .toLowerCase()
        .match(searchProvider.pattern) as RegExpMatchArray;
      results = await searchProvider.search({
        id,
        language: searchLang,
        query: queryString,
      });
    } else {
      results = await tmdb.searchMulti({
        query: queryString,
        page: searchPage,
        language: searchLang,
      });
    }

    let filteredResults = results.results;
    const originalCount = results.results.length;

    if (limits) {
      filteredResults = await filterSearchResults(
        tmdb,
        results.results,
        limits
      );

      // Backfill: if filtering dropped too many results and more pages exist,
      // grab one additional page to compensate
      if (
        filteredResults.length < 10 &&
        !searchProvider &&
        searchPage < results.total_pages
      ) {
        const nextPage = await tmdb.searchMulti({
          query: queryString,
          page: searchPage + 1,
          language: searchLang,
        });

        const nextFiltered = await filterSearchResults(
          tmdb,
          nextPage.results,
          limits
        );
        filteredResults = filteredResults.concat(nextFiltered);
      }
    }

    const media = await Media.getRelatedMedia(
      req.user,
      filteredResults.map((result) => result.id)
    );

    // Estimate adjusted totals based on filter ratio
    const filterRatio =
      limits && originalCount > 0 ? filteredResults.length / originalCount : 1;

    return res.status(200).json({
      page: results.page,
      totalPages: Math.ceil(results.total_pages * filterRatio),
      totalResults: Math.ceil(results.total_results * filterRatio),
      results: mapSearchResults(filteredResults, media),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving search results', {
      label: 'API',
      errorMessage: e.message,
      query: req.query.query,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve search results.',
    });
  }
});

searchRoutes.get('/keyword', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.searchKeyword({
      query: req.query.query as string,
      page: Number(req.query.page),
    });

    return res.status(200).json(results);
  } catch (e) {
    logger.debug('Something went wrong retrieving keyword search results', {
      label: 'API',
      errorMessage: e.message,
      query: req.query.query,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve keyword search results.',
    });
  }
});

searchRoutes.get('/company', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.searchCompany({
      query: req.query.query as string,
      page: Number(req.query.page),
    });

    return res.status(200).json(results);
  } catch (e) {
    logger.debug('Something went wrong retrieving company search results', {
      label: 'API',
      errorMessage: e.message,
      query: req.query.query,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve company search results.',
    });
  }
});

export default searchRoutes;
