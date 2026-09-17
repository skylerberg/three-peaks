import { type } from 'arktype';
import { COMPONENT_NAME_LIMITS } from '@three-peaks/shared';
import { stringWithLength, uuid } from './common.ts';
import { fileSchema } from './files.ts';
import {
  boardModelSettingsSchema,
  boxModelSettingsSchema,
  punchboardModelSettingsSchema,
  woodModelSettingsSchema,
} from './models.ts';

const componentName = stringWithLength(...COMPONENT_NAME_LIMITS);

// The kinds a component can be: every model kind but the card, which is a
// member of a deck rather than a thing of its own that someone names. Spelled
// out because ArkType reads the string as a type; a test walks COMPONENT_KINDS
// so this cannot drift from the list the sections are built out of.
const componentKind = type("'wood' | 'box' | 'board' | 'punchboard'");

// Deliberately not modelSettingsSchema: that union admits a card, and a card's
// dial-in has no component to hang off.
export const componentSettingsSchema = woodModelSettingsSchema
  .or(boxModelSettingsSchema)
  .or(boardModelSettingsSchema)
  .or(punchboardModelSettingsSchema);

// The strict type the validator produces, which is what a jsonb column and a
// realtime payload both want -- shared's ModelSettings is looser about the
// colours and does not narrow to the four component kinds.
export type ComponentSettings = typeof componentSettingsSchema.infer;

export const componentFileSchema = type({
  role: "'artwork' | 'cut'",
  file: fileSchema,
});

export const componentSchema = type({
  id: 'string',
  project_id: 'string',
  kind: 'string',
  name: 'string',
  // Where it sits in its section. The order is per kind, because a section is
  // one kind -- dragging a wooden piece cannot move the box.
  position: 'number',
  settings: componentSettingsSchema,
  created_by: 'string',
  created_at: 'string',
  updated_at: 'string',
  deleted_at: 'string | null',
  // Its own artwork, and for a punchboard its cut sheet. The section draws a
  // thumbnail per component, so a listing that left these out would be one
  // request per row.
  files: componentFileSchema.array(),
  // Which of the roles its kind needs are still missing, so a screen can say
  // what a half-built component is waiting for without knowing the rule.
  missing_roles: type("'artwork' | 'cut'").array(),
});

export const componentListSchema = type({ components: componentSchema.array() });

export const createComponentRequestSchema = type({
  'id?': uuid,
  project_id: uuid,
  kind: componentKind,
  name: componentName,
  // Absent means the defaults for the kind, which is what the studio starts
  // from anyway -- a component is created before its artwork is uploaded.
  'settings?': componentSettingsSchema,
});

export const updateComponentRequestSchema = type({
  'name?': componentName,
  'settings?': componentSettingsSchema,
});

// The whole ordered list of one section in one request, the way a deck's cards
// are replaced: the ids are the order, and anything but exactly the section's
// live components is refused. Nothing here says what a component is, so a
// reorder cannot add or remove one.
export const putComponentOrderRequestSchema = type({
  project_id: uuid,
  kind: componentKind,
  component_ids: uuid.array(),
});

export const componentQuerySchema = type({
  project_id: uuid,
  'kind?': componentKind,
});
