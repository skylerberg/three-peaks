import type { Command } from 'commander';
import type { components } from '@three-peaks/shared/api';
import { group, inProject, leaf, optString, withCtx } from '../kit.ts';
import { assertOk } from '../errors.ts';
import { day, shortId } from '../output.ts';
import { fetchDeck, listDecks, projectFromOpts, resolveDeck, type Deck } from '../resolve.ts';
import type { CliDeps } from '../context.ts';

type OutstandingDeck = components['schemas']['PrintOutstanding']['decks'][number];
type OutstandingCard = OutstandingDeck['cards'][number];

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
      .description('Per deck, the cards not yet on paper at their current artwork and back')
      .option('--deck <deck>', 'only this deck')
      .option('--all', 'list cards that owe nothing too')
      .action(
        withCtx(deps, async (ctx, opts) => {
          const project = await projectFromOpts(ctx, opts);
          const deckRef = optString(opts, 'deck');
          const only = deckRef === undefined ? null : await resolveDeck(ctx, project.id, deckRef);
          const all = opts.all === true;

          const payload = assertOk(
            await ctx.api.GET('/api/print/outstanding', {
              params: { query: { project_id: project.id } },
            })
          );
          const decks = payload.decks
            .filter((deck) => only === null || deck.deck_id === only.id)
            .map((deck) => ({
              ...deck,
              cards: all ? deck.cards : deck.cards.filter((card) => card.owed_copies > 0),
            }));

          // The payload names decks and cards by id alone, so the names come
          // from the decks themselves -- one read per deck that has rows to show.
          const named: Record<string, Deck> = Object.fromEntries(
            (only === null ? await listDecks(ctx, project.id) : [only]).map((d) => [d.id, d])
          );
          const filenames: Record<string, string> = {};
          if (!ctx.out.json) {
            for (const deck of decks) {
              if (deck.cards.length === 0) continue;
              for (const card of (await fetchDeck(ctx, deck.deck_id)).cards) {
                filenames[card.file_id] = card.file.filename;
              }
            }
          }

          ctx.out.data({ decks }, () => {
            if (decks.length === 0) {
              ctx.out.line(`No decks in "${project.name}"`);
              return;
            }
            decks.forEach((deck, index) => {
              if (index > 0) ctx.out.line();
              const name = named[deck.deck_id]?.name ?? shortId(deck.deck_id);
              const owed = deck.cards.reduce((sum, card) => sum + card.owed_copies, 0);
              const last =
                deck.last_printed_at === null
                  ? 'never printed'
                  : `last printed ${day(deck.last_printed_at)}`;
              ctx.out.line(
                `${name} — ${owed === 0 ? 'nothing owed' : `${String(owed)} ${owed === 1 ? 'copy' : 'copies'} owed`} (${last})`
              );
              if (deck.cards.length === 0) return;
              ctx.out.table(
                ['  CARD', 'OWED', 'PRINTED', 'WANTED', 'VERSION', 'WHY'],
                deck.cards.map((card) => [
                  `  ${filenames[card.file_id] ?? shortId(card.file_id)}`,
                  String(card.owed_copies),
                  String(card.printed_copies),
                  String(card.quantity),
                  `v${String(card.version_number)}`,
                  [reasonLabel(card), card.file_id === deck.back_file_id ? "the deck's back" : '']
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
