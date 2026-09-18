import type { Command } from 'commander';
import { leaf, optString, withCtx } from '../kit.ts';
import { listProjects, resolveProject } from '../resolve.ts';
import { ApiError } from '../errors.ts';
import { realtimeUrl, watchEvents } from '../watch.ts';
import type { CliDeps } from '../context.ts';

export function registerWatch(program: Command, deps: CliDeps): void {
  program.addCommand(
    leaf('watch')
      .summary('Stream realtime events as newline-delimited JSON')
      .description(
        'Stream realtime events as newline-delimited JSON until interrupted. Events go to ' +
          'stdout, one compact JSON object per line; diagnostics go to stderr. Output is ' +
          'always NDJSON, so --json and --no-color have no effect here.'
      )
      .option(
        '--project <project>',
        'project id or name; without it every accessible project is followed and the configured default-project is ignored'
      )
      .action(
        withCtx(deps, async (ctx, opts) => {
          const ref = optString(opts, 'project');
          // Unlike every other command, an absent ref stays absent instead of
          // falling back to the configured default: silently narrowing a live
          // stream to one project is the exact failure this command exists to
          // debug.
          const scoped = ref == null ? null : await resolveProject(ctx, ref);
          const projectIds = scoped ? [scoped.id] : (await listProjects(ctx)).map((p) => p.id);
          const token = ctx.token;
          if (token == null) {
            throw new ApiError(401, 'Not authenticated');
          }

          const url = realtimeUrl(ctx.baseUrl);
          ctx.out.error(
            scoped
              ? `Watching "${scoped.name}" on ${url}`
              : `Watching ${projectIds.length} project(s) on ${url}`
          );

          const controller = new AbortController();
          const off = ctx.deps.onInterrupt?.(() => controller.abort());
          try {
            await watchEvents({
              url,
              token,
              projectId: scoped?.id ?? null,
              projectIds,
              listProjectIds: async () => (await listProjects(ctx)).map((p) => p.id),
              revalidateSession: async () => {
                try {
                  const result = await ctx.api.GET('/api/auth/me');
                  return result.response.status !== 401;
                } catch {
                  return true;
                }
              },
              emit: (line) => ctx.out.line(line),
              notify: (message) => ctx.out.error(message),
              signal: controller.signal,
            });
          } finally {
            off?.();
          }
        })
      )
  );
}
