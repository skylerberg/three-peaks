import { assertDone, assertOk } from './errors.ts';
import { deletedPath, type DeletedEntry } from './resolve.ts';
import type { RuntimeContext } from './context.ts';

type Kind = DeletedEntry['kind'];

// A file or a folder takes its new name in the restore itself. A deck and a
// component have no such parameter, so the tombstone is renamed first: the name
// indexes skip deleted rows, so that rename cannot collide with whatever took
// the old name, and a live screen ignores an update to a row it is not showing.
export async function restoreDeleted(
  ctx: RuntimeContext,
  entry: { kind: Kind; id: string },
  name?: string
): Promise<unknown> {
  switch (entry.kind) {
    case 'file':
      return assertOk(
        await ctx.api.POST('/api/files/{id}/restore', {
          params: { path: { id: entry.id }, query: name === undefined ? {} : { filename: name } },
        })
      );
    case 'folder':
      return assertOk(
        await ctx.api.POST('/api/files/folders/{id}/restore', {
          params: { path: { id: entry.id }, query: name === undefined ? {} : { name } },
        })
      );
    case 'deck':
      if (name !== undefined) {
        assertOk(
          await ctx.api.PATCH('/api/decks/{deckId}', {
            params: { path: { deckId: entry.id } },
            body: { name },
          })
        );
      }
      return assertOk(
        await ctx.api.POST('/api/decks/{deckId}/restore', {
          params: { path: { deckId: entry.id } },
        })
      );
    case 'component':
      if (name !== undefined) {
        assertOk(
          await ctx.api.PATCH('/api/components/{componentId}', {
            params: { path: { componentId: entry.id } },
            body: { name },
          })
        );
      }
      return assertOk(
        await ctx.api.POST('/api/components/{componentId}/restore', {
          params: { path: { componentId: entry.id } },
        })
      );
  }
}

export async function purgeDeleted(
  ctx: RuntimeContext,
  entry: { kind: Kind; id: string }
): Promise<void> {
  const query = { purge: 'true' as const };
  switch (entry.kind) {
    case 'file':
      assertDone(
        await ctx.api.DELETE('/api/files/{id}', { params: { path: { id: entry.id }, query } })
      );
      return;
    case 'folder':
      assertDone(
        await ctx.api.DELETE('/api/files/folders/{id}', {
          params: { path: { id: entry.id }, query },
        })
      );
      return;
    case 'deck':
      assertDone(
        await ctx.api.DELETE('/api/decks/{deckId}', {
          params: { path: { deckId: entry.id }, query },
        })
      );
      return;
    case 'component':
      assertDone(
        await ctx.api.DELETE('/api/components/{componentId}', {
          params: { path: { componentId: entry.id }, query },
        })
      );
      return;
  }
}

export function describeEntry(entry: DeletedEntry): string {
  return `${entry.kind} "${deletedPath(entry)}"`;
}
