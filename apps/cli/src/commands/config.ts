import type { Command } from 'commander';
import { group, leaf, withCtx } from '../kit.ts';
import { CliError, EXIT } from '../errors.ts';
import {
  CONFIG_KEYS,
  configPath,
  normalizeBaseUrl,
  saveConfig,
  type ConfigKey,
} from '../config.ts';
import { resolveProject } from '../resolve.ts';
import type { CliDeps, RuntimeContext } from '../context.ts';

function storageKey(key: string): (typeof CONFIG_KEYS)[ConfigKey] {
  if (!(key in CONFIG_KEYS)) {
    throw new CliError(
      `Unknown config key "${key}"; valid keys: ${Object.keys(CONFIG_KEYS).join(', ')}`,
      EXIT.usage
    );
  }
  return CONFIG_KEYS[key as ConfigKey];
}

async function storedValue(
  ctx: RuntimeContext,
  storage: (typeof CONFIG_KEYS)[ConfigKey],
  value: string
): Promise<string> {
  switch (storage) {
    // Stored as the id, so renaming the project does not break the default.
    case 'default_project':
      return (await resolveProject(ctx, value)).id;
    case 'api_url':
      return normalizeBaseUrl(value, 'API URL');
    case 'web_url':
      return normalizeBaseUrl(value, 'web URL');
  }
}

export function registerConfig(program: Command, deps: CliDeps): void {
  const config = group('config', 'Manage CLI configuration');
  const keys = `one of: ${Object.keys(CONFIG_KEYS).join(', ')}`;

  config.addCommand(
    leaf('get')
      .description('Show one config value, or the whole config')
      .argument('[key]', keys)
      .action(
        withCtx(deps, async (ctx, _opts, key) => {
          if (key == null) {
            ctx.out.data(ctx.config, () => {
              for (const [display, storage] of Object.entries(CONFIG_KEYS)) {
                const value = ctx.config[storage];
                if (value != null) {
                  ctx.out.line(`${display} = ${value}`);
                }
              }
            });
            return;
          }
          const value = ctx.config[storageKey(key)];
          ctx.out.data(value ?? null, () => {
            if (value != null) {
              ctx.out.line(value);
            }
          });
        })
      )
  );

  config.addCommand(
    leaf('set')
      .description('Set a config value (default-project accepts an id or a name)')
      .argument('<key>', keys)
      .argument('<value>', 'value to store')
      .action(
        withCtx(deps, async (ctx, _opts, key, value) => {
          const storage = storageKey(key);
          const stored = await storedValue(ctx, storage, value);
          await saveConfig(ctx.configDir, { ...ctx.config, [storage]: stored });
          ctx.out.data({ [key]: stored }, () => ctx.out.line(`${key} = ${stored}`));
        })
      )
  );

  config.addCommand(
    leaf('unset')
      .description('Remove a config value')
      .argument('<key>', keys)
      .action(
        withCtx(deps, async (ctx, _opts, key) => {
          const storage = storageKey(key);
          const next = { ...ctx.config };
          delete next[storage];
          await saveConfig(ctx.configDir, next);
          ctx.out.data({ [key]: null }, () => ctx.out.line(`Unset ${key}`));
        })
      )
  );

  config.addCommand(
    leaf('path')
      .description('Print the config file path')
      .action(
        withCtx(deps, async (ctx) => {
          const path = configPath(ctx.configDir);
          ctx.out.data({ path }, () => ctx.out.line(path));
        })
      )
  );

  program.addCommand(config);
}
