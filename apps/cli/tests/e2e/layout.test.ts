import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { components } from '@three-peaks/shared/api';
import { deleteUser, type TestUser } from '../../../api/tests/setup/testContext.ts';
import { boxFont, solidPng, solidSvg } from '../../../api/tests/setup/layoutFixtures.ts';
import { startRenderWorker } from '../../../api/src/services/renderWorker.ts';
import { signedInHarness, type CliHarness } from './helpers.ts';

type DeckWithCards = components['schemas']['DeckWithCards'];
type FileVersionList = components['schemas']['FileVersionList'];

const HERO = `name: Hero
size: poker
dpi: 100
fonts:
  body: Fonts/Body.otf
icons:
  coin: Icons/coin.svg
fields:
  name: text
  rules: text
  art: image
elements:
  - type: image
    box: [0, 0, 63, 88]
    file: Frames/frame.png
    fit: fill
  - type: image
    box: [5, 5, 53, 40]
    field: art
    when: art
  - type: text
    box: [5, 50, 53, 30]
    text: "{{name}}\\n{{rules}}"
    font: body
    size_pt: 9
    min_size_pt: 6
`;

// A token printed both sides: a disc with its points on the front, and the
// points again on a gold back.
const CHALLENGE = `name: Challenge
width_mm: 25
height_mm: 25
dpi: 100
fonts:
  body: Fonts/Body.otf
fields:
  points: text
elements:
  - type: rect
    box: [0, 0, 25, 25]
    fill: "#000000"
    radius_mm: 12.5
  - type: text
    box: [2, 8, 21, 9]
    text: "{{points}}"
    font: body
    size_pt: 12
    color: "#ffffff"
    align: center
    valign: middle
back:
  - type: rect
    box: [0, 0, 25, 25]
    fill: "#c9a227"
    radius_mm: 12.5
  - type: text
    box: [2, 8, 21, 9]
    text: "{{points}}"
    font: body
    size_pt: 12
    align: center
    valign: middle
`;

const TOKENS = `layout: Challenge
tokens:
  - name: two
    fields:
      points: "2"
  - name: three
    copies: 2
    fields:
      points: "3"
`;

function cardsFile(archerRules: string, extra = ''): string {
  return `layout: Hero
cards:
  - name: knight
    copies: 3
    fields:
      name: Knight
      rules: "Gain 2 {coin}."
      art: Art/knight.png
  - name: archer
    fields:
      name: Archer
      rules: "${archerRules}"
${extra}`;
}

