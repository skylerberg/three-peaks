import {
  CARD_PRESETS,
  DECK_QUANTITY_LIMITS,
  DEFAULT_CARD_SETTINGS,
  cardPreset,
  deckCardSize,
  isLiveCard,
  matchingCardPreset,
  type CardModelSettings,
  type CardSize,
} from '@three-peaks/shared';
import { CliError, EXIT } from './errors.ts';
import type { Deck, DeckCard } from './resolve.ts';

// What a listing draws: the deck as it will come off the printer, or every row
// it holds when the deleted ones were asked for.
export function shownCards(cards: readonly DeckCard[], all: boolean): DeckCard[] {
  return all ? [...cards] : cards.filter(isLiveCard);
}

export function cardsInput(list: readonly DeckCard[]): { file_id: string; quantity: number }[] {
  return list.map((card) => ({ file_id: card.file_id, quantity: card.quantity }));
}

export function parseQuantity(raw: string): number {
  const [min, max] = DECK_QUANTITY_LIMITS;
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(value) || value < min || value > max) {
    throw new CliError(
      `A copy count is a whole number from ${String(min)} to ${String(max)}, not "${raw}"`,
      EXIT.invalid
    );
  }
  return value;
}

function parseMillimetres(raw: string, flag: string): number {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value) || value <= 0) {
    throw new CliError(`${flag} takes a length in millimetres, not "${raw}"`, EXIT.invalid);
  }
  return value;
}

export function presetSize(id: string): CardSize {
  const preset = cardPreset(id.toLowerCase());
  if (preset === undefined) {
    const known = CARD_PRESETS.map((p) => p.id).join(', ');
    throw new CliError(`No card size "${id}"; one of: ${known}`, EXIT.usage);
  }
  return { width_mm: preset.width_mm, height_mm: preset.height_mm };
}

// A named size and an explicit one are two answers to one question, so a
// command given both refuses rather than choosing between them.
export function sizeFromOptions(options: {
  size?: string;
  width?: string;
  height?: string;
}): Partial<CardSize> | undefined {
  const { size, width, height } = options;
  if (size !== undefined && (width !== undefined || height !== undefined)) {
    throw new CliError('Pass --size or --width/--height, not both', EXIT.usage);
  }
  if (size !== undefined) return presetSize(size);
  if (width === undefined && height === undefined) return undefined;
  return {
    ...(width === undefined ? {} : { width_mm: parseMillimetres(width, '--width') }),
    ...(height === undefined ? {} : { height_mm: parseMillimetres(height, '--height') }),
  };
}

export function sizeLabel(deck: Pick<Deck, 'card_width_mm' | 'card_height_mm'>): string {
  return (
    matchingCardPreset(deckCardSize(deck))?.name ??
    `${String(deck.card_width_mm)} × ${String(deck.card_height_mm)} mm`
  );
}

// A card nobody has dialled in is the deck's size, the way the scene exporter
// already sizes one; the other settings are the studio's defaults.
export function defaultCardModel(
  deck: Pick<Deck, 'card_width_mm' | 'card_height_mm'>
): CardModelSettings {
  return {
    ...DEFAULT_CARD_SETTINGS,
    width_mm: deck.card_width_mm,
    height_mm: deck.card_height_mm,
  };
}

// A filename is whatever the upload or the import was called, so it may carry a
// separator; written out as-is it would land somewhere other than the folder
// asked for.
export function safeFilename(name: string): string {
  const flat = name.replace(/[/\\]/g, '_');
  return flat === '' || flat === '.' || flat === '..' ? `_${flat}` : flat;
}
