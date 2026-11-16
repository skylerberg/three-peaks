import { type } from 'arktype';
import { DECK_QUANTITY_LIMITS, MAX_PRINT_RUN_CARDS, PRINT_REASONS } from '@three-peaks/shared';
import { uuid } from './common.ts';

// Enumerated rather than a bare string, for the reason imports.ts gives at its
// own matched_by: a reason added here has to show up as a red diff in the
// generated client, because a screen renders an unknown one as a blank badge.
const reason = type.enumerated(...PRINT_REASONS).or('null');

export const printOutstandingCardSchema = type({
  file_id: 'string',
  // The version this card is at now -- what the print screen fetches and what
  // it hands back when it records the run.
  version_number: 'number',
  quantity: 'number',
  // The reverse it is printed with now -- its deck's back, or a token's own --
  // at the version the print screen draws and records it at.
  back_file_id: 'string | null',
  back_version_number: 'number | null',
  // Copies already on paper at this artwork, behind that reverse.
  printed_copies: 'number',
  owed_copies: 'number',
  // The newest version any run ever printed, whatever back it carried. Null
  // means no run has printed this card at all.
  printed_version_number: 'number | null',
  last_printed_at: 'string | null',
  // Null when the card owes nothing.
  reason,
});

export const printOutstandingDeckSchema = type({
  deck_id: 'string',
  back_file_id: 'string | null',
  back_version_number: 'number | null',
  last_printed_at: 'string | null',
  cards: printOutstandingCardSchema.array(),
});

export const printOutstandingPunchboardSchema = type({
  component_id: 'string',
  last_printed_at: 'string | null',
  tokens: printOutstandingCardSchema.array(),
});

export const printOutstandingSchema = type({
  decks: printOutstandingDeckSchema.array(),
  punchboards: printOutstandingPunchboardSchema.array(),
});

const [, maxQuantity] = DECK_QUANTITY_LIMITS;

// A version number is bounded so a client cannot record one no file will reach
// this century; the service checks it against the file's own history as well.
const versionNumber = `1 <= number.integer <= 1000000` as const;

const printRunCardInputSchema = type({
  file_id: uuid,
  version_number: versionNumber,
  // At least one: a card nothing was printed of is a card the run leaves out.
  copies: `1 <= number.integer <= ${maxQuantity}`,
  // Absent or null when the run left the backing pages out, which is what makes
  // a later change of back not ask for those cards again.
  'back_file_id?': 'string.uuid | null',
  'back_version_number?': `${versionNumber} | null`,
});

export const recordPrintRunRequestSchema = type({
  'id?': uuid,
  project_id: uuid,
  cards: printRunCardInputSchema.array().atLeastLength(1).atMostLength(MAX_PRINT_RUN_CARDS),
});

export const printRunSchema = type({
  id: 'string',
  project_id: 'string',
  // Null once the account that printed it is gone. The record of what is on
  // paper outlives its author, the way a file's deleted_by does.
  created_by: 'string | null',
  created_at: 'string',
  card_count: 'number',
  copies: 'number',
});
