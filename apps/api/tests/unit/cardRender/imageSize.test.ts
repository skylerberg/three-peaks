import { describe, expect, it } from 'vitest';
import { imageSize } from '../../../src/services/cardRender/imageSize.ts';
import { solidPng } from '../../setup/layoutFixtures.ts';

const svg = (root: string) => ({
  bytes: new TextEncoder().encode(`<?xml version="1.0"?>\n${root}<rect/></svg>`),
  contentType: 'image/svg+xml',
});

describe('imageSize', () => {
  it('reads a PNG from its header', async () => {
    expect(
      imageSize({ bytes: await solidPng('#000000', 12, 5), contentType: 'image/png' })
    ).toEqual({ width: 12, height: 5 });
  });

  it('reads a JPEG from its frame header, past the segments before it', () => {
    // SOI, an APP0 segment of 16 bytes, then a baseline frame header: 16 tall, 32 wide.
    const bytes = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0x00,
      0x10,
      ...new Array<number>(14).fill(0),
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      0x00,
      0x10,
      0x00,
      0x20,
      0x03,
    ]);
    expect(imageSize({ bytes, contentType: 'image/jpeg' })).toEqual({ width: 32, height: 16 });
  });

  it("reads an SVG's viewBox, or its width and height when it has none", () => {
    expect(
      imageSize(svg('<svg xmlns="http://www.w3.org/2000/svg" width="1in" viewBox="0 0 40 120">'))
    ).toEqual({
      width: 40,
      height: 120,
    });
    expect(imageSize(svg("<svg width='30px' height='10'>"))).toEqual({ width: 30, height: 10 });
  });

  it('is null for an image that states no size', () => {
    expect(imageSize(svg('<svg width="100%" height="100%">'))).toBeNull();
    expect(
      imageSize({ bytes: new Uint8Array([0xff, 0xd8]), contentType: 'image/jpeg' })
    ).toBeNull();
  });
});
