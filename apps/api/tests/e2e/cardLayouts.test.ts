import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cardPreset, type LayoutSpec } from '@three-peaks/shared';
import { createUser, deleteUser, type TestUser } from '../setup/testContext.ts';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
// The API never parses a font, only sniffs one: an sfnt header is all it reads.
const TTF = Buffer.from([
  0x00, 0x01, 0x00, 0x00, 0x00, 0x0c, 0, 0x80, 0, 0x03, 0, 0x20, 0, 0, 0, 0,
]);

const poker = cardPreset('poker')!;
const tarot = cardPreset('tarot')!;

describe('card layouts and card content', () => {
  let owner: TestUser;
  let viewer: TestUser;
  let stranger: TestUser;
  let projectId: string;
  let deckId: string;
  let cardId: string;
  let fontId: string;
  let iconId: string;
  let frameId: string;
  let artId: string;
  let assetCardId: string;
  let foreignImageId: string;
  let foreignLayoutId: string;

  async function upload(
    user: TestUser,
    project: string,
    filename: string,
    bytes: Buffer = PNG,
    into: Record<string, string> = {}
  ) {
    const query = new URLSearchParams({ project_id: project, filename, ...into });
    const res = await user.api.postBytes(
      `/api/files/upload?${query}`,
      bytes as unknown as BodyInit
    );
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; content_type: string };
  }

  function spec(overrides: Partial<LayoutSpec> = {}): LayoutSpec {
    return {
      dpi: 300,
      fonts: { body: fontId },
      icons: { coin: iconId },
      fields: { name: { type: 'text' }, rules: { type: 'text' }, art: { type: 'image' } },
      elements: [
        {
          type: 'image',
          box: [0, 0, 63, 88],
          when: null,
          source: { from: 'file', file_id: frameId },
          fit: 'fill',
        },
        {
          type: 'image',
          box: [5, 5, 53, 40],
          when: 'art',
          source: { from: 'field', field: 'art' },
          fit: 'cover',
        },
        {
          type: 'text',
          box: [5, 50, 53, 30],
          when: null,
          text: '**{{name}}**\n{{rules}}',
          font: 'body',
          bold_font: null,
          size_pt: 9,
          min_size_pt: 6,
          line_height: 1.2,
          color: '#1a1a1a',
          align: 'left',
          valign: 'top',
        },
      ],
      ...overrides,
    };
  }

  async function createLayout(name: string, extra: Record<string, unknown> = {}, user = owner) {
    const res = await user.api.post('/api/layouts', {
      project_id: projectId,
      name,
      width_mm: poker.width_mm,
      height_mm: poker.height_mm,
      spec: spec(),
      ...extra,
    });
    return { status: res.status, body: await res.json() };
  }

  beforeAll(async () => {
    [owner, viewer, stranger] = await Promise.all([
      createUser('layout-owner'),
      createUser('layout-viewer'),
      createUser('layout-stranger'),
    ]);
    projectId = (await (await owner.api.post('/api/projects', { name: 'Layouts' })).json()).id;
    await owner.api.put(`/api/projects/${projectId}/members`, {
      email: viewer.email,
      role: 'viewer',
    });

    const font = await upload(owner, projectId, 'Body.ttf', TTF);
    expect(font.content_type).toBe('font/ttf');
    fontId = font.id;
    iconId = (await upload(owner, projectId, 'coin.png')).id;
    frameId = (await upload(owner, projectId, 'frame.png')).id;
    artId = (await upload(owner, projectId, 'knight-art.png')).id;
    assetCardId = (await upload(owner, projectId, 'loose.png')).id;

    deckId = (
      await (
        await owner.api.post('/api/decks', {
          project_id: projectId,
          name: 'Heroes',
          card_width_mm: poker.width_mm,
          card_height_mm: poker.height_mm,
        })
      ).json()
    ).id;
    cardId = (await upload(owner, projectId, 'knight.png', PNG, { deck_id: deckId })).id;

    const elsewhere = (
      await (await stranger.api.post('/api/projects', { name: 'Elsewhere' })).json()
    ).id;
    foreignImageId = (await upload(stranger, elsewhere, 'foreign.png')).id;
    const foreignFont = (await upload(stranger, elsewhere, 'Foreign.ttf', TTF)).id;
    foreignLayoutId = (
      await (
        await stranger.api.post('/api/layouts', {
          project_id: elsewhere,
          name: 'Theirs',
          width_mm: poker.width_mm,
          height_mm: poker.height_mm,
          spec: { dpi: 300, fonts: { body: foreignFont }, icons: {}, fields: {}, elements: [] },
        })
      ).json()
    ).id;
  });

  afterAll(async () => {
    for (const user of [owner, viewer, stranger]) await deleteUser(user);
  });

  describe('layouts', () => {
    it('creates one and lists it', async () => {
      const created = await createLayout('Hero');
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        project_id: projectId,
        name: 'Hero',
        width_mm: 63,
        height_mm: 88,
        created_by: owner.id,
      });
      expect(created.body.spec).toEqual(spec());

      const list = await (await viewer.api.get(`/api/layouts?project_id=${projectId}`)).json();
      expect(list.layouts.map((layout: { name: string }) => layout.name)).toContain('Hero');
    });

    it('refuses a name already taken, whatever its case', async () => {
      expect((await createLayout('HERO')).status).toBe(409);
    });

    it('is 403 to a viewer and 404 to a stranger', async () => {
      expect((await createLayout('Viewer', {}, viewer)).status).toBe(403);
      const { body } = await createLayout('Seen');
      expect((await stranger.api.get(`/api/layouts/${body.id}`)).status).toBe(404);
      expect((await viewer.api.get(`/api/layouts/${body.id}`)).status).toBe(200);
      expect(
        (
          await viewer.api.put(`/api/layouts/${body.id}`, {
            name: 'x',
            width_mm: 63,
            height_mm: 88,
            spec: spec(),
          })
        ).status
      ).toBe(403);
      expect((await viewer.api.delete(`/api/layouts/${body.id}`)).status).toBe(403);
      expect((await stranger.api.get(`/api/layouts?project_id=${projectId}`)).status).toBe(404);
    });

    it('refuses references that resolve to nothing, with each named', async () => {
      const res = await createLayout('Dangling', {
        spec: spec({
          elements: [{ ...spec().elements[2]!, text: '{{cost}}', font: 'title' } as never],
        }),
      });
      expect(res.status).toBe(422);
      const messages = res.body.details.map((d: { message: string }) => d.message);
      expect(messages).toEqual([
        'element 1 (text): {{cost}} is not a field',
        'element 1 (text): font "title" is not one of this layout\'s fonts',
      ]);
    });

    it('refuses a font that is not a font and an icon that is not an image', async () => {
      const res = await createLayout('Swapped', {
        spec: spec({ fonts: { body: iconId }, icons: { coin: fontId } }),
      });
      expect(res.status).toBe(422);
      const messages = res.body.details.map((d: { message: string }) => d.message);
      expect(messages).toEqual([
        'font "body" is coin.png, which is not a TTF, OTF or WOFF font',
        'icon "coin" is Body.ttf, which is not a PNG, JPEG or SVG image',
      ]);
    });

    it("refuses another project's file as if it did not exist", async () => {
      const res = await createLayout('Foreign', {
        spec: spec({ icons: { coin: foreignImageId } }),
      });
      expect(res.status).toBe(422);
      expect(res.body.details[0].message).toBe(
        `icon "coin" must be a file in the same project (${foreignImageId})`
      );
    });

    it('refuses a new reference to a deleted file', async () => {
      const doomed = (await upload(owner, projectId, 'doomed.png')).id;
      await owner.api.delete(`/api/files/${doomed}`);
      const res = await createLayout('Doomed', { spec: spec({ icons: { coin: doomed } }) });
      expect(res.status).toBe(422);
      expect(res.body.details[0].message).toBe('icon "coin" is doomed.png, which is deleted');
    });

    it('replaces a layout whole', async () => {
      const { body } = await createLayout('Replaced');
      const next = spec({ dpi: 600 });
      const res = await owner.api.put(`/api/layouts/${body.id}`, {
        name: 'Replaced again',
        width_mm: tarot.width_mm,
        height_mm: tarot.height_mm,
        spec: next,
      });
      expect(res.status).toBe(200);
      const saved = await res.json();
      expect(saved).toMatchObject({ name: 'Replaced again', width_mm: 70, height_mm: 120 });
      expect(saved.spec.dpi).toBe(600);
    });
  });

  describe('card content', () => {
    let layoutId: string;
    const fields = { name: 'Knight', rules: 'Gain 2 {coin}.', art: '' };

    beforeAll(async () => {
      layoutId = (await createLayout('Card content')).body.id;
    });

    const put = (fileId: string, body: unknown, user = owner) =>
      user.api.put(`/api/card-content/${fileId}`, body);

    it("saves a card's values, upserting on a second save", async () => {
      const first = await put(cardId, { layout_id: layoutId, fields });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ file_id: cardId, layout_id: layoutId, fields });

      const second = await put(cardId, { layout_id: layoutId, fields: { ...fields, art: artId } });
      expect(second.status).toBe(200);
      expect((await second.json()).fields.art).toBe(artId);

      const list = await (await viewer.api.get(`/api/card-content?deck_id=${deckId}`)).json();
      expect(list.cards).toHaveLength(1);
      expect(list.cards[0].fields).toEqual({ ...fields, art: artId });
    });

    it('names the decks drawn from the layout, with how many cards', async () => {
      const detail = await (await owner.api.get(`/api/layouts/${layoutId}`)).json();
      expect(detail.decks).toEqual([{ id: deckId, name: 'Heroes', card_count: 1 }]);
    });

    it('refuses an unknown field and copy naming an unknown icon', async () => {
      const res = await put(cardId, { layout_id: layoutId, fields: { rules: '{gem}', cost: '3' } });
      expect(res.status).toBe(422);
      expect((await res.json()).details.map((d: { message: string }) => d.message)).toEqual([
        "rules: {gem} is not one of this layout's icons",
        '"cost" is not a field of this layout',
      ]);
    });

    // A malformed id reaching the query would be a uuid cast Postgres refuses,
    // and that surfaces as a 500 rather than as the caller's mistake.
    it('refuses an image field that is not a file id, without a 500', async () => {
      const res = await put(cardId, { layout_id: layoutId, fields: { art: 'Art/knight.png' } });
      expect(res.status).toBe(422);
      expect((await res.json()).details[0].message).toBe(
        'art must be a file id, not "Art/knight.png"'
      );
    });

    it("refuses another project's image, and a file that is no picture", async () => {
      const foreign = await put(cardId, { layout_id: layoutId, fields: { art: foreignImageId } });
      expect(foreign.status).toBe(422);
      const font = await put(cardId, { layout_id: layoutId, fields: { art: fontId } });
      expect((await font.json()).details[0].message).toBe(
        'art is Body.ttf, which is not a PNG, JPEG or SVG image'
      );
    });

    it("refuses a file that is not a deck's card", async () => {
      const res = await put(assetCardId, { layout_id: layoutId, fields });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe("Only a deck's card can be drawn from a layout");
    });

    it("refuses another project's layout as if it did not exist", async () => {
      const res = await put(cardId, { layout_id: foreignLayoutId, fields: {} });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe('The layout must be one in the same project');
    });

    it('refuses a layout drawn on a card of another size', async () => {
      const big = (
        await createLayout('Big', { width_mm: tarot.width_mm, height_mm: tarot.height_mm })
      ).body.id;
      const res = await put(cardId, { layout_id: big, fields: {} });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toBe(
        "Big is drawn on a 70 × 120 mm card and this deck's cards are 63 × 88 mm"
      );
    });

    it('is 403 to a viewer and 404 to a stranger', async () => {
      expect((await put(cardId, { layout_id: layoutId, fields }, viewer)).status).toBe(403);
      expect((await put(cardId, { layout_id: layoutId, fields }, stranger)).status).toBe(404);
      expect((await stranger.api.get(`/api/card-content?deck_id=${deckId}`)).status).toBe(404);
      expect((await viewer.api.delete(`/api/card-content/${cardId}`)).status).toBe(403);
    });

    it('refuses to delete a layout a card is drawn from, deleted cards included', async () => {
      await owner.api.delete(`/api/files/${cardId}`);
      const detail = await (await owner.api.get(`/api/layouts/${layoutId}`)).json();
      expect(detail.decks).toEqual([]);

      const res = await owner.api.delete(`/api/layouts/${layoutId}`);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain('A card is drawn from this layout');
      await owner.api.post(`/api/files/${cardId}/restore`, {});
    });

    it('deletes the layout once its cards have let go of it', async () => {
      const removed = await owner.api.delete(`/api/card-content/${cardId}`);
      expect(removed.status).toBe(204);
      expect((await owner.api.delete(`/api/card-content/${cardId}`)).status).toBe(404);
      expect((await owner.api.delete(`/api/layouts/${layoutId}`)).status).toBe(204);
      expect((await owner.api.get(`/api/layouts/${layoutId}`)).status).toBe(404);
    });
  });

  // The layout a card names refuses its own delete, so a project delete --
  // which reaches both through cascades -- must not trip over it part way.
  it('deletes a project holding layouts in use', async () => {
    const doomed = (await (await owner.api.post('/api/projects', { name: 'Doomed' })).json()).id;
    const font = (await upload(owner, doomed, 'Body.ttf', TTF)).id;
    const deck = (
      await (
        await owner.api.post('/api/decks', {
          project_id: doomed,
          name: 'Gone',
          card_width_mm: poker.width_mm,
          card_height_mm: poker.height_mm,
        })
      ).json()
    ).id;
    const card = (await upload(owner, doomed, 'gone.png', PNG, { deck_id: deck })).id;
    const layout = (
      await (
        await owner.api.post('/api/layouts', {
          project_id: doomed,
          name: 'Gone',
          width_mm: poker.width_mm,
          height_mm: poker.height_mm,
          spec: { dpi: 300, fonts: { body: font }, icons: {}, fields: {}, elements: [] },
        })
      ).json()
    ).id;
    expect(
      (await owner.api.put(`/api/card-content/${card}`, { layout_id: layout, fields: {} })).status
    ).toBe(200);

    const res = await owner.api.delete(`/api/projects/${doomed}`);
    expect(res.status).toBeLessThan(300);
    expect((await owner.api.get(`/api/layouts/${layout}`)).status).toBe(404);
  });
});
