import { readFile } from 'node:fs/promises';
import { CliError, EXIT } from './errors.ts';
import { readAllStdin } from './prompt.ts';
import type { RuntimeContext } from './context.ts';

// Structural rather than an index signature, so the named settings interfaces
// in packages/shared are accepted as they are.
type Settings = { kind: string };

// A component's settings and a card's 3D dial-in are replaced whole on every
// save, so an edit starts from what is stored and changes only what was named.
// Each value is coerced by the type the stored one already has: the settings
// are a closed shape, so a key that is not in it is a typo rather than a field
// to add, and `kind` is the one thing an edit may never change.
export function applyAssignments<T extends Settings>(current: T, assignments: string[]): T {
  const next: Record<string, unknown> = { ...current };
  const stored = current as unknown as Record<string, unknown> & Settings;
  for (const assignment of assignments) {
    const eq = assignment.indexOf('=');
    if (eq <= 0) {
      throw new CliError(`Expected key=value, got "${assignment}"`, EXIT.usage);
    }
    const key = assignment.slice(0, eq).trim();
    const raw = assignment.slice(eq + 1).trim();
    next[key] = coerce(stored, key, raw);
  }
  return next as T;
}

function coerce(current: Record<string, unknown> & Settings, key: string, raw: string): unknown {
  if (key === 'kind') {
    throw new CliError(`A ${current.kind}'s kind cannot be changed`, EXIT.usage);
  }
  if (!(key in current)) {
    const keys = Object.keys(current)
      .filter((k) => k !== 'kind')
      .sort()
      .join(', ');
    throw new CliError(`No setting "${key}" on a ${current.kind}; one of: ${keys}`, EXIT.usage);
  }
  const existing = current[key];
  if (typeof existing === 'number') {
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value)) {
      throw new CliError(`${key} takes a number, not "${raw}"`, EXIT.invalid);
    }
    return value;
  }
  if (typeof existing === 'boolean') {
    if (/^(true|yes|on|1)$/i.test(raw)) return true;
    if (/^(false|no|off|0)$/i.test(raw)) return false;
    throw new CliError(`${key} takes true or false, not "${raw}"`, EXIT.invalid);
  }
  // `null` clears a nullable field whatever it holds now; the server is what
  // knows which fields are nullable, and refuses it on one that is not.
  if (raw === 'null' || (existing === null && raw === '')) {
    return null;
  }
  return raw;
}

export async function readSettingsFile(
  ctx: RuntimeContext,
  path: string
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(path === '-' ? await readAllStdin(ctx) : await readFile(path, 'utf8'));
  } catch (err) {
    throw new CliError(`Cannot read settings from ${path}: ${(err as Error).message}`, EXIT.usage);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliError(`${path} does not hold a JSON object`, EXIT.usage);
  }
  return parsed as Record<string, unknown>;
}

// A file is laid over what is stored rather than sent as-is, so a partial
// object is an edit and `kind` still cannot be changed by one.
export function mergeSettings<T extends Settings>(current: T, patch: Record<string, unknown>): T {
  if ('kind' in patch && patch.kind !== current.kind) {
    throw new CliError(
      `Those settings are for a ${String(patch.kind)}, not a ${current.kind}`,
      EXIT.invalid
    );
  }
  return { ...current, ...patch, kind: current.kind };
}

export function formatSettings(settings: Settings): string[] {
  return Object.entries(settings as Record<string, unknown>)
    .filter(([key]) => key !== 'kind')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key} = ${value === null ? 'null' : String(value)}`);
}
