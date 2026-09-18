// The stack behind a file: appending to it, restoring from it, reading it back.

export const guards = [
  {
    name: 'the storage meter counts every version, not just the current one',
    file: 'src/services/files.ts',
    // Summing the mirror counts each file once, at its newest size, so the
    // meter drifts further from the truth with every version that is kept.
    find: "eb.fn.sum<string>('file_version.byte_size')",
    replace: "eb.fn.sum<string>('file.byte_size')",
    tests: ['tests/e2e/fileVersions.test.ts'],
    testName: 'counts every version against the project quota',
  },
  {
    name: 'a restore copies the object forward rather than re-pointing at the old one',
    file: 'src/routes/files.ts',
    // Two versions naming one object means deleting either takes the other's
    // bytes. The unique index on file_version.storage_key is what turns this
    // into a constraint failure instead of silent aliasing.
    find: '    const destinationKey = newId();',
    replace: '    const destinationKey = source.storage_key;',
    tests: ['tests/e2e/fileVersions.test.ts'],
    testName: 'restores an older version by appending a copy',
  },
  {
    name: 'identical bytes do not create a version',
    file: 'src/services/files.ts',
    find: '  return current.checksum !== null && current.checksum === candidate.checksum;',
    replace: '  return false;',
    tests: ['tests/e2e/fileVersions.test.ts'],
    testName: 're-uploading identical bytes creates nothing',
  },
  {
    name: 'a superseded version listing cannot overwrite a newer one',
    file: 'src/lib/versions.svelte.ts',
    find: '      if (generation !== this.#generation) return;',
    replace: '      if (false) return;',
    tests: ['src/lib/versions.svelte.test.ts'],
    testName: 'discards a response that a newer request has already superseded',
    runner: 'web',
  },
  {
    name: 'the screen is told when identical bytes created nothing',
    file: 'src/lib/versions.svelte.ts',
    find: '    return body.created === true;',
    replace: '    return true;',
    tests: ['src/lib/versions.svelte.test.ts'],
    testName: 'reports that identical bytes created nothing',
    runner: 'web',
  },
  {
    // Both panes falling back to the current file makes every comparison look
    // like two copies of the same image.
    name: 'a comparison reads each side at its own version',
    file: 'src/routes/FileVersions.svelte',
    find: 'version={side.version_number}',
    replace: 'version={undefined}',
    tests: ['src/routes/FileVersions.svelte.test.ts'],
    testName: 'draws each side at its own version, not the current file',
    runner: 'web',
  },
];
