// Every fact about an event type is one row of this table: that it exists, and
// whether its payload names the acting user.
//
// Adding a row here is what makes a type publishable, so the classification
// cannot be left half-done -- and payloads.ts is pinned to these keys, so a
// type with no payload shape does not compile.
export const EVENT_CATALOG = {
  project_updated: { carriesActor: true },
  project_deleted: { carriesActor: true },
  folder_created: { carriesActor: true },
  folder_updated: { carriesActor: true },
  folder_deleted: { carriesActor: true },
  file_uploaded: { carriesActor: true },
  file_updated: { carriesActor: true },
  file_deleted: { carriesActor: true },
  file_version_created: { carriesActor: true },
  file_moved: { carriesActor: true },
  model_updated: { carriesActor: true },
  component_created: { carriesActor: true },
  component_updated: { carriesActor: true },
  component_deleted: { carriesActor: true },
  component_order_changed: { carriesActor: true },
  deck_created: { carriesActor: true },
  deck_updated: { carriesActor: true },
  deck_deleted: { carriesActor: true },
  deck_import_started: { carriesActor: true },
  deck_import_finished: { carriesActor: true },
  members_changed: { carriesActor: true },
} as const;

export type RealtimeEventType = keyof typeof EVENT_CATALOG;

// The subset whose payload names who made the change. Derived from the table
// rather than listed again, so payloads.ts and publishAfterCommit read the same
// answer this file gives.
export type ActorEventType = {
  [K in RealtimeEventType]: (typeof EVENT_CATALOG)[K]['carriesActor'] extends true ? K : never;
}[RealtimeEventType];
