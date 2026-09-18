import { describe, expect, it } from 'vitest';
import { localName, parsePositiveInt, versionedName } from '../../src/assets.ts';

describe('localName', () => {
  it('keeps an ordinary filename as it is', () => {
    expect(localName('cover art.png', 'fallback')).toBe('cover art.png');
  });

  it('never lets a stored name reach outside the target directory', () => {
    expect(localName('../../etc/passwd', 'fallback')).toBe('.._.._etc_passwd');
    expect(localName('a\\b.png', 'fallback')).toBe('a_b.png');
    expect(localName('..', 'fallback')).toBe('fallback');
    expect(localName('.', 'fallback')).toBe('fallback');
    expect(localName('\u0007', 'fallback')).toBe('fallback');
  });
});

describe('versionedName', () => {
  it('puts the version before the extension so the file still opens', () => {
    expect(versionedName('cover.png', 3)).toBe('cover.v3.png');
    expect(versionedName('archive.tar.gz', 2)).toBe('archive.tar.v2.gz');
  });

  it('appends to a name with no extension, including a dotfile', () => {
    expect(versionedName('README', 1)).toBe('README.v1');
    expect(versionedName('.env', 1)).toBe('.env.v1');
  });
});

describe('parsePositiveInt', () => {
  it('accepts a whole number from one up', () => {
    expect(parsePositiveInt('1', 'n')).toBe(1);
    expect(parsePositiveInt('42', 'n')).toBe(42);
  });

  it.each(['0', '-1', '1.5', '1e3', ' 2', '', 'two'])('refuses %j', (value) => {
    expect(() => parsePositiveInt(value, 'The version')).toThrow(/positive whole number/);
  });
});
