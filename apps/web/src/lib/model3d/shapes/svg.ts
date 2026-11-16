import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import type { Outline, Ring } from './types.ts';

// Divisions per curve when a parsed path is flattened to a polygon. A token is
// a few centimetres across, so this is well past what an eye or an extruder can
// tell from the curve itself.
const CURVE_DIVISIONS = 24;

// Parsed, never rendered. SVGLoader reads the document with DOMParser as
// image/svg+xml, which does not run script, and nothing here reaches the page:
// only the path data becomes geometry.
export function svgOutlines(text: string): Outline[] {
  const parsed = new SVGLoader().parse(text);
  const outlines: Outline[] = [];

  for (const path of parsed.paths) {
    // A stroke-only path has no area to extrude; taking its outline anyway
    // would turn a construction line into a piece of wood.
    const style = (path.userData as { style?: { fill?: string } } | undefined)?.style;
    if (style?.fill === 'none') continue;

    for (const shape of SVGLoader.createShapes(path)) {
      const points = shape.extractPoints(CURVE_DIVISIONS);
      const contour = toRing(points.shape);
      if (contour.length < 3) continue;
      outlines.push({ contour, holes: points.holes.map(toRing).filter((h) => h.length >= 3) });
    }
  }

  return outlines;
}

function toRing(points: { x: number; y: number }[]): Ring {
  const ring = points.map((point) => ({ x: point.x, y: point.y }));
  const first = ring[0];
  const last = ring[ring.length - 1];
  // extractPoints repeats the start of a closed path; the ring form does not.
  if (ring.length > 1 && first.x === last.x && first.y === last.y) ring.pop();
  return ring;
}
