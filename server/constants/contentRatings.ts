/**
 * Content rating hierarchies and filtering utilities for parental controls.
 *
 * Movie ratings follow the MPAA system (US):
 *   G < PG < PG-13 < R < NC-17
 *
 * TV ratings follow the TV Parental Guidelines (US):
 *   TV-Y < TV-Y7 < TV-G < TV-PG < TV-14 < TV-MA
 */

// ----- Interfaces -----

export interface UserContentRatingLimits {
  maxMovieRating: string | null;
  maxTvRating: string | null;
  blockUnrated: boolean;
  blockAdult: boolean;
}

export interface RatingOption {
  label: string;
  value: string;
}

// ----- Rating hierarchies (lower index = more restrictive) -----

export const MOVIE_RATING_ORDER: string[] = ['G', 'PG', 'PG-13', 'R', 'NC-17'];

export const TV_RATING_ORDER: string[] = [
  'TV-Y',
  'TV-Y7',
  'TV-G',
  'TV-PG',
  'TV-14',
  'TV-MA',
];

// Values that indicate a title has no rating / is unrated
export const UNRATED_VALUES: string[] = [
  '',
  'NR',
  'UR',
  'Unrated',
  'Not Rated',
];

// ----- Comparison helpers -----

/**
 * Returns `true` if the given movie certification should be filtered out
 * based on the user's maximum allowed rating.
 *
 * A title is filtered if its rating index is strictly greater than the
 * max allowed index. Unknown / unrated titles are NOT filtered here;
 * the `blockUnrated` flag handles those separately.
 */
export function shouldFilterMovie(
  certification: string,
  maxRating: string
): boolean {
  const maxIdx = MOVIE_RATING_ORDER.indexOf(maxRating);
  if (maxIdx === -1) return false; // unknown max → don't filter

  const certIdx = MOVIE_RATING_ORDER.indexOf(certification);
  if (certIdx === -1) return false; // cert not in hierarchy → handle via blockUnrated

  return certIdx > maxIdx;
}

/**
 * Returns `true` if the given TV content rating should be filtered out
 * based on the user's maximum allowed rating.
 */
export function shouldFilterTv(rating: string, maxRating: string): boolean {
  const maxIdx = TV_RATING_ORDER.indexOf(maxRating);
  if (maxIdx === -1) return false;

  const ratingIdx = TV_RATING_ORDER.indexOf(rating);
  if (ratingIdx === -1) return false;

  return ratingIdx > maxIdx;
}

/**
 * Check whether a certification string counts as "unrated".
 */
export function isUnrated(certification: string | undefined | null): boolean {
  if (!certification) return true;
  return UNRATED_VALUES.includes(certification);
}

// ----- Dropdown option builders -----

export function getMovieRatingOptions(): RatingOption[] {
  return MOVIE_RATING_ORDER.map((r) => ({ label: r, value: r }));
}

export function getTvRatingOptions(): RatingOption[] {
  return TV_RATING_ORDER.map((r) => ({ label: r, value: r }));
}
