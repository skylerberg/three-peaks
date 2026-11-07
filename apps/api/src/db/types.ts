// Hand-written, and what the app imports. It re-exports the generated module
// and is the place any branding or override goes — so a regeneration never
// clobbers a deliberate type decision.
import type { CardFields, ImportRunSummary, LayoutSpec, ModelSettings } from '@three-peaks/shared';
import type {
  CardContent as GeneratedCardContent,
  CardLayout as GeneratedCardLayout,
  ComponentModel as GeneratedComponentModel,
  DB as GeneratedDB,
  ImportRun as GeneratedImportRun,
} from './types.generated.ts';

export type * from './types.generated.ts';

// Introspection can only see `jsonb`, so the generated column is an untyped
// `Json`. The shape is the one ArkType validated on the way in, and saying so
// here is what stops every read from re-narrowing a value the API already
// guarantees.
/** @public -- exported to shadow the generated interface of the same name. */
export interface ComponentModel extends Omit<GeneratedComponentModel, 'settings'> {
  settings: ModelSettings;
}

/** @public -- exported to shadow the generated interface of the same name. */
export interface ImportRun extends Omit<GeneratedImportRun, 'summary'> {
  summary: ImportRunSummary | null;
}

/** @public -- exported to shadow the generated interface of the same name. */
export interface CardLayout extends Omit<GeneratedCardLayout, 'spec'> {
  spec: LayoutSpec;
}

/** @public -- exported to shadow the generated interface of the same name. */
export interface CardContent extends Omit<GeneratedCardContent, 'fields'> {
  fields: CardFields;
}

export interface DB extends Omit<
  GeneratedDB,
  'card_content' | 'card_layout' | 'component_model' | 'import_run'
> {
  card_content: CardContent;
  card_layout: CardLayout;
  component_model: ComponentModel;
  import_run: ImportRun;
}
