import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultCriteria } from '../lib/domain';
import { discover, searchFlights, type ProviderContext } from '../lib/providers';
import { pause, WorkPool } from '../lib/providers/pool';
import { writeFile } from 'node:fs/promises';

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn().mockResolvedValue(undefined), writeFile: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const context: ProviderContext = { id: 'cancel-test', criteria: { ...defaultCriteria, departureDate: '2026-10-10' }, destination: { name: 'Vienna', country: 'Austria', airport: 'VIE' } };

describe('provider scheduling and cancellation', () => {
  it('removes a cancelled queued search without launching it or taking a slot', async () => {
    const pool = new WorkPool(1); let release!: () => void;
    const first = pool.run(() => new Promise<void>(resolve => { release = resolve; }));
    const controller = new AbortController(); const work = vi.fn();
    const cancelled = pool.run(work, controller.signal); const rejection = expect(cancelled).rejects.toThrow('Date changed');
    controller.abort(new Error('Date changed')); await rejection;
    release(); await first;
    expect(await pool.run(async () => 'next')).toBe('next'); expect(work).not.toHaveBeenCalled();
  });
  it('never exceeds its limit when a newcomer arrives as an older job releases', async () => {
    const pool = new WorkPool(2); let active = 0, peak = 0;
    const releases: Array<() => void> = [];
    const work = async () => { active++; peak = Math.max(peak, active); await new Promise<void>(resolve => releases.push(resolve)); active--; };
    const jobs = [pool.run(work), pool.run(work), pool.run(work)];
    releases.shift()!(); jobs.push(pool.run(work));
    for (let i = 0; i < 12; i++) { await Promise.resolve(); releases.shift()?.(); }
    await Promise.all(jobs); expect(peak).toBe(2);
  });
  it('interrupts retry and poll delays as soon as criteria are cancelled', async () => {
    const controller = new AbortController(); const pending = pause(60000, controller.signal);
    const rejected = expect(pending).rejects.toThrow('New dates'); controller.abort(new Error('New dates')); await rejected;
  });
  it('cancels an in-flight dataset read and never repeats the actor launch', async () => {
    vi.stubEnv('APIFY_TOKEN', 'test-token');
    const controller = new AbortController(); let reading!: () => void;
    const readStarted = new Promise<void>(resolve => { reading = resolve; });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ data: { id: 'known-run', status: 'SUCCEEDED', defaultDatasetId: 'dataset' } }))
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        expect(init.signal).not.toBe(controller.signal);
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); reading();
      }));
    vi.stubGlobal('fetch', fetch);
    const pending = searchFlights({ ...context, signal: controller.signal }); const rejected = expect(pending).rejects.toThrow('Party changed');
    await readStarted; controller.abort(new Error('Party changed')); await rejected;
    expect(fetch.mock.calls.filter(call => call[1].method === 'POST')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('writes an ambiguous launch receipt without automatically launching again', async () => {
    vi.stubEnv('APIFY_TOKEN', 'test-token'); vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection closed')));
    await expect(searchFlights(context)).rejects.toThrow('Connection closed');
    expect(writeFile).toHaveBeenCalledWith('.roamer/evidence/cancel-test-failed.json', expect.stringContaining('"deliveryUnknown":true'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('searches the traveller’s interests without inventing hiking for a no-car trip', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key'); const fetch = vi.fn().mockResolvedValue(Response.json({ results: [] })); vi.stubGlobal('fetch', fetch);
    await discover({ ...context, criteria: { ...context.criteria, interests: ['art', 'cafés'], noCar: true } });
    const query = JSON.parse(fetch.mock.calls[0][1].body).query;
    expect(query).toContain('art, cafés'); expect(query).toContain('public transport without a car'); expect(query).not.toMatch(/hik|walk/i);
  });
});
