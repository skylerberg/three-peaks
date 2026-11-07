import { type } from 'arktype';
import { stringWithLength, uuid } from './common.ts';

export const folderSchema = type({
  id: 'string',
  project_id: 'string',
  parent_id: 'string | null',
  name: 'string',
  created_at: 'string',
  updated_at: 'string',
});

export const fileSchema = type({
  id: 'string',
  project_id: 'string',
  // Where the file lives, and exactly one of the three is set: a deck owns its
  // cards, a component owns its source images, and a file naming neither is a
  // loose asset in the folder tree.
  folder_id: 'string | null',
  deck_id: 'string | null',
  component_id: 'string | null',
  component_role: 'string | null',
  filename: 'string',
  content_type: 'string',
  byte_size: 'number',
  // The sha256 of the current version's bytes, null for a row older than the
  // version history. On the wire so a client holding bytes can tell whether
  // uploading them would change anything without sending them.
  checksum: 'string | null',
  image_width: 'number | null',
  image_height: 'number | null',
  // Whether a person has named this file, which is what an import will not
  // overwrite. On the wire because the screen that renames one has to say so.
  name_locked: 'boolean',
  uploaded_by: 'string',
  created_at: 'string',
  updated_at: 'string',
  // Null for a live file. A screen that resolves a row by id has to tell a
  // tombstone apart from a live one, or it offers actions that answer 409.
  deleted_at: 'string | null',
});

export const createFolderRequestSchema = type({
  'id?': uuid,
  project_id: uuid,
  'parent_id?': 'string.uuid | null',
  name: stringWithLength(1, 255),
});

export const updateFolderRequestSchema = type({
  'name?': stringWithLength(1, 255),
  'parent_id?': 'string.uuid | null',
});

export const updateFileRequestSchema = type({
  'filename?': stringWithLength(1, 255),
  'folder_id?': 'string.uuid | null',
  // A rename locks the name on its own; sending this is how a lock is lifted.
  'name_locked?': 'boolean',
});

// One request per screen: the folders and files directly inside one directory,
// plus the breadcrumb trail to it.
export const directoryListingSchema = type({
  project_id: 'string',
  folder: folderSchema.or('null'),
  breadcrumb: folderSchema.array(),
  folders: folderSchema.array(),
  files: fileSchema.array(),
  storage_used_bytes: 'number',
  storage_quota_bytes: 'number',
});

export const uploadQuerySchema = type({
  project_id: uuid,
  filename: stringWithLength(1, 255),
  // The destination, and at most one of the three. Absent altogether is the
  // Assets root, which is what the previous release's client sends.
  'folder_id?': 'string.uuid',
  'deck_id?': 'string.uuid',
  'component_id?': 'string.uuid',
  'role?': "'card' | 'back' | 'artwork' | 'cut'",
  'id?': uuid,
});

export const directoryQuerySchema = type({
  project_id: uuid,
  'folder_id?': 'string.uuid',
});

// One entry of a file's history. storage_key is deliberately absent: the name
// of a stored object never crosses the wire.
export const fileVersionSchema = type({
  file_id: 'string',
  version_number: 'number',
  content_type: 'string',
  byte_size: 'number',
  // Null means the checksum is unknown, which is what a row backfilled from
  // before this table existed carries.
  checksum: 'string | null',
  image_width: 'number | null',
  image_height: 'number | null',
  created_by: 'string',
  created_at: 'string',
  is_current: 'boolean',
});

export const fileVersionListSchema = type({
  versions: fileVersionSchema.array(),
});

// One schema for both appending and restoring: two exported schemas with the
// same shape make the $ref the spec writes ambiguous and the dump refuses.
export const fileVersionResultSchema = type({
  created: 'boolean',
  version: fileVersionSchema,
});

// A string rather than a parsed number, because a query parameter is a string
// and the pattern is what the generated client carries.
export const versionQuerySchema = type({
  'version?': '/^[1-9][0-9]{0,8}$/',
});

// Only the literal word. Anything else — ?purge=false included — is a 400, so
// reclaiming the bytes is never something a typo falls into.
export const purgeQuerySchema = type({
  'purge?': "'true'",
});

// A restore may hand over a new name in the same request. Two steps instead
// would leave a window where the tombstone still holds the old one.
export const restoreFileQuerySchema = type({
  'filename?': stringWithLength(1, 255),
});

export const restoreFolderQuerySchema = type({
  'name?': stringWithLength(1, 255),
});

// One row of the deleted listing. Flat, with the path each entry came from,
// because a deleted subtree has no live parent to browse into.
export const deletedEntrySchema = type({
  kind: "'file' | 'folder' | 'deck' | 'component'",
  id: 'string',
  project_id: 'string',
  name: 'string',
  // Which section it goes back to, and so which route restores it.
  home_kind: "'folder' | 'deck' | 'component'",
  // Where it came from: the folders above it, outermost first and empty at the
  // Assets root, or the name of the deck or component that holds it. Empty for
  // a deck or a component, which are inside nothing.
  path: 'string',
  content_type: 'string | null',
  // For a file, what purging it reclaims: every version of it, not the current one.
  byte_size: 'number | null',
  deleted_at: 'string',
  deleted_by: 'string | null',
  // The name of the deleted folder that has to come back first, or null when
  // this entry can be restored on its own.
  blocked_by: 'string | null',
});

export const deletedListingSchema = type({
  entries: deletedEntrySchema.array(),
});

// Where a file is being moved to. Exactly one destination: a folder (null for
// the Assets root), a deck, or a component. `role` says which slot it fills --
// a deck's back rather than one of its cards, a punchboard's cut sheet rather
// than its artwork.
export const moveFileRequestSchema = type({
  'folder_id?': 'string.uuid | null',
  'deck_id?': 'string.uuid | null',
  'component_id?': 'string.uuid | null',
  'role?': "'card' | 'back' | 'artwork' | 'cut'",
});
