import { MeshStandardMaterial, type Texture } from 'three';
import type { PunchboardModelSettings } from '@three-peaks/shared';
import { laminateRoughness } from './box.ts';

// Printed greyboard: flatter than a box wrap, because a punchboard is finished
// matte so the tokens do not shine under a table lamp.
const PRINTED_ROUGHNESS = 0.66;
// The die cut goes through to raw board, which takes no sheen at all.
const CUT_EDGE_ROUGHNESS = 0.95;

// One token's printed faces. A back of null is the board left unprinted.
export interface TokenFaces {
  front: Texture;
  back: Texture | null;
}

export interface PunchboardMaterials {
  // The slots of the sheet's mesh, and of each token's, in face-group order:
  // front, back, edge.
  sheet: MeshStandardMaterial[];
  tokens: MeshStandardMaterial[][];
  // Each material once, for disposal and for counting.
  all: MeshStandardMaterial[];
}

/**
 * The frame round the tokens is board on both sides, and so is a token's back
 * with nothing printed there; each token's printed faces are materials of their
 * own, named after it, because a face nobody can select in Blender is a face
 * nobody can retouch there.
 */
export function punchboardMaterials(
  settings: PunchboardModelSettings,
  tokens: readonly TokenFaces[]
): PunchboardMaterials {
  const roughnessMap = laminateRoughness(settings.seed, PRINTED_ROUGHNESS);
  const common = { roughnessMap, roughness: 1, metalness: 0 };

  const board = new MeshStandardMaterial({
    ...common,
    name: 'Punchboard.board',
    color: settings.back_color,
  });
  // Flat, for the reason boardMaterials gives about its own edge.
  const edge = new MeshStandardMaterial({
    name: 'Punchboard.edge',
    color: settings.edge_color,
    roughness: CUT_EDGE_ROUGHNESS,
    metalness: 0,
  });

  const all = [board, edge];
  const printed = tokens.map((faces, index) => {
    // After the token's place in the list, not a mesh's: every copy of one
    // token shares its two faces.
    const name = `Punchboard.token-${String(index + 1).padStart(3, '0')}`;
    const front = new MeshStandardMaterial({ ...common, name: `${name}.front`, map: faces.front });
    all.push(front);
    if (faces.back === null) return [front, board, edge];
    const back = new MeshStandardMaterial({ ...common, name: `${name}.back`, map: faces.back });
    all.push(back);
    return [front, back, edge];
  });

  return { sheet: [board, board, edge], tokens: printed, all };
}
