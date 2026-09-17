import { describe, expect, it } from 'vitest';
import { type OutstandingCard, defaultCopies, outstandingLabel } from './printRuns.ts';

function owed(overrides: Partial<OutstandingCard> = {}): OutstandingCard {
  return {
    file_id: 'f1',
    version_number: 1,
    quantity: 3,
    printed_copies: 0,
    owed_copies: 3,
    printed_version_number: null,
    last_printed_at: null,
    reason: 'never',
    ...overrides,
  };
}

describe('the count a card starts at', () => {
  it('offers the deck’s own count when the mode is everything', () => {
    expect(defaultCopies(3, owed({ owed_copies: 1 }), 'all')).toBe(3);
  });

  it('offers only what is outstanding when the mode is changed', () => {
    expect(defaultCopies(3, owed({ owed_copies: 1 }), 'changed')).toBe(1);
  });

  it('starts a card that owes nothing at none', () => {
    expect(defaultCopies(3, owed({ owed_copies: 0, reason: null }), 'changed')).toBe(0);
  });

  it('starts a card the deck holds none of at none, whichever mode is on', () => {
    expect(defaultCopies(0, owed({ quantity: 0, owed_copies: 0 }), 'all')).toBe(0);
    expect(defaultCopies(0, owed({ quantity: 0, owed_copies: 0 }), 'changed')).toBe(0);
  });

  // Dropping artwork off a sheet because a lookup missed is the one failure this
  // must not have, so an unknown card falls back to its own count.
  it('offers a card the server said nothing about its full count', () => {
    expect(defaultCopies(2, undefined, 'changed')).toBe(2);
  });
});

describe('the badge beside a card', () => {
  it('draws nothing for a card the printer is square with', () => {
    expect(outstandingLabel(owed({ owed_copies: 0, reason: null }))).toBeNull();
    expect(outstandingLabel(undefined)).toBeNull();
  });

  it('names each reason a card is owed', () => {
    expect(outstandingLabel(owed({ reason: 'never' }))).toBe('never printed');
    expect(outstandingLabel(owed({ reason: 'artwork' }))).toBe('new artwork');
    expect(outstandingLabel(owed({ reason: 'back' }))).toBe('new back');
    expect(outstandingLabel(owed({ reason: 'copies', owed_copies: 2 }))).toBe('2 more');
  });
});