describe('layout and laid-out card commands', () => {
  let h: CliHarness;
  let owner: TestUser;
  let projectId: string;
  let dir: string;
  // The API draws laid-out cards in the background, as a server would.
  let stopRenders: () => Promise<void>;

  function cli(args: string[]) {
    return h.runCli([...args, '--project', projectId]);
  }

  async function write(name: string, contents: string | Uint8Array): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, contents);
    return path;
  }

  async function deck(): Promise<DeckWithCards> {
    const res = await cli(['deck', 'show', 'Heroes', '--json']);
    expect(res.exitCode).toBe(0);
    return res.json<DeckWithCards>();
  }

  async function versions(filename: string): Promise<number> {
    const card = (await deck()).cards.find((c) => c.file.filename === filename)!;
    const list = await (await owner.api.get(`/api/files/${card.file_id}/versions`)).json();
    return (list as FileVersionList).versions.length;
  }

  beforeAll(async () => {
    stopRenders = startRenderWorker();
    ({ h, user: owner } = await signedInHarness('cli-layout'));
    projectId = (await (await owner.api.post('/api/projects', { name: 'Layouts' })).json()).id;
    dir = join(h.workDir, 'layout');
    await mkdir(dir, { recursive: true });

    const uploads: [string, string, Uint8Array][] = [
      ['Fonts', 'Body.otf', boxFont(500)],
      ['Icons', 'coin.svg', solidSvg('#00ff00')],
      ['Frames', 'frame.png', await solidPng('#ff0000')],
      ['Art', 'knight.png', await solidPng('#0000ff')],
    ];
    for (const [folder, name, bytes] of uploads) {
      expect((await cli(['mkdir', '-p', folder])).exitCode).toBe(0);
      const res = await cli(['upload', await write(name, bytes), '--to', folder]);
      expect(res.stderr).toBe('');
    }
    expect((await cli(['deck', 'create', 'Heroes'])).exitCode).toBe(0);
  });

  afterAll(async () => {
    await stopRenders();
    await deleteUser(owner);
  });

  it('pushes a layout, naming its files by Assets path', async () => {
    const res = await cli(['layout', 'push', await write('hero.yaml', HERO)]);
    expect(res.stderr).toBe('');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/^Created layout Hero/);
    const list = await cli(['layout', 'list']);
    expect(list.stdout).toContain('poker (63 × 88 mm)');
  });

  it('pulls a layout back as the YAML it was pushed from, defaults left out', async () => {
    const res = await cli(['layout', 'pull', 'Hero']);
    expect(res.exitCode).toBe(0);
    expect(parse(res.stdout)).toEqual(parse(HERO));
  });

  it('creates every card in a cards file, with its copies', async () => {
    const res = await cli([
      'deck',
      'cards',
      'push',
      'Heroes',
      await write('cards.yaml', cardsFile('Draw a card.')),
    ]);
    expect(res.stderr).toBe('');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Created knight.png');
    expect(res.stdout).toContain('Created archer.png');
    const { cards } = await deck();
    expect(cards.map((c) => [c.file.filename, c.quantity])).toEqual([
      ['knight.png', 3],
      ['archer.png', 1],
    ]);
    expect(cards.every((c) => c.file.content_type === 'image/png')).toBe(true);
  });

  it('changes nothing when the file has not changed', async () => {
    const res = await cli(['deck', 'cards', 'push', 'Heroes', join(dir, 'cards.yaml')]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Unchanged knight.png');
    expect(res.stdout).toContain('Unchanged archer.png');
    expect(await versions('knight.png')).toBe(1);
    expect(await versions('archer.png')).toBe(1);
  });

  it('gives exactly the card whose rules changed a new version', async () => {
    const path = await write('cards.yaml', cardsFile('Draw two cards, then discard one.'));
    const res = await cli(['deck', 'cards', 'push', 'Heroes', path]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Updated archer.png to version 2 (content)');
    expect(res.stdout).toContain('Unchanged knight.png');
    expect(await versions('archer.png')).toBe(2);
    expect(await versions('knight.png')).toBe(1);
  });

  it('pulls the cards back as a file that pushes as no change', async () => {
    const res = await cli(['deck', 'cards', 'pull', 'Heroes']);
    expect(res.exitCode).toBe(0);
    const pulled = parse(res.stdout);
    expect(pulled.layout).toBe('Hero');
    expect(pulled.cards[0]).toEqual({
      name: 'knight',
      copies: 3,
      fields: { name: 'Knight', rules: 'Gain 2 {coin}.', art: 'Art/knight.png' },
    });
    const again = await cli([
      'deck',
      'cards',
      'push',
      'Heroes',
      await write('pulled.yaml', res.stdout),
    ]);
    expect(again.stdout).not.toMatch(/Updated|Created/);
  });

  it('says which cards a new version of their art is waiting on, and waits for them', async () => {
    // Held, so the card is still waiting when the check looks.
    await stopRenders();
    const green = await write('green.png', await solidPng('#00ff00'));
    expect((await cli(['file', 'push', 'Art/knight.png', green])).exitCode).toBe(0);

    const check = await cli(['deck', 'render', 'Heroes', '--check']);
    expect(check.exitCode).toBe(5);
    expect(check.stdout).toContain('Waiting: knight.png');
    expect(check.stdout).toContain('Unchanged archer.png');
    expect(await versions('knight.png')).toBe(1);

    stopRenders = startRenderWorker();
    const render = await cli(['deck', 'render', 'Heroes']);
    expect(render.exitCode).toBe(0);
    expect(render.stdout).toContain('Updated knight.png');
    expect(render.stdout).toContain('Unchanged archer.png');
    expect(await versions('knight.png')).toBe(2);
    expect((await cli(['deck', 'render', 'Heroes', '--check'])).exitCode).toBe(0);
  });

  it('waits for every card drawn from a layout to be drawn again when the layout changes', async () => {
    const res = await cli([
      'layout',
      'push',
      await write('hero.yaml', HERO.replace('dpi: 100', 'dpi: 120')),
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Updated layout Hero');
    expect(res.stdout).toContain('Heroes: 2 cards');
    expect(await versions('knight.png')).toBe(3);
    expect(await versions('archer.png')).toBe(3);
  });

  it('says what a dry run would do and does none of it', async () => {
    const path = await write(
      'more.yaml',
      cardsFile('Draw two cards, then discard one.', '  - name: mage\n    fields: { name: Mage }\n')
    );
    const res = await cli(['deck', 'cards', 'push', 'Heroes', path, '--dry-run']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Would create mage.png');
    expect((await deck()).cards).toHaveLength(2);
  });

  it('refuses copy naming an unknown icon before anything is sent', async () => {
    const path = await write('bad.yaml', cardsFile('Gain a {gem}.'));
    const res = await cli(['deck', 'cards', 'push', 'Heroes', path]);
    expect(res.exitCode).toBe(6);
    expect(res.stderr).toContain("archer: rules: {gem} is not one of this layout's icons");
    expect(await versions('archer.png')).toBe(3);
  });

  it('passes over a card whose copy does not fit, and pushes the rest', async () => {
    const long = Array.from({ length: 300 }, () => 'word').join(' ');
    const path = await write(
      'long.yaml',
      cardsFile(
        'Draw two cards, then discard one.',
        `  - name: sage\n    fields: { name: Sage, rules: "${long}" }\n  - name: monk\n    fields: { name: Monk }\n`
      )
    );
    const res = await cli(['deck', 'cards', 'push', 'Heroes', path]);
    expect(res.exitCode).toBe(6);
    expect(res.stderr).toMatch(/sage\.png: element 3 \(text\) does not fit even at 6 pt/);
    expect(res.stdout).toContain('Created monk.png');
    expect((await deck()).cards.map((c) => c.file.filename)).not.toContain('sage.png');
  });

  it('previews a layout file without changing anything', async () => {
    const out = join(dir, 'preview');
    const res = await cli([
      'layout',
      'preview',
      join(dir, 'hero.yaml'),
      join(dir, 'cards.yaml'),
      '-o',
      out,
    ]);
    expect(res.exitCode).toBe(0);
    expect((await readdir(out)).sort()).toEqual(['archer.png', 'knight.png']);
    const png = await readFile(join(out, 'knight.png'));
    // 63 mm at the layout's 120 dpi.
    expect(png.readUInt32BE(16)).toBe(298);
    expect(await versions('knight.png')).toBe(3);
  });

  describe('tokens drawn from a layout with a back', () => {
    type Component = components['schemas']['Component'];

    async function board(): Promise<Component> {
      const res = await cli(['component', 'show', 'Challenges', '--json']);
      expect(res.exitCode).toBe(0);
      return res.json<Component>();
    }

    beforeAll(async () => {
      const made = await cli([
        'component',
        'create',
        'Challenges',
        '--kind',
        'punchboard',
        '--set',
        'token_width_mm=25',
        '--set',
        'token_height_mm=25',
      ]);
      expect(made.stderr).toBe('');
    });

    it('pushes a layout with a back, and pulls it back as written', async () => {
      const pushed = await cli(['layout', 'push', await write('challenge.yaml', CHALLENGE)]);
      expect(pushed.stderr).toBe('');
      const pulled = await cli(['layout', 'pull', 'Challenge']);
      expect(parse(pulled.stdout)).toEqual(parse(CHALLENGE));
      const shown = await cli(['layout', 'show', 'Challenge']);
      expect(shown.stdout).toContain('Elements: 2 on the front, 2 on the back');
    });

    it('creates every token in a tokens file, each with a back drawn for it', async () => {
      const res = await cli([
        'component',
        'tokens',
        'push',
        'Challenges',
        await write('tokens.yaml', TOKENS),
      ]);
      expect(res.stderr).toBe('');
      expect(res.stdout).toContain('Created two.png');
      const { tokens } = await board();
      expect(tokens.map((t) => [t.file.filename, t.back_file?.filename, t.quantity])).toEqual([
        ['two.png', 'two (back).png', 1],
        ['three.png', 'three (back).png', 2],
      ]);
    });

    it('pulls the tokens back under `tokens`, as a file that pushes as no change', async () => {
      const pulled = await cli(['component', 'tokens', 'pull', 'Challenges']);
      expect(parse(pulled.stdout)).toEqual(
        parse(TOKENS.replace('  - name: two\n', '  - name: two\n    copies: 1\n'))
      );
      const again = await cli([
        'component',
        'tokens',
        'push',
        'Challenges',
        await write('pulled-tokens.yaml', pulled.stdout),
      ]);
      expect(again.stdout).toContain('Unchanged two.png');
      expect(again.stdout).toContain('Unchanged three.png');
    });

    it('previews both faces of the stored tokens without changing anything', async () => {
      const out = join(dir, 'token-preview');
      const res = await cli([
        'layout',
        'preview',
        join(dir, 'challenge.yaml'),
        '--punchboard',
        'Challenges',
        '-o',
        out,
      ]);
      expect(res.exitCode, res.stderr).toBe(0);
      expect((await readdir(out)).sort()).toEqual([
        'three (back).png',
        'three.png',
        'two (back).png',
        'two.png',
      ]);
      // 25 mm at the layout's 100 dpi.
      expect((await readFile(join(out, 'two (back).png'))).readUInt32BE(16)).toBe(98);
    });

    it('says every token is drawn, and draws the back again when the layout changes', async () => {
      const check = await cli(['component', 'tokens', 'render', 'Challenges', '--check']);
      expect(check.exitCode, check.stderr).toBe(0);

      const backBefore = (await board()).tokens[0]!.back_file!.checksum;
      const pushed = await cli([
        'layout',
        'push',
        await write('challenge-2.yaml', CHALLENGE.replace('#c9a227', '#ffd700')),
      ]);
      expect(pushed.exitCode, pushed.stderr).toBe(0);
      expect(pushed.stdout).toContain('Challenges: 2 tokens');
      expect(pushed.stdout).toContain('Updated two.png');
      expect((await board()).tokens[0]!.back_file!.checksum).not.toBe(backBefore);
    });
  });

  it('refuses to delete a layout cards are drawn from', async () => {
    const res = await cli(['layout', 'delete', 'Hero', '--force']);
    expect(res.exitCode).toBe(5);
    expect(res.stderr).toContain('cards are drawn from this layout');
  });
});
