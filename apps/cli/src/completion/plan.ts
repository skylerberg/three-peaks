import type { Argument, Command, Option } from 'commander';
import { CONFIG_KEYS } from '../config.ts';

export interface Candidate {
  value: string;
  description: string;
}

type ValueKind =
  | 'project'
  | 'deck'
  | 'card'
  | 'component'
  | 'member'
  | 'entry'
  | 'folder'
  | 'file'
  | 'run'
  | 'token'
  | 'session'
  | 'link';

// What the rest of the line already names, which is what a candidate list is
// scoped by: a deck's cards need the deck, and everything needs the project.
export interface PlanScope {
  project?: string;
  deck?: string;
  component?: string;
}

export type CompletionPlan =
  | { kind: 'none' }
  | { kind: 'files' }
  | { kind: 'static'; items: Candidate[] }
  | { kind: 'values'; valueKind: ValueKind; scope: PlanScope };

// Keyed by the placeholder that already appears in --help, so a new command
// reusing a placeholder gets completion without this table being touched.
const VALUE_KINDS: Record<string, ValueKind | 'path' | 'config-key'> = {
  project: 'project',
  deck: 'deck',
  card: 'card',
  component: 'component',
  member: 'member',
  entry: 'entry',
  folder: 'folder',
  parent: 'folder',
  file: 'file',
  run: 'run',
  token: 'token',
  session: 'session',
  link: 'link',
  path: 'path',
  paths: 'path',
  dir: 'path',
  key: 'config-key',
};

// The options that say where a reference lives, by the scope each one sets.
const SCOPE_OPTIONS: Record<string, keyof PlanScope> = {
  '--project': 'project',
  '--deck': 'deck',
  '--to-deck': 'deck',
  '--component': 'component',
  '--to-component': 'component',
};

const FILES_SENTINEL = ':files';

function dequoteWord(word: string): string {
  if (word.startsWith("'")) {
    return word.replace(/^'/, '').replace(/'$/, '');
  }
  if (word.startsWith('"')) {
    return word.replace(/^"/, '').replace(/"$/, '');
  }
  return word.replace(/\\(.)/g, '$1');
}

export function currentWord(words: string[]): string {
  return dequoteWord(words[words.length - 1] ?? '');
}

function findOption(cmd: Command, flag: string): Option | undefined {
  return cmd.options.find((option) => option.long === flag || option.short === flag);
}

function takesValue(option: Option): boolean {
  return option.required || option.optional || option.variadic;
}

function optionPlaceholder(option: Option): string | undefined {
  const match = /[<[]([^>\]]+)[>\]]/.exec(option.flags);
  return match?.[1].replace(/\.\.\.$/, '');
}

function staticFromChoices(choices: readonly string[]): CompletionPlan {
  return { kind: 'static', items: choices.map((value) => ({ value, description: '' })) };
}

function planForPlaceholder(placeholder: string | undefined, scope: PlanScope): CompletionPlan {
  const valueKind = placeholder == null ? undefined : VALUE_KINDS[placeholder];
  if (valueKind == null) {
    return { kind: 'none' };
  }
  if (valueKind === 'path') {
    return { kind: 'files' };
  }
  if (valueKind === 'config-key') {
    return staticFromChoices(Object.keys(CONFIG_KEYS));
  }
  return { kind: 'values', valueKind, scope };
}

function planForOption(option: Option, scope: PlanScope): CompletionPlan {
  if (option.argChoices != null) {
    return staticFromChoices(option.argChoices);
  }
  return planForPlaceholder(optionPlaceholder(option), scope);
}

function planForArgument(argument: Argument | undefined, scope: PlanScope): CompletionPlan {
  if (argument == null) {
    return { kind: 'none' };
  }
  if (argument.argChoices != null) {
    return staticFromChoices(argument.argChoices);
  }
  return planForPlaceholder(argument.name(), scope);
}

function argumentAt(cmd: Command, index: number): Argument | undefined {
  const args = cmd.registeredArguments;
  if (index < args.length) {
    return args[index];
  }
  const last = args[args.length - 1];
  return last?.variadic === true ? last : undefined;
}

