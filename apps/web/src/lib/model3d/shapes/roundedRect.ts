import { Shape } from 'three';

// Centred on the origin unless told otherwise, in metres, with real arcs rather
// than a polygon: the extruder's curveSegments decides how round the corner is,
// and a card's is the silhouette people notice first. A shape is a path, so the
// same outline moved to where a token sits is the hole a die cuts for it.
export function roundedRectShape(
  width: number,
  height: number,
  radius: number,
  centre: { x: number; y: number } = { x: 0, y: 0 }
): Shape {
  const left = centre.x - width / 2;
  const right = centre.x + width / 2;
  const bottom = centre.y - height / 2;
  const top = centre.y + height / 2;
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));

  const shape = new Shape();
  shape.moveTo(left + r, bottom);
  shape.lineTo(right - r, bottom);
  if (r > 0) shape.absarc(right - r, bottom + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(right, top - r);
  if (r > 0) shape.absarc(right - r, top - r, r, 0, Math.PI / 2, false);
  shape.lineTo(left + r, top);
  if (r > 0) shape.absarc(left + r, top - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(left, bottom + r);
  if (r > 0) shape.absarc(left + r, bottom + r, r, Math.PI, (3 * Math.PI) / 2, false);
  shape.closePath();

  return shape;
}
