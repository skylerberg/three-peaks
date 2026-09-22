import type { Command } from 'commander';
import type { components } from '@three-peaks/shared/api';
import { group, leaf, optString, withCtx, type Opts } from '../kit.ts';
import { ApiError, CliError, EXIT, assertDone, assertOk } from '../errors.ts';
import { confirmOrAbort, promptHidden, promptText, readStdinLines } from '../prompt.ts';
import { matchRef } from '../resolve.ts';
import { minute, shortId } from '../output.ts';
import type { CliDeps, RuntimeContext } from '../context.ts';

type User = components['schemas']['User'];
type Session = components['schemas']['SessionList']['sessions'][number];

async function resolveEmail(ctx: RuntimeContext, opts: Opts): Promise<string> {
  return optString(opts, 'email') ?? (await promptText(ctx, 'Email: '));
}

async function readPassword(
  ctx: RuntimeContext,
  stdinLines: string[] | null,
  lineIndex: number,
  label: string,
  confirmLabel?: string
): Promise<string> {
  if (stdinLines) {
    const line = stdinLines[lineIndex];
    if (line == null || line === '') {
      throw new CliError(`--password-stdin expected ${label.toLowerCase()} on stdin`, EXIT.usage);
    }
    return line;
  }
  const password = await promptHidden(ctx, `${label}: `);
  if (confirmLabel != null) {
    const again = await promptHidden(ctx, `${confirmLabel}: `);
    if (again !== password) {
      throw new CliError('Passwords do not match', EXIT.invalid);
    }
  }
  return password;
}

function printUser(ctx: RuntimeContext, user: User, prefix: string): void {
  ctx.out.data(user, () => {
    ctx.out.line(`${prefix} ${user.name} <${user.email}>`);
  });
}

function warnIfEnvToken(ctx: RuntimeContext): void {
  if (ctx.tokenFromEnv) {
    ctx.out.error('Warning: THREEPEAKS_TOKEN is set and will shadow the stored token');
  }
}

async function listSessions(ctx: RuntimeContext): Promise<Session[]> {
  return assertOk(await ctx.api.GET('/api/auth/sessions')).sessions;
}

