export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;
export const PERSONAL_ACCESS_TOKEN_PREFIX = 'tph_';

// A token's name is what the list shows to say what it is for, so it is held to
// what fits on one line of that list.
export const PERSONAL_ACCESS_TOKEN_NAME_LIMITS = [1, 100] as const;
// Enough for a token per script and per machine, and a bound on a table that
// otherwise grows by one row per call for as long as somebody keeps calling.
export const MAX_PERSONAL_ACCESS_TOKENS_PER_USER = 50;
