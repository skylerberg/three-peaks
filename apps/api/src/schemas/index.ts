// The OpenAPI schema-name registry reads this barrel, so a schema that is not
// re-exported here appears inline in the spec instead of as a named component —
// and the generated client gets an anonymous duplicate rather than a shared type.
export * from './auth.ts';
export * from './common.ts';
export * from './components.ts';
export * from './canvaApp.ts';
export * from './decks.ts';
export * from './files.ts';
export * from './imports.ts';
export * from './layouts.ts';
export * from './models.ts';
export * from './print.ts';
export * from './projects.ts';
