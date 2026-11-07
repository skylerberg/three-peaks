import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cardPreset, type LayoutSpec } from '@three-peaks/shared';
import { sql } from 'kysely';
import { db } from '../../src/db/index.ts';
import { down, up } from '../../src/db/migrations/0020_layout_geometry.ts';
import { drainRenders } from '../../src/services/renderWorker.ts';
import { subscribeToBus } from '../../src/services/realtime/bus.ts';
import type { RealtimeEnvelope } from '../../src/services/realtime/payloads.ts';
import { boxFont, solidPng } from '../setup/layoutFixtures.ts';
import { createUser, deleteUser, type TestUser } from '../setup/testContext.ts';

// Real ones, because saving a card draws it: a box font and a solid picture.
const OTF = Buffer.from(boxFont(600));
let PNG: Buffer;

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
          id: null,
          box: { left: 0, top: 0, right: 63, bottom: 88 },
          when: null,
          rotate: 0,
          source: { from: 'file', file_id: frameId },
          fit: 'fill',
          slice: null,
        },
        {
          type: 'image',
          id: null,
          box: { left: 5, top: 5, right: 58, bottom: 45 },
          when: 'art',
          rotate: 0,
          source: { from: 'field', field: 'art' },
          fit: 'cover',
          slice: null,
        },
        {
          type: 'text',
          id: 'rules',
          box: { left: 5, top: 50, right: 58, bottom: 80 },
          when: null,
          rotate: 0,
          text: '**{{name}}**\n{{rules}}',
          font: 'body',
          bold_font: 'body',
          size_pt: 9,
          min_size_pt: 6,
          line_height: 1.2,
          color: '#1a1a1a',
          align: 'left',
          valign: 'top',
          hug: false,
        },
      ],
      ...overrides,
    };
  }

  async function versionCount(fileId: string): Promise<number> {
    const res = await owner.api.get(`/api/files/${fileId}/versions`);
    return ((await res.json()) as { versions: unknown[] }).versions.length;
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
    PNG = Buffer.from(await solidPng('#336699'));
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

    const font = await upload(owner, projectId, 'Body.otf', OTF);
    expect(font.content_type).toBe('font/otf');
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
    const foreignFont = (await upload(stranger, elsewhere, 'Foreign.otf', OTF)).id;
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

    it('refuses edges pinned to each other in a circle', async () => {
      const [, , rules] = spec().elements;
      const res = await createLayout('Circle', {
        spec: spec({
          elements: [
            {
              type: 'rect',
              id: 'plate',
              box: {
                left: 0,
                top: { element: 'rules', edge: 'top', offset_mm: -1 },
                right: 63,
                bottom: 88,
              },
              when: null,
              rotate: 0,
              fill: '#000000',
              stroke: null,
              stroke_mm: 0,
              radius_mm: 0,
              opacity: 1,
            },
            {
              ...rules!,
              box: { ...rules!.box, bottom: { element: 'plate', edge: 'bottom', offset_mm: 0 } },
            },
          ],
        }),
      });
      expect(res.status).toBe(422);
      const messages = res.body.details.map((d: { message: string }) => d.message);
      expect(messages).toEqual([
        'elements are pinned to each other in a circle: plate → rules → plate',
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
        'icon "coin" is Body.otf, which is not a PNG, JPEG or SVG image',
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

    it('rewrites a layout stored before pinned edges into the new form, and back', async () => {
      const { body } = await createLayout('Legacy');
      const stored = async () =>
        (
          await sql<{
            spec: LayoutSpec;
          }>`select spec from card_layout where id = ${body.id}`.execute(db)
        ).rows[0]!.spec;
      const current = await stored();

      await down(db as never);
      const old = (await stored()).elements as unknown as Record<string, unknown>[];
      expect(old[0]).toEqual({
        type: 'image',
        box: [0, 0, 63, 88],
        when: null,
        source: { from: 'file', file_id: frameId },
        fit: 'fill',
      });
      // An id is one of the new settings, so the copy that has one stays new.
      expect(old[2]!.box).toEqual({ left: 5, top: 50, right: 58, bottom: 80 });

      await up(db as never);
      const again = await stored();
      expect(again.elements.slice(0, 2)).toEqual(current.elements.slice(0, 2));
      expect(again.elements[2]).toEqual(current.elements[2]);
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

    it("saves a card's values, drawing it, and upserts on a second save", async () => {
      const first = await put(cardId, { layout_id: layoutId, fields });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({
        content: { file_id: cardId, layout_id: layoutId, fields, render_status: 'current' },
        image_version: 2,
      });

      const second = await put(cardId, { layout_id: layoutId, fields: { ...fields, art: artId } });
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({
        content: { fields: { art: artId } },
        image_version: 3,
      });

      // The same values draw the same picture, and that writes nothing.
      const again = await put(cardId, { layout_id: layoutId, fields: { ...fields, art: artId } });
      expect((await again.json()).image_version).toBeNull();
      expect(await versionCount(cardId)).toBe(3);

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
        'art is Body.otf, which is not a PNG, JPEG or SVG image'
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

  describe('drawing', () => {
    let layoutId: string;
    let drawnDeck: string;
    let cardFile: string;
    const fields = { name: 'Squire', rules: 'Gain {coin}.', art: '' };

    async function statusOf(fileId: string) {
      const list = await (await owner.api.get(`/api/card-content?deck_id=${drawnDeck}`)).json();
      const card = (
        list.cards as { file_id: string; render_status: string; render_error: string | null }[]
      ).find((entry) => entry.file_id === fileId);
      return { status: card?.render_status, error: card?.render_error };
    }

    const layoutBody = (overrides: Partial<LayoutSpec> = {}, name = 'Drawn') => ({
      name,
      width_mm: poker.width_mm,
      height_mm: poker.height_mm,
      spec: spec(overrides),
    });

    beforeAll(async () => {
      layoutId = (await createLayout('Drawn')).body.id;
      drawnDeck = (
        await (
          await owner.api.post('/api/decks', {
            project_id: projectId,
            name: 'Drawn',
            card_width_mm: poker.width_mm,
            card_height_mm: poker.height_mm,
          })
        ).json()
      ).id;
    });

    it('creates a card in the deck from its content alone', async () => {
      const res = await owner.api.post('/api/card-content', {
        deck_id: drawnDeck,
        filename: 'squire.png',
        layout_id: layoutId,
        fields,
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      cardFile = body.file.id;
      expect(body.file).toMatchObject({
        filename: 'squire.png',
        deck_id: drawnDeck,
        content_type: 'image/png',
      });
      expect(body.content).toMatchObject({ layout_id: layoutId, fields, render_status: 'current' });
      expect(await versionCount(cardFile)).toBe(1);

      const deck = await (await owner.api.get(`/api/decks/${drawnDeck}`)).json();
      expect(deck.cards.map((card: { file_id: string }) => card.file_id)).toEqual([cardFile]);

      const taken = await owner.api.post('/api/card-content', {
        deck_id: drawnDeck,
        filename: 'squire.png',
        layout_id: layoutId,
        fields,
      });
      expect(taken.status).toBe(409);
      expect(
        (
          await owner.api.post('/api/card-content', {
            deck_id: drawnDeck,
            filename: 'x.png',
            layout_id: layoutId,
            fields,
          })
        ).status
      ).toBe(201);
    });

    it('refuses copy that cannot be set, and changes nothing', async () => {
      const res = await owner.api.put(`/api/card-content/${cardFile}`, {
        layout_id: layoutId,
        fields: { ...fields, rules: 'word '.repeat(600) },
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/^element 3 \(text\)/);
      expect(await versionCount(cardFile)).toBe(1);
      const list = await (await owner.api.get(`/api/card-content?deck_id=${drawnDeck}`)).json();
      expect(
        list.cards.find((card: { file_id: string }) => card.file_id === cardFile).fields
      ).toEqual(fields);
    });

    it('draws the cards again in the background when their layout changes', async () => {
      const renamed = await owner.api.put(
        `/api/layouts/${layoutId}`,
        layoutBody({}, 'Drawn again')
      );
      expect(renamed.status).toBe(200);
      expect((await statusOf(cardFile)).status).toBe('current');

      const changed = await owner.api.put(`/api/layouts/${layoutId}`, layoutBody({ dpi: 200 }));
      expect(changed.status).toBe(200);
      expect((await statusOf(cardFile)).status).toBe('pending');

      expect(await drainRenders()).toBeGreaterThanOrEqual(1);
      expect(await statusOf(cardFile)).toEqual({ status: 'current', error: null });
      expect(await versionCount(cardFile)).toBe(2);
    });

    it('draws the cards again when a file they draw gets a version', async () => {
      const res = await owner.api.postBytes(
        `/api/files/${frameId}/versions`,
        Buffer.from(await solidPng('#aa3311')) as unknown as BodyInit
      );
      expect(res.status).toBe(201);
      expect((await statusOf(cardFile)).status).toBe('pending');
      await drainRenders();
      expect((await statusOf(cardFile)).status).toBe('current');
      expect(await versionCount(cardFile)).toBe(3);
    });

    it('says why a card can no longer be drawn, until its content is fixed', async () => {
      await owner.api.put(`/api/card-content/${cardFile}`, {
        layout_id: layoutId,
        fields: { ...fields, rules: 'word '.repeat(60) },
      });
      const smaller = layoutBody({ dpi: 200 });
      const rules = smaller.spec.elements[2] as { size_pt: number; min_size_pt: number };
      rules.size_pt = 30;
      rules.min_size_pt = 30;
      await owner.api.put(`/api/layouts/${layoutId}`, smaller);
      await drainRenders();
      const failed = await statusOf(cardFile);
      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/^element 3 \(text\)/);

      const fixed = await owner.api.put(`/api/card-content/${cardFile}`, {
        layout_id: layoutId,
        fields: { ...fields, rules: 'Short.' },
      });
      expect(fixed.status).toBe(200);
      // Saved and drawn; the request the layout made is still worked through,
      // since a save cannot know it saw every change that made it.
      expect((await statusOf(cardFile)).error).toBeNull();
      await drainRenders();
      expect(await statusOf(cardFile)).toEqual({ status: 'current', error: null });
    });

    it('draws every card of a deck again when asked', async () => {
      expect(
        (await viewer.api.post('/api/card-content/render', { deck_id: drawnDeck })).status
      ).toBe(403);
      const res = await owner.api.post('/api/card-content/render', {
        deck_id: drawnDeck,
        file_ids: [cardFile],
      });
      expect(await res.json()).toEqual({ requested: 1 });
      expect((await statusOf(cardFile)).status).toBe('pending');
      await drainRenders();
      expect((await statusOf(cardFile)).status).toBe('current');
    });

    it('asks for a card again when it is restored', async () => {
      await owner.api.delete(`/api/files/${cardFile}`);
      await owner.api.post(`/api/files/${cardFile}/restore`, {});
      expect((await statusOf(cardFile)).status).toBe('pending');
      await drainRenders();
      expect((await statusOf(cardFile)).status).toBe('current');
    });

    it('will not draw a laid-out card into another, either way round', async () => {
      const layout = await createLayout('Draws a card', {
        spec: spec({ icons: { coin: cardFile } }),
      });
      expect(layout.status).toBe(422);
      expect(layout.body.details.map((d: { message: string }) => d.message)).toContain(
        'icon "coin" is squire.png, a card drawn from a layout, which cannot be drawn into another'
      );

      const drawsArt = await owner.api.put(`/api/card-content/${cardId}`, {
        layout_id: layoutId,
        fields: { ...fields, art: artId },
      });
      expect(drawsArt.status).toBe(200);
      const artAsCard = await owner.api.put(`/api/card-content/${artId}`, {
        layout_id: layoutId,
        fields,
      });
      expect(artAsCard.status).toBe(422);
    });

    it('announces each card as its content or its picture changes', async () => {
      const heard: RealtimeEnvelope[] = [];
      const stop = subscribeToBus((entry) => heard.push(entry));
      try {
        const card = await owner.api.post('/api/card-content', {
          deck_id: drawnDeck,
          filename: 'herald.png',
          layout_id: layoutId,
          fields,
        });
        const fileId = (await card.json()).file.id;
        const statuses = () =>
          heard.flatMap((entry) =>
            entry.type === 'card_content_updated'
              ? (entry.data as { contents: { file_id: string; render_status: string }[] }).contents
                  .filter((content) => content.file_id === fileId)
                  .map((content) => content.render_status)
              : []
          );
        expect(statuses()).toEqual(['current']);

        await owner.api.put(`/api/layouts/${layoutId}`, layoutBody({ dpi: 210 }));
        expect(statuses()).toEqual(['current', 'pending']);
        await drainRenders();
        expect(statuses()).toEqual(['current', 'pending', 'current']);

        expect((await owner.api.delete(`/api/card-content/${fileId}`)).status).toBe(204);
        expect(heard.at(-1)).toMatchObject({
          type: 'card_content_deleted',
          project_id: projectId,
          data: { file_id: fileId },
        });
      } finally {
        stop();
      }
    });

    it('previews a card without saving anything', async () => {
      const res = await viewer.api.post('/api/layouts/preview', {
        project_id: projectId,
        width_mm: poker.width_mm,
        height_mm: poker.height_mm,
        spec: spec({ dpi: 100 }),
        fields,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      const png = new Uint8Array(await res.arrayBuffer());
      expect([...png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);

      const bad = await viewer.api.post('/api/layouts/preview', {
        project_id: projectId,
        width_mm: poker.width_mm,
        height_mm: poker.height_mm,
        spec: spec({ dpi: 100 }),
        fields: { ...fields, rules: 'word '.repeat(600) },
      });
      expect(bad.status).toBe(422);
      expect(
        (
          await stranger.api.post('/api/layouts/preview', {
            project_id: projectId,
            width_mm: poker.width_mm,
            height_mm: poker.height_mm,
            spec: spec(),
            fields,
          })
        ).status
      ).toBe(404);
    });
  });

  // The layout a card names refuses its own delete, so a project delete --
  // which reaches both through cascades -- must not trip over it part way.
  it('deletes a project holding layouts in use', async () => {
    const doomed = (await (await owner.api.post('/api/projects', { name: 'Doomed' })).json()).id;
    const font = (await upload(owner, doomed, 'Body.otf', OTF)).id;
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
