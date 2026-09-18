// Tombstones: what a deleted row hides, what a purge reclaims.

export const guards = [
  {
    name: 'the directory listing hides what has been deleted',
    file: 'src/routes/files.ts',
    find: "        .where('file.project_id', '=', projectId)\n        .where('file.deleted_at', 'is', null)",
    replace: "        .where('file.project_id', '=', projectId)",
    tests: ['tests/e2e/softDelete.test.ts'],
    testName: 'hides a soft-deleted file from the directory listing',
  },
  {
    name: 'deleting a file keeps its bytes unless a purge was asked for',
    file: 'src/routes/files.ts',
    find: "  return query.purge === 'true';",
    replace: '  return true;',
    tests: ['tests/e2e/softDelete.test.ts'],
    testName: 'keeps every version and every stored object when a file is deleted',
  },
  {
    name: 'a deleted file refuses a new version instead of quietly gaining one',
    file: 'src/services/files.ts',
    find: '  if (file.deleted_at !== null) {',
    replace: '  if (false) {',
    tests: ['tests/e2e/softDelete.test.ts'],
    testName: 'refuses a new version for a deleted file',
  },
  {
    name: 'a purge reaches the tombstones inside the folder it is reclaiming',
    file: 'src/routes/files.ts',
    // The mutation ADDS a predicate rather than removing one. Every listing
    // filters tombstones, so adding it here is the plausible mistake -- and it
    // orphans every tombstoned file's objects with nothing left naming them.
    find: "            .where('file.id', 'in', fileIds)",
    replace:
      "            .where('file.id', 'in', fileIds)\n            .where('file.deleted_at', 'is', null)",
    tests: ['tests/e2e/softDelete.test.ts'],
    testName: 'purging a folder reclaims the objects of a tombstone inside it',
  },
  {
    name: 'a purge walks through the deleted folders inside what it is reclaiming',
    file: 'src/routes/files.ts',
    // The same plausible edit as the guard above, one construct higher, and it
    // leaks strictly more: the cascade still takes every row under a deleted
    // folder, so their objects are left with nothing naming them at all.
    find: "              .select(['f.id as id'])",
    replace:
      "              .select(['f.id as id'])\n              .where('f.deleted_at', 'is', null)",
    tests: ['tests/e2e/softDelete.test.ts'],
    testName: 'purging a folder reclaims the objects of a tombstone inside it',
  },
  {
    name: 'a superseded deleted listing cannot overwrite a newer one',
    file: 'src/lib/deleted.svelte.ts',
    find: '      if (generation !== this.#generation) return;',
    replace: '      if (false) return;',
    tests: ['src/lib/deleted.svelte.test.ts'],
    testName: 'discards a response that a newer request has already superseded',
    runner: 'web',
  },
];
