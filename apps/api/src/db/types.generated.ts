// AUTO-GENERATED. DO NOT EDIT.
// Regenerate with: pnpm --filter @three-peaks/api run kysely-codegen
//
// The generator migrates a scratch database from src/db/migrations, introspects
// that, and drops it. It never reads the database you develop against, so a
// column left behind by an abandoned branch cannot land in a commit looking
// exactly like a real one.

import type { ColumnType } from 'kysely';

export type Generated<T> =
  T extends ColumnType<infer S, infer I, infer U>
    ? ColumnType<S, I | undefined, U>
    : ColumnType<T, T | undefined, T>;

export type Int8 = ColumnType<string, bigint | number | string, bigint | number | string>;

export type Json = JsonValue;

export type JsonArray = JsonValue[];

export type JsonObject = {
  [x: string]: JsonValue | undefined;
};

export type JsonPrimitive = boolean | number | string | null;

export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export type Numeric = ColumnType<string, number | string, number | string>;

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface AppUser {
  alternative_id: Generated<string>;
  created_at: Generated<Timestamp>;
  email: string;
  email_verified: Generated<boolean>;
  id: string;
  name: string;
  password_hash: string;
  updated_at: Generated<Timestamp>;
}

export interface CanvaAppBuild {
  branch: string;
  built_at: Timestamp;
  commit: string;
  dirty: boolean;
  first_seen_at: Generated<Timestamp>;
  last_seen_at: Generated<Timestamp>;
}

export interface CanvaAppLink {
  canva_brand_id: string | null;
  canva_user_id: string;
  created_at: Generated<Timestamp>;
  id: string;
  last_used_at: Timestamp | null;
  user_id: string;
}

export interface CanvaAppPairing {
  canva_brand_id: string | null;
  canva_user_id: string;
  claimed_at: Timestamp | null;
  claimed_by: string | null;
  code_hash: string;
  created_at: Generated<Timestamp>;
  expires_at: Timestamp;
  id: string;
}

export interface Component {
  created_at: Generated<Timestamp>;
  created_by: string;
  deleted_at: Timestamp | null;
  deleted_by: string | null;
  id: string;
  kind: string;
  name: string;
  position: Generated<number>;
  project_id: string;
  settings: Json;
  updated_at: Generated<Timestamp>;
}

export interface ComponentModel {
  created_at: Generated<Timestamp>;
  id: string;
  project_id: string;
  settings: Json;
  source_file_id: string;
  updated_at: Generated<Timestamp>;
  updated_by: string;
}

export interface Deck {
  back_file_id: string | null;
  card_height_mm: Numeric;
  card_width_mm: Numeric;
  created_at: Generated<Timestamp>;
  created_by: string;
  deleted_at: Timestamp | null;
  deleted_by: string | null;
  id: string;
  name: string;
  project_id: string;
  updated_at: Generated<Timestamp>;
}

export interface DeckCard {
  deck_id: string;
  file_id: string;
  id: string;
  position: number;
  quantity: Generated<number>;
}

export interface DeckImport {
  created_at: Generated<Timestamp>;
  deck_id: string;
  id: string;
  source_kind: string;
  source_label: string | null;
  source_ref: string | null;
  updated_at: Generated<Timestamp>;
}

export interface DeckImportCard {
  added_to_deck_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  detached_at: Timestamp | null;
  file_id: string;
  id: string;
  identity_key: string;
  import_id: string;
  page_number: number;
  source_page_id: string | null;
}

export interface File {
  byte_size: Int8;
  checksum: string | null;
  component_id: string | null;
  component_role: string | null;
  content_type: string;
  created_at: Generated<Timestamp>;
  deck_id: string | null;
  deleted_at: Timestamp | null;
  deleted_by: string | null;
  filename: string;
  folder_id: string | null;
  id: string;
  image_height: number | null;
  image_width: number | null;
  name_locked: Generated<boolean>;
  project_id: string;
  storage_key: string;
  updated_at: Generated<Timestamp>;
  uploaded_by: string;
}

export interface FileVersion {
  byte_size: Int8;
  checksum: string | null;
  content_type: string;
  created_at: Generated<Timestamp>;
  created_by: string;
  file_id: string;
  id: string;
  image_height: number | null;
  image_width: number | null;
  storage_key: string;
  version_number: number;
}

export interface Folder {
  created_at: Generated<Timestamp>;
  created_by: string;
  deleted_at: Timestamp | null;
  deleted_by: string | null;
  id: string;
  name: string;
  parent_id: string | null;
  project_id: string;
  updated_at: Generated<Timestamp>;
}

export interface ImportRun {
  finished_at: Timestamp | null;
  id: string;
  import_id: string;
  page_count: number;
  source_label: string | null;
  started_at: Generated<Timestamp>;
  started_by: string;
  status: string;
  summary: Json | null;
}

export interface ImportRunCard {
  file_version_number: number | null;
  id: string;
  import_card_id: string | null;
  matched_by: string | null;
  name: string;
  outcome: string;
  page_number: number | null;
  restored: Generated<boolean>;
  run_id: string;
}

export interface ImportRunPage {
  card_id: string;
  id: string;
  identity_key: string;
  matched_by: string | null;
  page_number: number;
  run_id: string;
  source_page_id: string | null;
}

export interface PersonalAccessToken {
  created_at: Generated<Timestamp>;
  id: string;
  last_used_at: Timestamp | null;
  name: string;
  token_hash: string;
  user_id: string;
}

export interface PrintRun {
  created_at: Generated<Timestamp>;
  created_by: string | null;
  id: string;
  project_id: string;
}

export interface PrintRunCard {
  back_file_id: string | null;
  back_version_number: number | null;
  copies: number;
  file_id: string;
  id: string;
  run_id: string;
  version_number: number;
}

export interface Project {
  created_at: Generated<Timestamp>;
  created_by: string;
  description: string | null;
  id: string;
  name: string;
  updated_at: Generated<Timestamp>;
}

export interface ProjectMember {
  created_at: Generated<Timestamp>;
  project_id: string;
  role: string;
  user_id: string;
}

export interface Session {
  created_at: Generated<Timestamp>;
  expires_at: Timestamp;
  id: string;
  token_hash: string;
  user_agent: string | null;
  user_id: string;
}

export interface DB {
  app_user: AppUser;
  canva_app_build: CanvaAppBuild;
  canva_app_link: CanvaAppLink;
  canva_app_pairing: CanvaAppPairing;
  component: Component;
  component_model: ComponentModel;
  deck: Deck;
  deck_card: DeckCard;
  deck_import: DeckImport;
  deck_import_card: DeckImportCard;
  file: File;
  file_version: FileVersion;
  folder: Folder;
  import_run: ImportRun;
  import_run_card: ImportRunCard;
  import_run_page: ImportRunPage;
  personal_access_token: PersonalAccessToken;
  print_run: PrintRun;
  print_run_card: PrintRunCard;
  project: Project;
  project_member: ProjectMember;
  session: Session;
}
