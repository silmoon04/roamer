import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getTrip, getWebTrip } from '../src/lib/db';
import { initialState } from '../src/lib/domain';

const mock = vi.hoisted(() => ({ links: [] as Record<string, unknown>[], trips: [] as Record<string, unknown>[], reads: [] as string[], error: null as Error | null }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: (table: string) => {
  mock.reads.push(table); const filters: [string, unknown][] = [];
  const result = () => ({ data: (table === 'roamer_trip_links' ? mock.links : mock.trips).find(row => filters.every(([key, value]) => row[key] === value)) ?? null, error: mock.error });
  const query = { select: () => query, eq: (key: string, value: unknown) => { filters.push([key, value]); return query; }, single: async () => result(), maybeSingle: async () => result() }; return query;
} }) }));
beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.co'); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-only'); mock.error = null; mock.reads = [];
  mock.trips = [{ id: 'old', owner_id: 'owner', bot_id: 'old-bot', state: initialState(), archived: true }, { id: 'fresh', owner_id: 'owner', bot_id: 'fresh-bot', state: initialState(), archived: false }];
  mock.links = [{ source_trip_id: 'old', target_trip_id: 'fresh', owner_id: 'owner' }];
});
afterEach(() => vi.unstubAllEnvs());
it('resolves the fixed owned web URL to the fresh trip and fresh bot', async () => { expect(await getWebTrip('old', 'owner')).toMatchObject({ id: 'fresh', bot_id: 'fresh-bot', archived: false }); });
it('keeps internal worker lookup exact so old receipts cannot cross the reset', async () => { expect(await getTrip('old', 'owner')).toMatchObject({ id: 'old', bot_id: 'old-bot', archived: true }); expect(mock.reads).toEqual(['roamer_trips']); });
it('does not disclose a link or target to another owner', async () => { await expect(getWebTrip('old', 'another-owner')).rejects.toMatchObject({ status: 404 }); });
it('checks target ownership even for an inconsistent service-written link', async () => { mock.trips[1].owner_id = 'different-owner'; await expect(getWebTrip('old', 'owner')).rejects.toMatchObject({ status: 404 }); });
it('hides other archived history while permitting a direct current-trip URL', async () => { mock.links = []; await expect(getWebTrip('old', 'owner')).rejects.toMatchObject({ status: 404 }); expect((await getWebTrip('fresh', 'owner')).id).toBe('fresh'); });
it('fails closed if alias storage is unavailable instead of showing previous history', async () => { mock.error = new Error('Database unavailable'); await expect(getWebTrip('old', 'owner')).rejects.toThrow('Database unavailable'); expect(mock.reads).toEqual(['roamer_trip_links']); });