export function registerAuth(program: Command, deps: CliDeps): void {
  program.addCommand(
    leaf('login')
      .description('Sign in and store the session token')
      .option('--email <email>', 'account email')
      .option('--password-stdin', 'read the password from the first line of stdin')
      .action(
        withCtx(deps, async (ctx, opts) => {
          const stdinLines = opts.passwordStdin === true ? await readStdinLines(ctx) : null;
          const email = await resolveEmail(ctx, opts);
          const password = await readPassword(ctx, stdinLines, 0, 'Password');
          let result;
          try {
            result = assertOk(await ctx.api.POST('/api/auth/login', { body: { email, password } }));
          } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
              throw new CliError(
                `Invalid email or password for ${email} at ${ctx.baseUrl}`,
                EXIT.auth
              );
            }
            throw err;
          }
          await ctx.credentials.set(ctx.baseUrl, result.token);
          warnIfEnvToken(ctx);
          printUser(ctx, result.user, 'Signed in as');
        })
      )
  );

  program.addCommand(
    leaf('logout')
      .description('End the current session and forget the stored token')
      .action(
        withCtx(deps, async (ctx) => {
          if (ctx.token != null && !ctx.tokenFromEnv) {
            try {
              await ctx.api.POST('/api/auth/logout');
            } catch {
              // Forget the local token even when the server is unreachable.
            }
          }
          await ctx.credentials.delete(ctx.baseUrl);
          // A token in the environment is not this command's to revoke: it may
          // be a personal access token some other script depends on.
          if (ctx.tokenFromEnv) {
            ctx.out.error('THREEPEAKS_TOKEN is set; unset it to stop using that token');
          }
          ctx.out.data({ logged_out: true }, () => ctx.out.line('Signed out'));
        })
      )
  );

  program.addCommand(
    leaf('signup')
      .description('Create an account and store the session token')
      .option('--email <email>', 'account email')
      .option('--name <name>', 'display name')
      .option('--password-stdin', 'read the password from the first line of stdin')
      .action(
        withCtx(deps, async (ctx, opts) => {
          const stdinLines = opts.passwordStdin === true ? await readStdinLines(ctx) : null;
          const email = await resolveEmail(ctx, opts);
          const name = optString(opts, 'name') ?? (await promptText(ctx, 'Name: '));
          const password = await readPassword(ctx, stdinLines, 0, 'Password', 'Confirm password');
          const result = assertOk(
            await ctx.api.POST('/api/auth/signup', {
              body: { id: crypto.randomUUID(), email, name, password },
            })
          );
          await ctx.credentials.set(ctx.baseUrl, result.token);
          warnIfEnvToken(ctx);
          printUser(ctx, result.user, 'Signed up as');
        })
      )
  );

  program.addCommand(
    leaf('whoami')
      .description('Show the signed-in account')
      .action(
        withCtx(deps, async (ctx) => {
          const user = assertOk(await ctx.api.GET('/api/auth/me'));
          printUser(ctx, user, 'Signed in as');
        })
      )
  );

  const account = group('account', 'Manage the signed-in account and its password');

  account.addCommand(
    leaf('change-password')
      .description('Change the password; every session stays signed in')
      .option('--password-stdin', 'read the current then the new password from two stdin lines')
      .action(
        withCtx(deps, async (ctx, opts) => {
          const stdinLines = opts.passwordStdin === true ? await readStdinLines(ctx) : null;
          const currentPassword = await readPassword(ctx, stdinLines, 0, 'Current password');
          const newPassword = await readPassword(
            ctx,
            stdinLines,
            1,
            'New password',
            'Confirm new password'
          );
          try {
            assertDone(
              await ctx.api.POST('/api/auth/change-password', {
                body: { current_password: currentPassword, new_password: newPassword },
              })
            );
          } catch (err) {
            // Only the re-entered password is wrong here; a dead session's 401
            // has to stay an ApiError so the caller still gets the login hint.
            if (
              err instanceof ApiError &&
              err.status === 401 &&
              err.message === 'Current password is incorrect'
            ) {
              throw new CliError('Incorrect current password', EXIT.auth);
            }
            throw err;
          }
          ctx.out.data({ changed: true }, () => ctx.out.line('Password changed'));
        })
      )
  );

  account.addCommand(
    leaf('forgot-password')
      .description('Email a password-reset link')
      .option('--email <email>', 'account email')
      .action(
        withCtx(deps, async (ctx, opts) => {
          const email = await resolveEmail(ctx, opts);
          try {
            assertDone(await ctx.api.POST('/api/auth/forgot-password', { body: { email } }));
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
              throw new CliError(`No account exists for ${email}`, EXIT.notFound);
            }
            throw err;
          }
          ctx.out.data({ sent: true }, () => ctx.out.line(`Reset link sent to ${email}`));
        })
      )
  );

  account.addCommand(
    leaf('reset-password')
      .description('Set a new password with the token from a reset link')
      .requiredOption('--token <token>', 'the token= value from the emailed link')
      .option('--password-stdin', 'read the new password from the first line of stdin')
      .action(
        withCtx(deps, async (ctx, opts) => {
          const stdinLines = opts.passwordStdin === true ? await readStdinLines(ctx) : null;
          const password = await readPassword(
            ctx,
            stdinLines,
            0,
            'New password',
            'Confirm new password'
          );
          try {
            assertDone(
              await ctx.api.POST('/api/auth/reset-password', {
                body: { token: optString(opts, 'token') ?? '', password },
              })
            );
          } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
              throw new CliError('That reset link is invalid or has expired', EXIT.auth);
            }
            throw err;
          }
          // The reset issues no session: it leaves every existing one signed in
          // and hands back nothing to store.
          ctx.out.data({ reset: true }, () =>
            ctx.out.line('Password reset. Sign in with: threepeaks login')
          );
        })
      )
  );

  program.addCommand(account);

  const session = group('session', 'List and end signed-in sessions');

  session.addCommand(
    leaf('list')
      .description('List active sessions, newest first; * marks this one')
      .action(
        withCtx(deps, async (ctx) => {
          const sessions = await listSessions(ctx);
          ctx.out.data(sessions, () => {
            ctx.out.table(
              ['', 'ID', 'CREATED', 'EXPIRES', 'CLIENT'],
              sessions.map((s) => [
                s.current ? '*' : '',
                shortId(s.id),
                minute(s.created_at),
                minute(s.expires_at),
                s.user_agent ?? '',
              ])
            );
          });
        })
      )
  );

  session.addCommand(
    leaf('revoke')
      .description('End one session; ending the current one signs this CLI out')
      .argument('<session>', 'session id or id prefix, as listed')
      .option('--force', 'skip the confirmation prompt')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const target = matchRef(
            ref,
            await listSessions(ctx),
            'session',
            (s) => s.id,
            (s) => s.user_agent ?? ''
          );
          await confirmOrAbort(
            ctx,
            target.current
              ? 'End this session? The CLI will be signed out.'
              : `End session ${shortId(target.id)} (${target.user_agent ?? 'unknown client'})?`,
            opts.force === true
          );
          assertDone(
            await ctx.api.DELETE('/api/auth/sessions/{id}', { params: { path: { id: target.id } } })
          );
          if (target.current && !ctx.tokenFromEnv) {
            await ctx.credentials.delete(ctx.baseUrl);
          }
          ctx.out.data({ revoked: true, id: target.id }, () =>
            ctx.out.line(`Ended session ${shortId(target.id)}`)
          );
        })
      )
  );

  program.addCommand(session);
}
