import type { Command } from 'commander';
import type { components } from '@three-peaks/shared/api';
import { group, inProject, leaf, optString, withCtx } from '../kit.ts';
import { assertOk } from '../errors.ts';
import { day, shortId } from '../output.ts';
import {
  fetchDeck,
  listComponents,
  listDecks,
  projectFromOpts,
  resolveComponent,
  resolveDeck,
} from '../resolve.ts';
import type { CliDeps } from '../context.ts';

type OutstandingCard = components['schemas']['PrintOutstanding']['decks'][number]['cards'][number];

// A deck's cards or a punchboard's tokens, as one listing names them.
interface OwedSet {
  name: string;
  noun: string;
  last_printed_at: string | null;
  // What is printed on the reverse of every one of them, which a deck has
  // and a punchboard's tokens, each with a back of its own, do not.
  back_file_id: string | null;
  cards: OutstandingCard[];
}

// The badge the print screen draws beside a card, in words.
function reasonLabel(card: OutstandingCard): string {
  switch (card.reason) {
    case 'never':
      return 'never printed';
    case 'artwork':
      return 'new artwork';
    case 'back':
      return 'new back';
    case 'copies':
      return `${String(card.owed_copies)} more`;
    case null:
      return '';
  }
}

export function registerPrint(program: Command, deps: CliDeps): void {
  const print = group(
    'print',
    'What the printer still owes. Sheets are built and runs recorded in the web app'
  );

  print.addCommand(
    inProject(leaf('outstanding'))
      .description(
        'Per deck and punchboard, the cards and tokens not yet on paper at their current artwork and back'
      )
      .option('--deck <deck>', 'only this deck')
      .option('--punchboard <punchboard>', 'only this punchboard')
      .option('--all', 'list cards that owe nothing too')
      .action(
        withCtx(deps, async (ctx, opts) => {
          const project = await projectFromOpts(ctx, opts);
          const deckRef = optString(opts, 'deck');
          const boardRef = optString(opts, 'punchboard');
          const onlyDeck =
            deckRef === undefined ? null : await resolveDeck(ctx, project.id, deckRef);
          const onlyBoard =
            boardRef === undefined ? null : await resolveComponent(ctx, project.id, boardRef);
          const narrowed = onlyDeck !== null || onlyBoard !== null;
          const all = opts.all === true;
          const owing = (cards: OutstandingCard[]) =>
            all ? cards : cards.filter((card) => card.owed_copies > 0);

          const payload = assertOk(
            await ctx.api.GET('/api/print/outstanding', {
              params: { query: { project_id: project.id } },
            })
          );
          const decks = payload.decks
            .filter((deck) => (narrowed ? deck.deck_id === onlyDeck?.id : true))
            .map((deck) => ({ ...deck, cards: owing(deck.cards) }));
          const punchboards = payload.punchboards
            .filter((board) => (narrowed ? board.component_id === onlyBoard?.id : true))
            .map((board) => ({ ...board, tokens: owing(board.tokens) }));

          // The payload names things by id alone, so the names come from the
          // decks and punchboards themselves -- one read per deck that has rows
          // to show, and a punchboard carries its tokens' rows already.
          const deckNames = Object.fromEntries(
            (await listDecks(ctx, project.id)).map((deck) => [deck.id, deck.name])
          );
          const boards = new Map(
            (await listComponents(ctx, project.id, 'punchboard')).map((board) => [board.id, board])
          );
          const filenames: Record<string, string> = {};
          if (!ctx.out.json) {
            for (const deck of decks) {
              if (deck.cards.length === 0) continue;
              for (const card of (await fetchDeck(ctx, deck.deck_id)).cards) {
                filenames[card.file_id] = card.file.filename;
              }
            }
            for (const board of boards.values()) {
              for (const token of board.tokens) filenames[token.file_id] = token.file.filename;
            }
          }

          const sets: OwedSet[] = [
            ...decks.map((deck) => ({
              name: deckNames[deck.deck_id] ?? shortId(deck.deck_id),
              noun: 'CARD',
              last_printed_at: deck.last_printed_at,
              back_file_id: deck.back_file_id,
              cards: deck.cards,
            })),
            ...punchboards.map((board) => ({
              name: boards.get(board.component_id)?.name ?? shortId(board.component_id),
              noun: 'TOKEN',
              last_printed_at: board.last_printed_at,
              back_file_id: null,
              cards: board.tokens,
            })),
          ];

          ctx.out.data({ decks, punchboards }, () => {
            if (sets.length === 0) {
              ctx.out.line(`No decks or punchboards in "${project.name}"`);
              return;
            }
            sets.forEach((set, index) => {
              if (index > 0) ctx.out.line();
              const owed = set.cards.reduce((sum, card) => sum + card.owed_copies, 0);
              const last =
                set.last_printed_at === null
                  ? 'never printed'
                  : `last printed ${day(set.last_printed_at)}`;
              ctx.out.line(
                `${set.name} — ${owed === 0 ? 'nothing owed' : `${String(owed)} ${owed === 1 ? 'copy' : 'copies'} owed`} (${last})`
              );
              if (set.cards.length === 0) return;
              ctx.out.table(
                [`  ${set.noun}`, 'OWED', 'PRINTED', 'WANTED', 'VERSION', 'WHY'],
                set.cards.map((card) => [
                  `  ${filenames[card.file_id] ?? shortId(card.file_id)}`,
                  String(card.owed_copies),
                  String(card.printed_copies),
                  String(card.quantity),
                  `v${String(card.version_number)}`,
                  [reasonLabel(card), card.file_id === set.back_file_id ? "the deck's back" : '']
                    .filter((note) => note !== '')
                    .join(', '),
                ])
              );
            });
          });
        })
      )
  );

  program.addCommand(print);
}
