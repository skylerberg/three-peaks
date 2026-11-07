import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { components } from '@three-peaks/shared/api';
import { deleteUser, type TestUser } from '../../../api/tests/setup/testContext.ts';
import { boxFont, solidPng, solidSvg } from '../layoutFixtures.ts';
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
    expect(res.stdout).toContain('Updated archer.png to version 2 (content, image)');
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

  it('says which cards a new version of their art left out of date, and renders them', async () => {
    const green = await write('green.png', await solidPng('#00ff00'));
    expect((await cli(['file', 'push', 'Art/knight.png', green])).exitCode).toBe(0);

    const check = await cli(['deck', 'render', 'Heroes', '--check']);
    expect(check.exitCode).toBe(5);
    expect(check.stdout).toContain('Out of date: knight.png');
    expect(check.stdout).toContain('Unchanged archer.png');
    expect(await versions('knight.png')).toBe(1);

    const render = await cli(['deck', 'render', 'Heroes']);
    expect(render.exitCode).toBe(0);
    expect(render.stdout).toContain('Updated knight.png to version 2');
    expect((await cli(['deck', 'render', 'Heroes', '--check'])).exitCode).toBe(0);
  });

  it('re-renders every card drawn from a layout when the layout changes', async () => {
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

  it('refuses to delete a layout cards are drawn from', async () => {
    const res = await cli(['layout', 'delete', 'Hero', '--force']);
    expect(res.exitCode).toBe(5);
    expect(res.stderr).toContain('cards are drawn from this layout');
  });
});
