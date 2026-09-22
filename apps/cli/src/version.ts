import manifest from '../package.json' with { type: 'json' };

// The package's own version, so `--version` and the user agent a session is
// listed under cannot drift from what was installed.
export const VERSION: string = manifest.version;