// A positional argument named like a scope sets it too: `deck copies <deck>
// <card>` completes the card against the deck typed before it.
function positionalScope(cmd: Command, positionals: string[]): PlanScope {
  const scope: PlanScope = {};
  cmd.registeredArguments.forEach((argument, index) => {
    const value = positionals[index];
    if (value === undefined) return;
    const name = argument.name();
    if (name === 'project' || name === 'deck' || name === 'component') {
      scope[name] = value;
    }
  });
  return scope;
}

export function planCompletion(program: Command, words: string[]): CompletionPlan {
  if (words.length === 0) {
    return { kind: 'none' };
  }
  const dequoted = words.map(dequoteWord);
  const current = dequoted[dequoted.length - 1];

  let cmd = program;
  const positionals: string[] = [];
  let pendingOption: Option | null = null;
  const optionScope: PlanScope = {};

  for (const word of dequoted.slice(1, -1)) {
    if (pendingOption != null) {
      // bash 4/5 splits `--project=x` on COMP_WORDBREAKS into three words.
      if (word === '=') {
        continue;
      }
      const scopeKey = pendingOption.long == null ? undefined : SCOPE_OPTIONS[pendingOption.long];
      if (scopeKey !== undefined) {
        optionScope[scopeKey] = word;
      }
      pendingOption = null;
      continue;
    }
    if (word.startsWith('-')) {
      const eq = word.indexOf('=');
      if (eq !== -1) {
        const scopeKey = SCOPE_OPTIONS[word.slice(0, eq)];
        if (scopeKey !== undefined) {
          // The up-front dequoting skipped this word because it starts with a dash.
          optionScope[scopeKey] = dequoteWord(word.slice(eq + 1));
        }
        continue;
      }
      const option = findOption(cmd, word);
      if (option != null && takesValue(option)) {
        pendingOption = option;
      }
      continue;
    }
    const sub = cmd.commands.find((c) => c.name() === word || c.aliases().includes(word));
    if (sub != null && positionals.length === 0) {
      cmd = sub;
      continue;
    }
    positionals.push(word);
  }

  const scope: PlanScope = { ...positionalScope(cmd, positionals), ...optionScope };

  if (pendingOption != null) {
    return planForOption(pendingOption, scope);
  }

  const helper = program.createHelp();

  if (current.startsWith('-')) {
    if (current.includes('=')) {
      return { kind: 'none' };
    }
    return {
      kind: 'static',
      items: helper.visibleOptions(cmd).flatMap((option) => {
        const value = option.long ?? option.short;
        return value == null ? [] : [{ value, description: helper.optionDescription(option) }];
      }),
    };
  }

  if (cmd.commands.length > 0 && positionals.length === 0) {
    return {
      kind: 'static',
      items: helper.visibleCommands(cmd).map((sub) => ({
        value: sub.name(),
        description: helper.subcommandDescription(sub),
      })),
    };
  }

  return planForArgument(argumentAt(cmd, positionals.length), scope);
}

export function filterCandidates(items: Candidate[], current: string): Candidate[] {
  const prefix = current.toLowerCase();
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.value.toLowerCase().startsWith(prefix) || seen.has(item.value)) {
      return false;
    }
    seen.add(item.value);
    return true;
  });
}

function isControl(char: string): boolean {
  return char.charCodeAt(0) < 0x20;
}

// Tabs and newlines separate the fields of the wire format, so a value carrying
// one cannot round-trip and is dropped rather than silently truncated.
function usable(value: string): boolean {
  return value !== '' && value !== FILES_SENTINEL && ![...value].some(isControl);
}

function sanitize(description: string): string {
  return [...description]
    .map((char) => (isControl(char) ? ' ' : char))
    .join('')
    .trim();
}

export function formatCandidates(items: Candidate[]): string {
  return items
    .filter((item) => usable(item.value))
    .map((item) => `${item.value}\t${sanitize(item.description)}\n`)
    .join('');
}
