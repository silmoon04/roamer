import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getWorkerHealth } from '../src/lib/db';
const mock = vi.hoisted(() => ({ rows: [] as { id: string; status: string }[], error: null as Error | null, filters: [] as unknown[][] }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: () => {
  const query = { select: () => query, eq: (key: string, value: string) => { mock.filters.push([key, value]); return query; }, in: async (key: string, value: string[]) => { mock.filters.push([key, value]); return { data: mock.rows, error: mock.error }; } }; return query;
} }) }));
beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.co'); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-only'); mock.rows = []; mock.error = null; mock.filters = []; });
afterEach(() => vi.unstubAllEnvs());
it('uses the bound bot status even when another healthy worker process exists', async () => {
  mock.rows = [{ id: 'laptop', status: 'online' }, { id: 'laptop:personal', status: 'degraded' }];
  expect(await getWorkerHealth('owner', 'personal')).toEqual({ id: 'laptop:personal', status: 'degraded' });
  expect(mock.filters).toEqual([['owner_id', 'owner'], ['id', ['laptop:personal', 'laptop']]]);
});
it('falls back to process presence only before the bound bot has reported status', async () => { mock.rows = [{ id: 'laptop', status: 'starting' }]; expect((await getWorkerHealth('owner', 'personal'))?.status).toBe('starting'); });
it('reports missing health as unknown and propagates a query outage', async () => { expect(await getWorkerHealth('owner', 'personal')).toBeNull(); mock.error = new Error('Database unavailable'); await expect(getWorkerHealth('owner', 'personal')).rejects.toThrow('Database unavailable'); });
