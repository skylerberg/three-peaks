import { describe, expect, it } from 'vitest';
import {
  buildScene,
  DEFAULT_CARD_SETTINGS,
  instancesForTarget,
  isCameraShot,
  SCENE_LIMITS,
  shotEndSeconds,
  validateScene,
} from '@three-peaks/shared';
import { planScene, type ScenePlan, type SceneSelection } from './assets.ts';
import { DEFAULT_SCENE_TEMPLATE_ID, SCENE_TEMPLATES, sceneTemplate } from './templates.ts';

const WIDE = 1920 / 1080;

function context(plan: ScenePlan) {
  return { groups: plan.groups, instances: plan.instances, extent: plan.extent, aspect: WIDE };
}

const image = (id: string) => ({ file_id: id, content_type: 'image/png' });

function selection(cards: number, decks = 1): SceneSelection {
  return {
    files: [
      {
        label: 'Token',
        front: image('token'),
        back: null,
        tokens: null,
        part: null,
        settings: { ...DEFAULT_CARD_SETTINGS },
        copies: 1,
      },
    ],
    decks: Array.from({ length: decks }, (_, index) => ({
      deck_id: `deck-${index}`,
      name: `Deck ${index + 1}`,
      card_width_mm: 63,
      card_height_mm: 88,
      back: image('back'),
      cards: Array.from({ length: cards }, (_, card) => ({
        label: `Card ${card + 1}`,
        front: image(`card-${index}-${card}`),
        copies: 1,
        settings: null,
      })),
    })),
    library: [{ piece: 'meeple', count: 3 }],
  };
}

describe('SCENE_TEMPLATES', () => {
  it('offers the default under a name that resolves', () => {
    expect(sceneTemplate(DEFAULT_SCENE_TEMPLATE_ID)).toBeDefined();
    expect(sceneTemplate('nothing-by-that-name')).toBeUndefined();
  });

  it.each(SCENE_TEMPLATES.map((template) => [template.id, template] as const))(
    'lays out "%s" as a scene the importer would accept',
    (_id, template) => {
      const plan = planScene(selection(6, 2));

      const built = template.build(context(plan));
      const scene = buildScene({
        project_name: 'Trailer',
        generated_at: '2026-08-27T12:00:00.000Z',
        assets: plan.assets,
        instances: plan.instances,
        shots: built.shots,
        camera: built.camera,
        lighting: built.lighting,
      });

      expect(validateScene(scene)).toEqual([]);
      expect(built.shots.length).toBeGreaterThan(0);
      expect(built.shots.length).toBeLessThanOrEqual(SCENE_LIMITS.shots[1]);
      expect(new Set(built.shots.map((shot) => shot.id)).size).toBe(built.shots.length);
    }
  );

  it('aims a card gesture at the decks, and leaves a board where it stands', () => {
    const plan = planScene(selection(4, 2));

    const shots = sceneTemplate('deal-out')!.build(context(plan)).shots;

    // Two decks, a loose token and three meeples: dealing all five groups
    // collapses the token and the meeples onto the cards' own grid.
    expect(shots.map((shot) => shot.target)).toEqual(
      plan.groups.filter((group) => group.kind === 'deck').map((group) => group.name)
    );
  });

  it('deals each deck onto its own patch of table rather than the middle of the world', () => {
    const plan = planScene(selection(4, 2));

    const shots = sceneTemplate('deal-out')!.build(context(plan)).shots;
    const origins = shots.map((shot) => (shot.kind === 'deal' ? shot.grid?.origin_mm : null));

    expect(origins).toHaveLength(2);
    expect(origins[0]).not.toEqual(origins[1]);
    for (const [index, origin] of origins.entries()) {
      expect(origin?.[0]).toBeCloseTo(plan.groups[index].origin_mm[0], 6);
    }
  });

  it('frames the parade on the line it makes, not on the table it came from', () => {
    const plan = planScene(selection(8, 2));

    const parade = sceneTemplate('parade')!.build(context(plan));
    const still = sceneTemplate('turntable')!.build(context(plan));

    expect(Math.hypot(...parade.camera.position_mm)).toBeGreaterThan(
      Math.hypot(...still.camera.position_mm)
    );
  });

  it('circles at the distance the still was framed from', () => {
    const plan = planScene(selection(6, 1));

    const built = sceneTemplate('orbit')!.build(context(plan));
    const orbit = built.shots[0];

    expect(orbit.kind).toBe('orbit');
    if (orbit.kind !== 'orbit') return;
    expect(orbit.radius_mm).toBeCloseTo(
      Math.hypot(built.camera.position_mm[0], built.camera.position_mm[1]),
      6
    );
    expect(orbit.height_mm).toBeCloseTo(built.camera.position_mm[2], 6);
  });

  it('ends the hero reveal on the pose it framed, having started further out', () => {
    const plan = planScene(selection(6, 1));

    const built = sceneTemplate('hero-reveal')!.build(context(plan));
    const reveal = built.shots.find((shot) => shot.kind === 'reveal');

    expect(reveal?.kind).toBe('reveal');
    if (reveal?.kind !== 'reveal') return;
    expect(reveal.to_mm).toEqual(built.camera.position_mm);
    expect(Math.hypot(...reveal.from_mm)).toBeGreaterThan(Math.hypot(...reveal.to_mm));
  });

  it('starts each shot after the one before it has finished with its own targets', () => {
    const plan = planScene(selection(6, 2));

    const shots = sceneTemplate('fan-out')!.build(context(plan)).shots;

    // A staggered shot runs past its own duration, so the second start has to
    // clear the last card of the first deck rather than the first one.
    const first = shots[0];
    const count = instancesForTarget(plan.instances, first.target).length;
    expect(shots[1].start_s).toBeGreaterThan(shotEndSeconds(first, count));
    expect(shots[1].start_s).toBeLessThan(shotEndSeconds(first, count) + 1);
  });

  it('gives the hero reveal a camera move and a turn for the front group', () => {
    const plan = planScene(selection(3));

    const shots = sceneTemplate('hero-reveal')!.build(context(plan)).shots;

    expect(shots.filter(isCameraShot)).toHaveLength(1);
    expect(shots.map((shot) => shot.kind)).toContain('flip');
  });

  it('aims at the whole scene when a selection made no groups at all', () => {
    const shots = sceneTemplate('fan-out')!.build({
      groups: [],
      instances: [],
      extent: { width_mm: 0, depth_mm: 0, height_mm: 0 },
      aspect: WIDE,
    }).shots;

    expect(shots.map((shot) => shot.target)).toEqual(['scene']);
  });
});
