import { sql } from 'kysely';
import type { Context } from 'hono';
import { buildInfo } from '../config/buildInfo.ts';
import { env } from '../config/env.ts';
import type { Connection, Variables } from '../types/index.ts';

// Answers what is running as well as whether it is running. The branch and
// commit are what tell two checkouts serving two ports apart in development,
// and what names the deployed build in production without reading a workflow
// log. Both are public and the commit is short: seven characters identify the
// build to someone who already has the repository, and little to anyone else.
//
// The database round trip is the point of the readiness half. Reporting ok
// without it puts a pod that cannot serve a single request back into the load
// balancer's rotation. Liveness is a TCP check rather than this one, so a
// database outage takes replicas out of rotation without restart-looping the
// whole deployment — infra/k8s/deployment.yaml says so at the probes.
export async function healthCheck(c: Context<{ Variables: Variables }>) {
  const build = buildInfo();
  const body = {
    name: 'three-peaks',
    environment: env.environment,
    branch: build.branch,
    commit: build.commit,
  };

  try {
    await ping(c.get('db'));
    return c.json({ status: 'ok', ...body });
  } catch {
    return c.json({ status: 'unhealthy', ...body }, 503);
  }
}

async function ping(db: Connection): Promise<void> {
  await sql`select 1`.execute(db);
}
