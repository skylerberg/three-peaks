import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PUNCHBOARD_SETTINGS,
  type LayoutElement,
  type LayoutSpec,
} from '@three-peaks/shared';
import { drainRenders } from '../../src/services/renderWorker.ts';
import { boxFont, solidPng } from '../setup/layoutFixtures.ts';
import { createUser, deleteUser, type TestUser } from '../setup/testContext.ts';

// Real images and a real font, because a token drawn from a layout is drawn
// when it is saved.
const OTF = Buffer.from(boxFont(600));
let RED: Buffer;

interface Token {
  file_id: string;
  back_file_id: string | null;
  quantity: number;
  position: number;
  file: { id: string; filename: string; deleted_at: string | null; checksum: string | null };
  back_file: { id: string; filename: string; checksum: string | null } | null;
}

const entry = (token: Token) => ({
  file_id: token.file_id,
  back_file_id: token.back_file_id,
  quantity: token.quantity,
});

describe('punchboard tokens', () => {
  let owner: TestUser;
  let viewer: TestUser;
  let stranger: TestUser;
  let projectId: string;
  let fontId: string;

  async function upload(
    filename: string,
    into: Record<string, string> = {},
    bytes: Buffer = RED,
    user: TestUser = owner
  ) {
    const query = new URLSearchParams({ project_id: projectId, filename, ...into });
    const res = await user.api.postBytes(
      `/api/files/upload?${query}`,
      bytes as unknown as BodyInit,
      'image/png'
    );
    return { status: res.status, body: await res.json() };
  }

  async function createPunchboard(name: string): Promise<string> {
    const res = await owner.api.post('/api/components', {
      project_id: projectId,
      kind: 'punchboard',
      name,
    });
    expect(res.status).toBe(201);
    return (await res.json()).id;
  }

  async function tokensOf(componentId: string): Promise<Token[]> {
    return (await (await owner.api.get(`/api/components/${componentId}`)).json()).tokens;
  }

  async function putTokens(componentId: string, tokens: unknown[], user: TestUser = owner) {
    const res = await user.api.put(`/api/components/${componentId}/tokens`, { tokens });
    return { status: res.status, body: await res.json() };
  }

  async function versions(fileId: string): Promise<number> {
    const res = await owner.api.get(`/api/files/${fileId}/versions`);
    return ((await res.json()) as { versions: unknown[] }).versions.length;
  }

  beforeAll(async () => {
    RED = Buffer.from(await solidPng('#cc3333'));
    [owner, viewer, stranger] = await Promise.all([
      createUser('token-owner'),
      createUser('token-viewer'),
      createUser('token-stranger'),
    ]);
    projectId = (await (await owner.api.post('/api/projects', { name: 'Tokens' })).json()).id;
    await owner.api.put(`/api/projects/${projectId}/members`, {
      email: viewer.email,
      role: 'viewer',
    });
    fontId = (await upload('Body.otf', {}, OTF)).body.id;
  });

  afterAll(async () => {
    for (const user of [owner, viewer, stranger]) await deleteUser(user);
  });

  describe('tokens uploaded as images', () => {
    let board: string;

    beforeAll(async () => {
      board = await createPunchboard('Uploaded');
    });

    it('makes each image a token at the end of the list, with nothing printed behind it', async () => {
      const first = await upload('seeker.png', { component_id: board });
      const second = await upload('reader.png', { component_id: board });
      expect(first.status).toBe(201);
      expect(second.body).toMatchObject({ component_id: board, component_role: 'token' });

      const component = await (await owner.api.get(`/api/components/${board}`)).json();
      expect(component.missing_roles).toEqual([]);
      expect(component.files).toEqual([]);
      expect(component.tokens.map(entry)).toEqual([
        { file_id: first.body.id, back_file_id: null, quantity: 1 },
        { file_id: second.body.id, back_file_id: null, quantity: 1 },
      ]);
    });

    it('takes a back uploaded for a token, and a second one only as a version', async () => {
      const [seeker] = await tokensOf(board);
      const back = await upload('seeker back.png', {
        component_id: board,
        role: 'back',
        back_of: seeker!.file_id,
      });
      expect(back.status).toBe(201);
      const [after] = await tokensOf(board);
      expect(after!.back_file_id).toBe(back.body.id);
      expect(after!.back_file?.filename).toBe('seeker back.png');

      const again = await upload('another back.png', {
        component_id: board,
        role: 'back',
        back_of: seeker!.file_id,
      });
      expect(again.status).toBe(409);
      expect(again.body.error).toMatch(/already has a back. Add a version/);
    });

    it('refuses a back for a token it does not have, or one naming no token', async () => {
      const loose = await upload('loose.png');
      const stray = await upload('stray back.png', {
        component_id: board,
        role: 'back',
        back_of: loose.body.id,
      });
      expect(stray.status).toBe(404);
      const unnamed = await upload('unnamed back.png', { component_id: board, role: 'back' });
      expect(unnamed.status).toBe(422);
      expect(unnamed.body.error).toMatch(/names the token it is the back of/);
    });

    it('refuses artwork, which a punchboard has no slot for', async () => {
      const res = await upload('sheet.png', { component_id: board, role: 'artwork' });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/not a role a punchboard has/);
    });
  });

  describe('the token list', () => {
    let board: string;
    let a: string;
    let b: string;
    let c: string;

    beforeAll(async () => {
      board = await createPunchboard('Arranged');
      a = (await upload('a.png', { component_id: board })).body.id;
      b = (await upload('b.png', { component_id: board })).body.id;
      c = (await upload('c.png', { component_id: board })).body.id;
    });

    it('reorders, recounts and prints a front on both sides in one save', async () => {
      const res = await putTokens(board, [
        { file_id: c, back_file_id: c, quantity: 3 },
        { file_id: a, back_file_id: null, quantity: 0 },
        { file_id: b, back_file_id: null, quantity: 2 },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.tokens.map(entry)).toEqual([
        { file_id: c, back_file_id: c, quantity: 3 },
        { file_id: a, back_file_id: null, quantity: 0 },
        { file_id: b, back_file_id: null, quantity: 2 },
      ]);
      expect(res.body.tokens[0].back_file.id).toBe(c);
    });

    it('refuses a front named twice, a file it does not hold, and a front as another’s back', async () => {
      const twice = await putTokens(board, [
        { file_id: a, back_file_id: null, quantity: 1 },
        { file_id: a, back_file_id: null, quantity: 1 },
        { file_id: b, back_file_id: null, quantity: 1 },
        { file_id: c, back_file_id: null, quantity: 1 },
      ]);
      expect(twice.status).toBe(422);
      expect(twice.body.error).toMatch(/in the list twice/);

      const loose = (await upload('not held.png')).body.id;
      const foreign = await putTokens(board, [
        { file_id: a, back_file_id: loose, quantity: 1 },
        { file_id: b, back_file_id: null, quantity: 1 },
        { file_id: c, back_file_id: null, quantity: 1 },
      ]);
      expect(foreign.status).toBe(422);
      expect(foreign.body.error).toMatch(/images this punchboard holds/);

      const crossed = await putTokens(board, [
        { file_id: a, back_file_id: b, quantity: 1 },
        { file_id: b, back_file_id: null, quantity: 1 },
        { file_id: c, back_file_id: null, quantity: 1 },
      ]);
      expect(crossed.status).toBe(422);
      expect(crossed.body.error).toMatch(/"b.png" is a token of its own/);
    });

    it('refuses a list leaving a live image out', async () => {
      const res = await putTokens(board, [
        { file_id: a, back_file_id: null, quantity: 1 },
        { file_id: b, back_file_id: null, quantity: 1 },
      ]);
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/"c.png" would be left in this punchboard/);
    });

    it('lets one image be the back of several tokens', async () => {
      const shared = (await upload('shared back.png', { component_id: board })).body.id;
      const res = await putTokens(board, [
        { file_id: a, back_file_id: shared, quantity: 1 },
        { file_id: b, back_file_id: shared, quantity: 1 },
        { file_id: c, back_file_id: c, quantity: 1 },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.tokens.map((t: Token) => t.back_file_id)).toEqual([shared, shared, c]);
    });

    it('is a punchboard’s alone, an editor’s alone, and 404 to a stranger', async () => {
      const tokens = (await tokensOf(board)).map(entry);
      expect((await putTokens(board, tokens, viewer)).status).toBe(403);
      expect((await putTokens(board, tokens, stranger)).status).toBe(404);

      const box = await owner.api.post('/api/components', {
        project_id: projectId,
        kind: 'box',
        name: 'Not a punchboard',
      });
      const res = await putTokens((await box.json()).id, []);
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('Only a punchboard has tokens');
    });
  });

  describe('deleting and moving', () => {
    let board: string;

    beforeAll(async () => {
      board = await createPunchboard('Moved about');
    });

    it('keeps a deleted token in its place, leaves it out of a save, and restores it there', async () => {
      const first = (await upload('first.png', { component_id: board })).body.id;
      const second = (await upload('second.png', { component_id: board })).body.id;
      expect((await owner.api.delete(`/api/files/${first}`)).status).toBe(204);

      const held = await tokensOf(board);
      expect(held.map((t) => t.file_id)).toEqual([first, second]);
      expect(held[0]!.file.deleted_at).not.toBeNull();

      // A list read back with the deleted token in it saves, and so does one
      // that leaves it out.
      expect((await putTokens(board, held.map(entry))).status).toBe(200);
      expect(
        (await putTokens(board, [{ file_id: second, back_file_id: null, quantity: 2 }])).status
      ).toBe(200);

      expect((await owner.api.post(`/api/files/${first}/restore`)).status).toBe(200);
      expect((await tokensOf(board)).map(entry)).toEqual([
        { file_id: second, back_file_id: null, quantity: 2 },
        { file_id: first, back_file_id: null, quantity: 1 },
      ]);
    });

    it('purges a token’s front with the back that was its alone', async () => {
      const front = (await upload('doomed.png', { component_id: board })).body.id;
      const back = (
        await upload('doomed back.png', { component_id: board, role: 'back', back_of: front })
      ).body.id;
      expect((await owner.api.delete(`/api/files/${front}?purge=true`)).status).toBe(204);
      expect((await owner.api.get(`/api/files/${back}`)).status).toBe(404);
      expect((await tokensOf(board)).map((t) => t.file_id)).not.toContain(front);
    });

    it('makes an image moved in from Assets a token', async () => {
      const loose = (await upload('moved in.png')).body.id;
      const res = await owner.api.post(`/api/files/${loose}/move`, { component_id: board });
      expect(res.status).toBe(200);
      expect((await res.json()).component_role).toBe('token');
      expect((await tokensOf(board)).at(-1)!.file_id).toBe(loose);
    });

    it('moves a back out first, and only then the token it belonged to', async () => {
      const front = (await upload('leaving.png', { component_id: board })).body.id;
      const back = (
        await upload('leaving back.png', { component_id: board, role: 'back', back_of: front })
      ).body.id;

      const refused = await owner.api.post(`/api/files/${front}/move`, { folder_id: null });
      expect(refused.status).toBe(409);
      expect((await refused.json()).error).toMatch(/back of its own/);

      expect((await owner.api.post(`/api/files/${back}/move`, { folder_id: null })).status).toBe(
        200
      );
      const token = (await tokensOf(board)).find((t) => t.file_id === front)!;
      expect(token.back_file_id).toBeNull();

      expect((await owner.api.post(`/api/files/${front}/move`, { folder_id: null })).status).toBe(
        200
      );
      expect((await tokensOf(board)).map((t) => t.file_id)).not.toContain(front);
    });

    it('makes a restored image that lost its place a token of its own', async () => {
      const front = (await upload('orphan front.png', { component_id: board })).body.id;
      const back = (
        await upload('orphan back.png', { component_id: board, role: 'back', back_of: front })
      ).body.id;
      // The back is deleted, and the token stops naming it.
      expect((await owner.api.delete(`/api/files/${back}`)).status).toBe(204);
      const tokens = (await tokensOf(board)).map((t) =>
        t.file_id === front ? { ...entry(t), back_file_id: null } : entry(t)
      );
      expect((await putTokens(board, tokens)).status).toBe(200);

      expect((await owner.api.post(`/api/files/${back}/restore`)).status).toBe(200);
      expect((await tokensOf(board)).at(-1)!.file_id).toBe(back);
    });
  });

  describe('tokens drawn from a layout', () => {
    let board: string;
    let layoutId: string;

    function text(
      overrides: Partial<Extract<LayoutElement, { type: 'text' }>> = {}
    ): LayoutElement {
      return {
        type: 'text',
        id: null,
        box: { left: 2, top: 8, right: 23, bottom: 17 },
        when: null,
        rotate: 0,
        text: '{{points}}',
        font: 'body',
        bold_font: null,
        size_pt: 12,
        min_size_pt: 12,
        line_height: 1.2,
        color: '#ffffff',
        align: 'center',
        valign: 'middle',
        hug: false,
        ...overrides,
      };
    }

    function disc(fill: string): LayoutElement {
      return {
        type: 'rect',
        id: null,
        box: { left: 0, top: 0, right: 25, bottom: 25 },
        when: null,
        rotate: 0,
        fill,
        stroke: null,
        stroke_mm: 0,
        radius_mm: 12.5,
        opacity: 1,
      };
    }

    function spec(back: LayoutElement[] | null = [disc('#c9a227'), text({ color: '#000000' })]) {
      return {
        dpi: 150,
        fonts: { body: fontId },
        icons: {},
        fields: { points: { type: 'text' as const } },
        elements: [disc('#000000'), text()],
        back,
      } satisfies LayoutSpec;
    }

    async function createLayout(name: string, layoutSpec: LayoutSpec, size = 25) {
      const res = await owner.api.post('/api/layouts', {
        project_id: projectId,
        name,
        width_mm: size,
        height_mm: size,
        spec: layoutSpec,
      });
      return { status: res.status, body: await res.json() };
    }

    async function contents() {
      const res = await owner.api.get(`/api/card-content?component_id=${board}`);
      expect(res.status).toBe(200);
      return (await res.json()).cards as {
        file_id: string;
        render_status: string;
        render_error: string | null;
      }[];
    }

    beforeAll(async () => {
      board = await createPunchboard('Challenges');
      const made = await createLayout('Challenge', spec());
      expect(made.status).toBe(201);
      layoutId = made.body.id;
    });

    it('creates a token whose layout draws its front and a back of its own', async () => {
      const res = await owner.api.post('/api/card-content', {
        component_id: board,
        filename: 'two.png',
        layout_id: layoutId,
        fields: { points: '2' },
      });
      expect(res.status).toBe(201);
      const created = await res.json();
      expect(created.file).toMatchObject({ filename: 'two.png', component_role: 'token' });

      const [token] = await tokensOf(board);
      expect(token!.file_id).toBe(created.file.id);
      expect(token!.back_file).toMatchObject({ filename: 'two (back).png' });
      expect((await contents()).map((c) => c.file_id)).toEqual([created.file.id]);
    });

    it('draws the back again when the content changes', async () => {
      const [token] = await tokensOf(board);
      const before = await versions(token!.back_file_id!);
      // Two figures rather than one: the test font draws every glyph as the
      // same box, so only the length of the copy shows in the picture.
      const res = await owner.api.put(`/api/card-content/${token!.file_id}`, {
        layout_id: layoutId,
        fields: { points: '25' },
      });
      expect(res.status).toBe(200);
      expect(await versions(token!.back_file_id!)).toBe(before + 1);
    });

    it('refuses to change a back its layout draws, or to give it to another token', async () => {
      const [token] = await tokensOf(board);
      const other = (await upload('plain.png', { component_id: board })).body.id;
      const tokens = await tokensOf(board);

      const changed = await putTokens(
        board,
        tokens.map((t) =>
          t.file_id === token!.file_id ? { ...entry(t), back_file_id: null } : entry(t)
        )
      );
      expect(changed.status).toBe(422);
      expect(changed.body.error).toMatch(/back is drawn by its layout/);

      const given = await putTokens(
        board,
        tokens.map((t) =>
          t.file_id === other ? { ...entry(t), back_file_id: token!.back_file_id } : entry(t)
        )
      );
      expect(given.status).toBe(422);
      expect(given.body.error).toMatch(/is the back "two.png"'s layout draws/);

      const uploaded = await upload('a back.png', {
        component_id: board,
        role: 'back',
        back_of: token!.file_id,
      });
      expect(uploaded.status).toBe(422);
    });

    it('will not draw a back a layout draws into another card', async () => {
      const [token] = await tokensOf(board);
      const res = await createLayout('Borrowing', {
        ...spec(null),
        icons: { stolen: token!.back_file_id! },
      });
      expect(res.status).toBe(422);
      expect(res.body.details[0].message).toMatch(/a card drawn from a layout/);
    });

    it('draws the back again in the background when the layout changes', async () => {
      const [token] = await tokensOf(board);
      const before = await versions(token!.back_file_id!);
      const res = await owner.api.put(`/api/layouts/${layoutId}`, {
        name: 'Challenge',
        width_mm: 25,
        height_mm: 25,
        spec: spec([disc('#ffd700'), text({ color: '#000000' })]),
      });
      expect(res.status).toBe(200);
      expect((await contents())[0]!.render_status).toBe('pending');
      await drainRenders();
      expect((await contents())[0]!.render_status).toBe('current');
      expect(await versions(token!.back_file_id!)).toBe(before + 1);
    });

    it('lists the punchboards a layout draws', async () => {
      const res = await owner.api.get(`/api/layouts/${layoutId}`);
      const detail = await res.json();
      expect(detail.decks).toEqual([]);
      expect(detail.punchboards).toEqual([{ id: board, name: 'Challenges', token_count: 1 }]);
    });

    it('refuses a layout of another size, and fails its tokens when the punchboard is resized', async () => {
      const big = await createLayout('Too big', spec(), 30);
      const refused = await owner.api.post('/api/card-content', {
        component_id: board,
        filename: 'big.png',
        layout_id: big.body.id,
        fields: { points: '3' },
      });
      expect(refused.status).toBe(422);
      expect((await refused.json()).error).toBe(
        "Too big is drawn on a 30 × 30 mm card and this punchboard's tokens are 25 × 25 mm"
      );

      const resized = await owner.api.patch(`/api/components/${board}`, {
        settings: {
          ...DEFAULT_PUNCHBOARD_SETTINGS,
          token_width_mm: 30,
          token_height_mm: 30,
          token_corner_radius_mm: 15,
        },
      });
      expect(resized.status).toBe(200);
      await drainRenders();
      const [content] = await contents();
      expect(content!.render_status).toBe('failed');
      expect(content!.render_error).toMatch(/this punchboard's tokens are 30 × 30 mm/);
    });

    it('keeps a back off a deck’s cards', async () => {
      const deck = await owner.api.post('/api/decks', {
        project_id: projectId,
        name: 'Square cards',
        card_width_mm: 25,
        card_height_mm: 25,
      });
      const deckId = (await deck.json()).id;
      const refused = await owner.api.post('/api/card-content', {
        deck_id: deckId,
        filename: 'card.png',
        layout_id: layoutId,
        fields: { points: '1' },
      });
      expect(refused.status).toBe(422);
      expect((await refused.json()).error).toMatch(/a deck's cards share the deck's back/);

      const front = await createLayout('Front only', spec(null));
      const card = await owner.api.post('/api/card-content', {
        deck_id: deckId,
        filename: 'card.png',
        layout_id: front.body.id,
        fields: { points: '1' },
      });
      expect(card.status).toBe(201);
      const gaining = await owner.api.put(`/api/layouts/${front.body.id}`, {
        name: 'Front only',
        width_mm: 25,
        height_mm: 25,
        spec: spec(),
      });
      expect(gaining.status).toBe(422);
      expect((await gaining.json()).error).toMatch(/A deck's card is drawn from this layout/);
    });
  });
});
