import { describe, expect, it } from 'vitest';
import { anonymous } from '../setup/testContext.ts';

describe('health', () => {
  it.each(['/health', '/'])('%s answers without a credential', async (path) => {
    const res = await anonymous.get(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', name: 'three-peaks' });
  });

  // The reason the fields are there: a deployed pod has to be able to say which
  // build it is without anyone reading a workflow log.
  it('names the build it is running', async () => {
    const body = await (await anonymous.get('/health')).json();
    expect(body.branch).toBeTruthy();
    expect(body.commit).toMatch(/^[0-9a-f]{7}$/);
    expect(body.environment).toBe('test');
  });

  // A readiness probe that answers ok without touching the database puts a pod
  // that cannot serve one request back into the load balancer's rotation.
  it('reaches the database rather than answering from memory alone', async () => {
    const { healthCheck } = await import('../../src/routes/health.ts');
    const broken = {
      get: (key: string) =>
        key === 'db'
          ? {
              executeQuery: () => Promise.reject(new Error('connection refused')),
            }
          : undefined,
      json: (body: unknown, status?: number) => ({ body, status: status ?? 200 }),
    };

    const result = (await healthCheck(broken as never)) as unknown as {
      body: { status: string; branch: string | null };
      status: number;
    };

    expect(result.status).toBe(503);
    expect(result.body.status).toBe('unhealthy');
    // Still names the build: "which broken thing is this?" is the question a
    // 503 raises, so the answer has to survive the failure.
    expect(result.body.branch).toBeTruthy();
  });
});
