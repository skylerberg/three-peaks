// Uploading a file, what it is, where it lives, and the screens that list it.

export const guards = [
  {
    // homeColumns writes all four columns every time, and the CHECK 0010 added
    // is what turns a partial write into a refusal rather than a row that is in
    // two places. Leaving the old folder behind is the way to write one.
    name: 'a file arriving in a deck leaves its folder behind',
    file: 'src/services/fileHome.ts',
    find:
      '      return { folder_id: null, deck_id: home.deckId, ' +
      'component_id: null, component_role: null };',
    replace:
      '      return { deck_id: home.deckId, component_id: null, component_role: null } as HomeColumns;',
    tests: ['tests/e2e/fileHomes.test.ts'],
    testName: 'leaves the folder behind when a file moves out of Assets into a deck',
  },
  {
    // The whole of what makes Assets the owner-less case. Dropping it puts every
    // card of every deck back in the explorer, which is the duplication the
    // sections exist to remove -- and it reads as a harmless filter to delete.
    name: 'Assets lists nothing a deck or a component holds',
    file: 'src/routes/files.ts',
    find: "        .where('file.deleted_at', 'is', null)\n        .where(unowned)",
    replace: "        .where('file.deleted_at', 'is', null)",
    tests: ['tests/e2e/components.test.ts'],
    testName: 'keeps its artwork out of the Assets listing',
  },
  {
    name: 'the upload content type comes from magic bytes, not the client',
    file: 'src/services/files.ts',
    find: "    contentType: sniffed ?? 'application/octet-stream',",
    replace: '    contentType: declaredContentType,',
    tests: ['tests/e2e/files.test.ts'],
    testName: 'decides the content type by magic bytes',
  },
  {
    name: 'an upload declaring an oversized length never starts',
    file: 'src/routes/files.ts',
    // Without this the body is read to the cap and refused there, which costs
    // the whole transfer and can no longer say how big the file was.
    find:
      '    assertUploadSize(declaredLength);\n' +
      '    if (declaredLength > 0) await assertQuota(c, projectId, declaredLength);',
    replace: '    if (declaredLength > 0) await assertQuota(c, projectId, declaredLength);',
    tests: ['tests/e2e/files.test.ts'],
    testName: 'refuses an upload whose declared length is over the limit',
  },
  {
    name: 'an oversized upload is refused before it is sent',
    file: 'src/lib/upload.ts',
    find: '  if (byteSize > MAX_UPLOAD_BYTES) {',
    replace: '  if (false) {',
    tests: ['src/lib/files.svelte.test.ts'],
    testName: 'refuses a file over the limit without sending it',
    runner: 'web',
  },
  {
    name: 'a refused upload reaches the screen as what the API said',
    file: 'src/lib/upload.ts',
    // apiMessage shows an ApiError and nothing else, so the plain Error the
    // explorer threw before reached the toast as "could not reach the server".
    find: '  if (!response.ok) throw new ApiError(response.status, body.error ?? fallback, body);',
    replace: '  if (!response.ok) throw new Error(body.error ?? fallback);',
    tests: ['src/lib/files.svelte.test.ts'],
    testName: 'carries the refusal the API wrote out to the caller',
    runner: 'web',
  },
  {
    name: 'the upload cap does not leave its refusal unhandled',
    file: 'src/services/files.ts',
    // Without the listener the cap emits on a stream nothing is watching yet,
    // which is an uncaught exception rather than a 413.
    find: "  counted.on('error', () => {});",
    replace: '  void counted;',
    tests: ['src/services/files.test.ts'],
    testName: 'refuses a body past the cap',
  },
  {
    name: 'RIFF that is not WebP is not an image',
    file: 'src/services/imageSniff.ts',
    find: 'startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)',
    replace: 'true',
    tests: ['src/services/imageSniff.test.ts'],
    testName: 'does not accept RIFF without the WEBP tag',
  },
  {
    name: 'a superseded directory load does not overwrite a newer one',
    file: 'src/lib/files.svelte.ts',
    find: '      if (generation !== this.#generation) return;',
    replace: '      if (false) return;',
    tests: ['src/lib/files.svelte.test.ts'],
    testName: 'discards a response that a newer request has already superseded',
    runner: 'web',
  },
  {
    name: 'an html page containing an inline svg is not an svg',
    file: 'src/services/imageSniff.ts',
    find: '  return /^<svg[\\s/>]/i.test(skipXmlPreamble(text));',
    replace: "  return text.includes('<svg');",
    tests: ['src/services/imageSniff.test.ts'],
    testName: 'does not accept HTML with an inline svg element',
  },
  {
    name: 'the object URL outlives the click that reads it',
    file: 'src/lib/download.ts',
    // Only Chromium takes its blob reference during the click's synchronous
    // dispatch, so a same-task revoke passes every check run against it and
    // downloads nothing in Firefox and WebKit.
    find: '  setTimeout(() => URL.revokeObjectURL(url), 0);',
    replace: '  URL.revokeObjectURL(url);',
    tests: ['src/lib/download.test.ts'],
    testName: 'defers revoking the object URL until after the click',
    runner: 'web',
  },
  {
    name: 'a thumbnail presents the credential its bytes are behind',
    file: 'src/components/Thumbnail.svelte',
    // Exactly the shape the `<img src>` this replaced had: a request the
    // browser makes on its own carries no Authorization header, and every
    // thumbnail in the explorer answered 401.
    find:
      '        const response = await fetch(`/api/files/${id}/download${query}`, {\n' +
      '          headers: authHeader(),\n' +
      '        });',
    replace: '        const response = await fetch(`/api/files/${id}/download${query}`);',
    tests: ['src/components/Thumbnail.svelte.test.ts'],
    testName: 'reads the bytes with the credential and shows them',
    runner: 'web',
  },
  {
    // Reading the prop straight is what every other component here does, and it
    // looks like a needless indirection to take out. Inside a keyed each the
    // prop is a getter over the row, so the effect subscribes to the row and one
    // copy count edit blanks and re-reads every image in the deck.
    name: 'an identity-only prop change does not re-read a thumbnail',
    file: 'src/components/Thumbnail.svelte',
    find: '    const id = currentFileId;',
    replace: '    const id = fileId;',
    tests: ['src/routes/Deck.svelte.test.ts'],
    testName: 'does not reload the thumbnails when a copy count changes',
    runner: 'web',
  },
  {
    // The listing is ordered by the server. Appending instead of inserting puts
    // the row in the wrong place until the next load, which is exactly the kind
    // of drift that made patching look riskier than reloading.
    name: 'a row applied to the listing lands where a reload would have put it',
    file: 'src/lib/files.svelte.ts',
    find: '    next.sort((a, b) => key(a).localeCompare(key(b)));',
    replace: '    void key;',
    tests: ['src/lib/files.svelte.test.ts'],
    testName: 'inserts an uploaded file in the order the listing is sorted in',
    runner: 'web',
  },
  {
    // The folder on screen going away is the one event this store cannot
    // absorb. Answering true leaves the explorer showing a folder that has
    // stopped existing.
    name: 'a deleted open folder falls back to a reload',
    file: 'src/lib/files.svelte.ts',
    find: '        if (listing.folder?.id === gone || listing.breadcrumb.some((entry) => entry.id === gone)) {\n          return false;\n        }',
    replace: '        void gone;',
    tests: ['src/lib/files.svelte.test.ts'],
    testName: 'asks for a reload when the folder being shown is deleted',
    runner: 'web',
  },
];
