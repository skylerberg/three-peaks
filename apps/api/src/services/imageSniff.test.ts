import { describe, expect, it } from 'vitest';
import { SNIFF_BYTES, sniffContentType } from './imageSniff.ts';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const gif = Buffer.from('GIF89a......', 'latin1');
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
const glb = Buffer.concat([Buffer.from('glTF'), Buffer.from([0x02, 0x00, 0x00, 0x00])]);
// An sfnt header: version, then a table count of 12, then the search fields.
const sfnt = (version: number[]) => Buffer.from([...version, 0x00, 0x0c, 0, 0, 0, 0, 0, 0]);
const ttf = sfnt([0x00, 0x01, 0x00, 0x00]);
const appleTtf = sfnt([0x74, 0x72, 0x75, 0x65]);
const otf = sfnt([0x4f, 0x54, 0x54, 0x4f]);
const woff = Buffer.concat([
  Buffer.from('wOFF'),
  Buffer.from([0x00, 0x01, 0x00, 0x00]),
  Buffer.alloc(4),
]);

describe('sniffContentType', () => {
  it.each([
    ['png', png, 'image/png'],
    ['jpeg', jpeg, 'image/jpeg'],
    ['gif', gif, 'image/gif'],
    ['webp', webp, 'image/webp'],
    ['glb', glb, 'model/gltf-binary'],
    ['ttf', ttf, 'font/ttf'],
    ["Apple's ttf", appleTtf, 'font/ttf'],
    ['otf', otf, 'font/otf'],
    ['woff', woff, 'font/woff'],
  ])('identifies %s', (_name, buffer, expected) => {
    expect(sniffContentType(buffer)).toBe(expected);
  });

  it('rejects a buffer shorter than the signature it would match', () => {
    expect(sniffContentType(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  // The whole point: a RIFF container that is not WebP (a .wav, say) must not
  // pass as an image because its first four bytes match.
  it('does not accept RIFF without the WEBP tag', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]);
    expect(sniffContentType(wav)).toBeNull();
  });

  it('does not accept a glTF container at a version that does not exist', () => {
    const v1 = Buffer.concat([Buffer.from('glTF'), Buffer.from([0x01, 0x00, 0x00, 0x00])]);
    expect(sniffContentType(v1)).toBeNull();
  });

  it('does not take any buffer opening 00 01 00 00 for a font', () => {
    const noTables = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0]);
    expect(sniffContentType(noTables)).toBeNull();
  });

  it('leaves a font collection unrecognised', () => {
    expect(sniffContentType(sfnt([0x74, 0x74, 0x63, 0x66]))).toBeNull();
  });

  it('does not accept HTML that claims to be an image', () => {
    expect(sniffContentType(Buffer.from('<!doctype html'))).toBeNull();
  });

  describe('svg', () => {
    it.each([
      ['a bare root element', '<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>'],
      ['a self-closing root element', '<svg/>'],
      ['an uppercase root element', '<SVG xmlns="http://www.w3.org/2000/svg"></SVG>'],
      ['an xml declaration', '<?xml version="1.0" encoding="UTF-8"?>\n<svg width="10"></svg>'],
      ['leading whitespace', '\n\n   <svg></svg>'],
      ['a comment', '<!-- drawn by hand -->\n<svg></svg>'],
      [
        'a doctype',
        '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "svg11.dtd">\n<svg></svg>',
      ],
      ['a doctype with an internal subset', '<!DOCTYPE svg [<!ENTITY a "b">]>\n<svg></svg>'],
      ['a byte order mark', '﻿<svg></svg>'],
    ])('identifies an svg behind %s', (_name, text) => {
      expect(sniffContentType(Buffer.from(text, 'utf8'))).toBe('image/svg+xml');
    });

    // The bug this exists to catch: searching the head for "<svg" anywhere
    // types an HTML page -- which a browser will happily run scripts from -- as
    // an image.
    it('does not accept HTML with an inline svg element', () => {
      const html = '<!DOCTYPE html>\n<html><body><svg><circle /></svg></body></html>';
      expect(sniffContentType(Buffer.from(html, 'utf8'))).toBeNull();
    });

    it('does not accept an xml document whose root is not svg', () => {
      const xml = '<?xml version="1.0"?>\n<kml><Document /></kml>';
      expect(sniffContentType(Buffer.from(xml, 'utf8'))).toBeNull();
    });

    it('does not accept an element that merely starts with svg', () => {
      expect(sniffContentType(Buffer.from('<svgish></svgish>', 'utf8'))).toBeNull();
    });

    // Unterminated, so the root tag is not in the head at all. Failing closed
    // stores it as an opaque stream, which is the safe direction.
    it('does not accept a declaration left open at the end of the head', () => {
      expect(sniffContentType(Buffer.from('<!-- ' + 'x'.repeat(2000), 'utf8'))).toBeNull();
    });
  });

  it('reads within the documented peek length', () => {
    expect(webp.length).toBeLessThanOrEqual(SNIFF_BYTES);
  });
});
