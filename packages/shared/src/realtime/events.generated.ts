// AUTO-GENERATED FROM apps/api's realtime document. DO NOT EDIT.
// Regenerate with: pnpm run generate

export type paths = Record<string, never>;
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    RealtimeEvent:
      | components['schemas']['ComponentCreatedEvent']
      | components['schemas']['ComponentDeletedEvent']
      | components['schemas']['ComponentOrderChangedEvent']
      | components['schemas']['ComponentUpdatedEvent']
      | components['schemas']['DeckCreatedEvent']
      | components['schemas']['DeckDeletedEvent']
      | components['schemas']['DeckImportFinishedEvent']
      | components['schemas']['DeckImportStartedEvent']
      | components['schemas']['DeckUpdatedEvent']
      | components['schemas']['FileDeletedEvent']
      | components['schemas']['FileMovedEvent']
      | components['schemas']['FileUpdatedEvent']
      | components['schemas']['FileUploadedEvent']
      | components['schemas']['FileVersionCreatedEvent']
      | components['schemas']['FolderCreatedEvent']
      | components['schemas']['FolderDeletedEvent']
      | components['schemas']['FolderUpdatedEvent']
      | components['schemas']['MembersChangedEvent']
      | components['schemas']['ModelUpdatedEvent']
      | components['schemas']['ProjectDeletedEvent']
      | components['schemas']['ProjectUpdatedEvent'];
    /** @description Close codes a /ws socket can be closed with, beyond the standard RFC 6455 ones. 4401 (UNAUTHORIZED): credential revoked 4429 (REPLACED): replaced by a newer connection */
    RealtimeCloseCode: 4401 | 4429;
    ComponentCreatedEvent: {
      /** @constant */
      type: 'component_created';
      project_id: string;
      data: {
        actor_user_id: string;
        created_at: string;
        created_by: string;
        deleted_at: string | null;
        files: {
          file: {
            byte_size: number;
            component_id: string | null;
            component_role: string | null;
            content_type: string;
            created_at: string;
            deck_id: string | null;
            deleted_at: string | null;
            filename: string;
            folder_id: string | null;
            id: string;
            image_height: number | null;
            image_width: number | null;
            name_locked: boolean;
            project_id: string;
            updated_at: string;
            uploaded_by: string;
          };
          /** @enum {unknown} */
          role: 'artwork' | 'cut';
        }[];
        id: string;
        kind: string;
        missing_roles: ('artwork' | 'cut')[];
        name: string;
        position: number;
        project_id: string;
        settings:
          | {
              back_color: string;
              edge_color: string;
              height_mm: number;
              /** @constant */
              kind: 'punchboard';
              seed: number;
              /** @enum {unknown} */
              sheet_state: 'intact' | 'punched';
              thickness_mm: number;
              width_mm: number;
            }
          | {
              bevel_mm: number;
              grain_color: string;
              grain_scale: number;
              /** @constant */
              kind: 'wood';
              longest_side_mm: number;
              printed: boolean;
              seed: number;
              simplify_tolerance: number;
              thickness_mm: number;
              /** @enum {unknown} */
              trace_source: 'alpha' | 'luminance';
              trace_threshold: number;
              wood_color: string;
            }
          | {
              corner_bevel_mm: number;
              depth_mm: number;
              height_mm: number;
              /** @constant */
              kind: 'box';
              seed: number;
              width_mm: number;
            }
          | {
              edge_color: string;
              /** @enum {unknown} */
              fold: 'bifold' | 'none' | 'quadfold';
              fold_gap_mm: number;
              height_mm: number;
              /** @constant */
              kind: 'board';
              seed: number;
              thickness_mm: number;
              width_mm: number;
            };
        updated_at: string;
      };
    };
    ComponentDeletedEvent: {
      /** @constant */
      type: 'component_deleted';
      project_id: string;
      data: {
        actor_user_id: string;
        created_at: string;
        created_by: string;
        deleted_at: string | null;
        files: {
          file: {
            byte_size: number;
            component_id: string | null;
            component_role: string | null;
            content_type: string;
            created_at: string;
            deck_id: string | null;
            deleted_at: string | null;
            filename: string;
            folder_id: string | null;
            id: string;
            image_height: number | null;
            image_width: number | null;
            name_locked: boolean;
            project_id: string;
            updated_at: string;
            uploaded_by: string;
          };
          /** @enum {unknown} */
          role: 'artwork' | 'cut';
        }[];
        id: string;
        kind: string;
        missing_roles: ('artwork' | 'cut')[];
        name: string;
        position: number;
        project_id: string;
        purged: boolean;
        settings:
          | {
              back_color: string;
              edge_color: string;
              height_mm: number;
              /** @constant */
              kind: 'punchboard';
              seed: number;
              /** @enum {unknown} */
              sheet_state: 'intact' | 'punched';
              thickness_mm: number;
              width_mm: number;
            }
          | {
              bevel_mm: number;
              grain_color: string;
              grain_scale: number;
              /** @constant */
              kind: 'wood';
              longest_side_mm: number;
              printed: boolean;
              seed: number;
              simplify_tolerance: number;
              thickness_mm: number;
              /** @enum {unknown} */
              trace_source: 'alpha' | 'luminance';
              trace_threshold: number;
              wood_color: string;
            }
          | {
              corner_bevel_mm: number;
              depth_mm: number;
              height_mm: number;
              /** @constant */
              kind: 'box';
              seed: number;
              width_mm: number;
            }
          | {
              edge_color: string;
              /** @enum {unknown} */
              fold: 'bifold' | 'none' | 'quadfold';
              fold_gap_mm: number;
              height_mm: number;
              /** @constant */
              kind: 'board';
              seed: number;
              thickness_mm: number;
              width_mm: number;
            };
        updated_at: string;
      };
    };
    ComponentOrderChangedEvent: {
      /** @constant */
      type: 'component_order_changed';
      project_id: string;
      data: {
        actor_user_id: string;
        components: {
          created_at: string;
          created_by: string;
          deleted_at: string | null;
          files: {
            file: {
              byte_size: number;
              component_id: string | null;
              component_role: string | null;
              content_type: string;
              created_at: string;
              deck_id: string | null;
              deleted_at: string | null;
              filename: string;
              folder_id: string | null;
              id: string;
              image_height: number | null;
              image_width: number | null;
              name_locked: boolean;
              project_id: string;
              updated_at: string;
              uploaded_by: string;
            };
            /** @enum {unknown} */
            role: 'artwork' | 'cut';
          }[];
          id: string;
          kind: string;
          missing_roles: ('artwork' | 'cut')[];
          name: string;
          position: number;
          project_id: string;
          settings:
            | {
                back_color: string;
                edge_color: string;
                height_mm: number;
                /** @constant */
                kind: 'punchboard';
                seed: number;
                /** @enum {unknown} */
                sheet_state: 'intact' | 'punched';
                thickness_mm: number;
                width_mm: number;
              }
            | {
                bevel_mm: number;
                grain_color: string;
                grain_scale: number;
                /** @constant */
                kind: 'wood';
                longest_side_mm: number;
                printed: boolean;
                seed: number;
                simplify_tolerance: number;
                thickness_mm: number;
                /** @enum {unknown} */
                trace_source: 'alpha' | 'luminance';
                trace_threshold: number;
                wood_color: string;
              }
            | {
                corner_bevel_mm: number;
                depth_mm: number;
                height_mm: number;
                /** @constant */
                kind: 'box';
                seed: number;
                width_mm: number;
              }
            | {
                edge_color: string;
                /** @enum {unknown} */
                fold: 'bifold' | 'none' | 'quadfold';
                fold_gap_mm: number;
                height_mm: number;
                /** @constant */
                kind: 'board';
                seed: number;
                thickness_mm: number;
                width_mm: number;
              };
          updated_at: string;
        }[];
        kind: string;
      };
    };
    ComponentUpdatedEvent: {
      /** @constant */
      type: 'component_updated';
      project_id: string;
      data: {
        actor_user_id: string;
        created_at: string;
        created_by: string;
        deleted_at: string | null;
        files: {
          file: {
            byte_size: number;
            component_id: string | null;
            component_role: string | null;
            content_type: string;
            created_at: string;
            deck_id: string | null;
            deleted_at: string | null;
            filename: string;
            folder_id: string | null;
            id: string;
            image_height: number | null;
            image_width: number | null;
            name_locked: boolean;
            project_id: string;
            updated_at: string;
            uploaded_by: string;
          };
          /** @enum {unknown} */
          role: 'artwork' | 'cut';
        }[];
        id: string;
        kind: string;
        missing_roles: ('artwork' | 'cut')[];
        name: string;
        position: number;
        project_id: string;
        settings:
          | {
              back_color: string;
              edge_color: string;
              height_mm: number;
              /** @constant */
              kind: 'punchboard';
              seed: number;
              /** @enum {unknown} */
              sheet_state: 'intact' | 'punched';
              thickness_mm: number;
              width_mm: number;
            }
          | {
              bevel_mm: number;
              grain_color: string;
              grain_scale: number;
              /** @constant */
              kind: 'wood';
              longest_side_mm: number;
              printed: boolean;
              seed: number;
              simplify_tolerance: number;
              thickness_mm: number;
              /** @enum {unknown} */
              trace_source: 'alpha' | 'luminance';
              trace_threshold: number;
              wood_color: string;
            }
          | {
              corner_bevel_mm: number;
              depth_mm: number;
              height_mm: number;
              /** @constant */
              kind: 'box';
              seed: number;
              width_mm: number;
            }
          | {
              edge_color: string;
              /** @enum {unknown} */
              fold: 'bifold' | 'none' | 'quadfold';
              fold_gap_mm: number;
              height_mm: number;
              /** @constant */
              kind: 'board';
              seed: number;
              thickness_mm: number;
              width_mm: number;
            };
        updated_at: string;
      };
    };
    DeckCreatedEvent: {
      /** @constant */
      type: 'deck_created';
      project_id: string;
      data: {
        actor_user_id: string;
        back_file_id: string | null;
        card_count: number;
        card_height_mm: number;
        card_width_mm: number;
        created_at: string;
        created_by: string;
        deleted_at: string | null;
        id: string;
        name: string;
        project_id: string;
        total_copies: number;
        updated_at: string;
      };
    };
    DeckDeletedEvent: {
      /** @constant */
      type: 'deck_deleted';
      project_id: string;
      data: {
        actor_user_id: string;
        back_file_id: string | null;
        card_count: number;
        card_height_mm: number;
        card_width_mm: number;
        created_at: string;
        created_by: string;
        deleted_at: string | null;
        id: string;
        name: string;
        project_id: string;
        purged: boolean;
        total_copies: number;
        updated_at: string;
      };
    };
    DeckImportFinishedEvent: {
      /** @constant */
      type: 'deck_import_finished';
      project_id: string;
      data: {
        actor_user_id: string;
        deck_id: string;
        run: {
          counts: {
            added: number;
            pages: number;
            removed: number;
            restored: number;
            unchanged: number;
            updated: number;
          };
          finished_at: string | null;
          id: string;
          import_id: string;
          page_count: number;
          source_label: string | null;
          started_at: string;
          started_by: string;
          status: string;
        };
      };
    };
    DeckImportStartedEvent: {
      /** @constant */
      type: 'deck_import_started';
      project_id: string;
      data: {
        actor_user_id: string;
        deck_id: string;
        run: {
          counts: {
            added: number;
            pages: number;
            removed: number;
            restored: number;
            unchanged: number;
            updated: number;
          };
          finished_at: string | null;
          id: string;
          import_id: string;
          page_count: number;
          source_label: string | null;
          started_at: string;
          started_by: string;
          status: string;
        };
      };
    };
    DeckUpdatedEvent: {
      /** @constant */
      type: 'deck_updated';
      project_id: string;
      data: {
        actor_user_id: string;
        cards: {
          file: {
            byte_size: number;
            component_id: string | null;
            component_role: string | null;
            content_type: string;
            created_at: string;
            deck_id: string | null;
            deleted_at: string | null;
            filename: string;
            folder_id: string | null;
            id: string;
            image_height: number | null;
            image_width: number | null;
            name_locked: boolean;
            project_id: string;
            updated_at: string;
            uploaded_by: string;
          };
          file_id: string;
          position: number;
          quantity: number;
        }[];
        deck: {
          back_file_id: string | null;
          card_count: number;
          card_height_mm: number;
          card_width_mm: number;
          created_at: string;
          created_by: string;
          deleted_at: string | null;
          id: string;
          name: string;
          project_id: string;
          total_copies: number;
          updated_at: string;
        };
      };
    };
    FileDeletedEvent: {
      /** @constant */
      type: 'file_deleted';
      project_id: string;
      data: {
        actor_user_id: string;
        byte_size: number;
        component_id: string | null;
        component_role: string | null;
        content_type: string;
        created_at: string;
        deck_id: string | null;
        deleted_at: string | null;
        filename: string;
        folder_id: string | null;
        id: string;
        image_height: number | null;
        image_width: number | null;
        name_locked: boolean;
        project_id: string;
        purged: boolean;
        storage_used_bytes: number;
        updated_at: string;
        uploaded_by: string;
      };
    };
    FileMovedEvent: {
      /** @constant */
      type: 'file_moved';
      project_id: string;
      data: {
        actor_user_id: string;
        byte_size: number;
        component_id: string | null;
        component_role: string | null;
        content_type: string;
        created_at: string;
        deck_id: string | null;
        deleted_at: string | null;
        filename: string;
        folder_id: string | null;
        id: string;
        image_height: number | null;
        image_width: number | null;
        name_locked: boolean;
        project_id: string;
        updated_at: string;
        uploaded_by: string;
      };
    };
    FileUpdatedEvent: {
      /** @constant */
      type: 'file_updated';
      project_id: string;
      data: {
        actor_user_id: string;
        byte_size: number;
        component_id: string | null;
        component_role: string | null;
        content_type: string;
        created_at: string;
        deck_id: string | null;
        deleted_at: string | null;
        filename: string;
        folder_id: string | null;
        id: string;
        image_height: number | null;
        image_width: number | null;
        name_locked: boolean;
        project_id: string;
        updated_at: string;
        uploaded_by: string;
      };
    };
    FileUploadedEvent: {
      /** @constant */
      type: 'file_uploaded';
      project_id: string;
      data: {
        actor_user_id: string;
        byte_size: number;
        component_id: string | null;
        component_role: string | null;
        content_type: string;
        created_at: string;
        deck_id: string | null;
        deleted_at: string | null;
        filename: string;
        folder_id: string | null;
        id: string;
        image_height: number | null;
        image_width: number | null;
        name_locked: boolean;
        project_id: string;
        storage_used_bytes: number;
        updated_at: string;
        uploaded_by: string;
      };
    };
    FileVersionCreatedEvent: {
      /** @constant */
      type: 'file_version_created';
      project_id: string;
      data: {
        actor_user_id: string;
        file: {
          byte_size: number;
          component_id: string | null;
          component_role: string | null;
          content_type: string;
          created_at: string;
          deck_id: string | null;
          deleted_at: string | null;
          filename: string;
          folder_id: string | null;
          id: string;
          image_height: number | null;
          image_width: number | null;
          name_locked: boolean;
          project_id: string;
          updated_at: string;
          uploaded_by: string;
        };
        storage_used_bytes: number;
        version: {
          byte_size: number;
          checksum: string | null;
          content_type: string;
          created_at: string;
          created_by: string;
          file_id: string;
          image_height: number | null;
          image_width: number | null;
          is_current: boolean;
          version_number: number;
        };
      };
    };
    FolderCreatedEvent: {
      /** @constant */
      type: 'folder_created';
      project_id: string;
      data: {
        actor_user_id: string;
        created_at: string;
        id: string;
        name: string;
        parent_id: string | null;
        project_id: string;
        updated_at: string;
      };
    };
    FolderDeletedEvent: {
      /** @constant */
      type: 'folder_deleted';
      project_id: string;
      data: {
        actor_user_id: string;
        created_at: string;
        id: string;
        name: string;
        parent_id: string | null;
        project_id: string;
        purged: boolean;
        updated_at: string;
      };
    };
    FolderUpdatedEvent: {
      /** @constant */
      type: 'folder_updated';
      project_id: string;
      data: {
        actor_user_id: string;
        created_at: string;
        id: string;
        name: string;
        parent_id: string | null;
        project_id: string;
        updated_at: string;
      };
    };
    MembersChangedEvent: {
      /** @constant */
      type: 'members_changed';
      project_id: string;
      data: {
        actor_user_id: string;
        members: {
          email: string;
          is_creator: boolean;
          name: string;
          /** @enum {unknown} */
          role: 'editor' | 'viewer';
          user_id: string;
        }[];
      };
    };
    ModelUpdatedEvent: {
      /** @constant */
      type: 'model_updated';
      project_id: string;
      data: {
        actor_user_id: string;
        created_at: string;
        project_id: string;
        settings:
          | {
              back_color: string;
              back_file_id:
                | string
                | '00000000-0000-0000-0000-000000000000'
                | 'ffffffff-ffff-ffff-ffff-ffffffffffff'
                | null;
              bevel_mm: number;
              corner_radius_mm: number;
              height_mm: number;
              /** @constant */
              kind: 'card';
              seed: number;
              stock_color: string;
              thickness_mm: number;
              width_mm: number;
            }
          | {
              back_color: string;
              edge_color: string;
              height_mm: number;
              /** @constant */
              kind: 'punchboard';
              seed: number;
              /** @enum {unknown} */
              sheet_state: 'intact' | 'punched';
              thickness_mm: number;
              width_mm: number;
            }
          | {
              bevel_mm: number;
              grain_color: string;
              grain_scale: number;
              /** @constant */
              kind: 'wood';
              longest_side_mm: number;
              printed: boolean;
              seed: number;
              simplify_tolerance: number;
              thickness_mm: number;
              /** @enum {unknown} */
              trace_source: 'alpha' | 'luminance';
              trace_threshold: number;
              wood_color: string;
            }
          | {
              corner_bevel_mm: number;
              depth_mm: number;
              height_mm: number;
              /** @constant */
              kind: 'box';
              seed: number;
              width_mm: number;
            }
          | {
              edge_color: string;
              /** @enum {unknown} */
              fold: 'bifold' | 'none' | 'quadfold';
              fold_gap_mm: number;
              height_mm: number;
              /** @constant */
              kind: 'board';
              seed: number;
              thickness_mm: number;
              width_mm: number;
            };
        source_file_id: string;
        updated_at: string;
        updated_by: string;
      };
    };
    ProjectDeletedEvent: {
      /** @constant */
      type: 'project_deleted';
      project_id: string;
      data: {
        actor_user_id: string;
        id: string;
      };
    };
    ProjectUpdatedEvent: {
      /** @constant */
      type: 'project_updated';
      project_id: string;
      data: {
        actor_user_id: string;
        created_at: string;
        created_by: string;
        description: string | null;
        id: string;
        name: string;
        updated_at: string;
      };
    };
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;

// A discriminated union, so narrowing on event.type yields that event's data and
// an apply site never asserts a shape.
export type RealtimeEvent = components['schemas']['RealtimeEvent'];
export type RealtimeEventType = RealtimeEvent['type'];

// The set a client has to route on. A code added at a close site but not in the
// server's table reaches no client at all.
export type RealtimeCloseCode = components['schemas']['RealtimeCloseCode'];
