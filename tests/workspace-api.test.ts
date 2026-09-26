import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { initialState, type DomainEvent } from '../src/lib/domain';
import type { TripRow } from '../src/lib/db';
import { HttpError } from '../src/lib/errors';
import { GET as history, POST as create } from '../src/app/api/trips/route';
import { GET as debug, POST as note } from '../src/app/api/trips/[id]/debug/route';
const mock = vi.hoisted(() => ({ trip: undefined as TripRow | undefined, getTrip: vi.fn(), createTrip: vi.fn(), commitEvents: vi.fn(), filters: [] as unknown[][], events: [] as unknown[], commands: [] as unknown[], user: 'owner' }));
vi.mock('../src/lib/auth', () => ({ authenticatedUser: async () => ({ id: mock.user }), apiError: (error: { status?: number; message: string }) => Response.json({ error: error.message }, { status: error.status ?? 400 }) }));
vi.mock('../src/lib/db', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/db')>('../src/lib/db');
  return { ...actual, getTrip: mock.getTrip, getWebTrip: mock.getTrip, createTrip: mock.createTrip, commitEvents: mock.commitEvents, getWorkspace: async () => ({ bot_name: 'Personal Grok' }), getWorkerHealth: async () => ({ id: 'laptop:personal-bot', status: 'online', heartbeat: 'now', detail: 'Ready' }), adminDb: () => ({ from: (table: string) => {
    const query = { select: (value: string) => { mock.filters.push([table, 'select', value]); return query; }, eq: (key: string, value: unknown) => { mock.filters.push([table, key, value]); return query; }, order: () => query, limit: async (n: number) => { mock.filters.push([table, 'limit', n]); return { data: table === 'roamer_events' ? mock.events : table === 'roamer_commands' ? mock.commands : [], error: null }; } }; return query;
  } }) };
});
beforeEach(() => {
  vi.clearAllMocks(); mock.filters = []; mock.events = []; mock.commands = []; mock.user = 'owner';
  mock.trip = { id: randomUUID(), owner_id: 'owner', workspace_id: 'personal', bot_id: 'personal-bot', browser_bot_id: 'research-bot', title: 'Trip', state: initialState(), version: 0, is_replay: false, updated_at: new Date().toISOString() };
  mock.getTrip.mockImplementation(async (_id, owner) => { if (owner && owner !== mock.trip!.owner_id) throw new HttpError(404, 'Trip not found.'); return mock.trip; });
  mock.createTrip.mockResolvedValue(mock.trip); mock.commitEvents.mockImplementation(async (_id, make) => { make(mock.trip); return mock.trip; });
});
const ctx = () => ({ params: Promise.resolve({ id: mock.trip!.id }) });
const request = (body?: unknown, query = '') => new Request(`http://local/api/trips${query}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
it('defaults history to the personal workspace and authenticated owner', async () => { expect((await history(request())).status).toBe(200); expect(mock.filters).toContainEqual(['roamer_trips', 'workspace_id', 'personal']); expect(mock.filters).toContainEqual(['roamer_trips', 'owner_id', 'owner']); });
it('lets a tester explicitly open only a registered workspace history', async () => { await history(request(undefined, '?workspace=stress-careful')); expect(mock.filters).toContainEqual(['roamer_trips', 'workspace_id', 'stress-careful']); expect((await history(request(undefined, '?workspace=legacy'))).status).toBe(400); });
it('does not accept client supplied bot bindings', async () => { expect((await create(request({ workspace: 'personal', bot_id: 'someone-else' }))).status).toBe(400); expect(mock.createTrip).not.toHaveBeenCalled(); });
it('creates new trips with the owner and optional validated workspace', async () => { await create(request({})); expect(mock.createTrip).toHaveBeenCalledWith('owner', undefined); await create(request({ workspace: 'stress-friends' })); expect(mock.createTrip).toHaveBeenCalledWith('owner', 'stress-friends'); });
it('rejects cross-owner debug access before loading events or jobs', async () => { mock.user = 'other-owner'; expect((await debug(request(), ctx())).status).toBe(404); expect(mock.filters).toEqual([]); });
it('bounds and owner-scopes debug reads and reports the bound bot health', async () => {
  mock.events = [{ id: 'event', seq: 1, type: 'assistant_message', payload: { text: 'Hello', secret: 'do not expose' } }];
  mock.commands = [{ id: 'command', kind: 'browser', status: 'queued', created_at: '2026-09-26T12:00:00Z', updated_at: '2026-09-26T12:00:00Z', attempts: 0, payload: { purpose: 'price', token: 'do not expose' } }];
  const response = await debug(request(), ctx()); const result = await response.json(); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(mock.filters).toContainEqual(['roamer_events','owner_id','owner']); expect(mock.filters).toContainEqual(['roamer_events','limit',80]); expect(mock.filters).toContainEqual(['roamer_commands','limit',40]);
  expect(result.trip).toMatchObject({ workspaceId: 'personal', botId: 'personal-bot', browserBotId: 'research-bot' }); expect(result.worker.id).toBe('laptop:personal-bot'); expect(result.commands[0].botId).toBe('research-bot'); expect(JSON.stringify(result)).not.toContain('do not expose');
});
it('saves critique as a debug event without creating a Grok command', async () => { const response = await note(request({ note: ' The results arrived late. ', clientAt: '2026-09-26T12:00:00Z' }), ctx()); expect(response.status).toBe(200); const call = mock.commitEvents.mock.calls[0]; expect(call).toHaveLength(2); const batch: DomainEvent[] = call[1](mock.trip); expect(batch).toHaveLength(1); expect(batch[0]).toMatchObject({ type: 'debug_note', tripId: mock.trip!.id, payload: { note: 'The results arrived late.' } }); });
it('rejects critique outside the owned trip and oversized input', async () => { mock.user = 'other-owner'; expect((await note(request({ note: 'No' }), ctx())).status).toBe(404); mock.user = 'owner'; expect((await note(request({ note: 'x'.repeat(2001) }), ctx())).status).toBe(400); expect(mock.commitEvents).not.toHaveBeenCalled(); });
it('keeps earlier shared-bot conversations read-only', async () => { mock.trip!.workspace_id = 'legacy'; expect((await note(request({ note: 'No' }), ctx())).status).toBe(409); expect(mock.commitEvents).not.toHaveBeenCalled(); });
it('stores bounded timings with feedback on the same owned trip', async () => { const metric = { type: 'interaction', tripId: mock.trip!.id, ms: 23, version: 0 }; expect((await note(request({ note: 'The click felt quick.', observedVersion: 0, browserMetrics: [metric] }), ctx())).status).toBe(200); const events: DomainEvent[] = mock.commitEvents.mock.calls[0][1](mock.trip); expect(events[0].payload).toMatchObject({ observedVersion: 0, browserMetrics: [metric] }); });
it('rejects feedback timings from a different trip', async () => { expect((await note(request({ note: 'Wrong trip.', browserMetrics: [{ type: 'interaction', tripId: randomUUID(), ms: 10 }] }), ctx())).status).toBe(400); expect(mock.commitEvents).not.toHaveBeenCalled(); });
it('rejects feedback arrays larger than the bounded sample limit', async () => { const metric = { type: 'interaction', tripId: mock.trip!.id, ms: 10 }; expect((await note(request({ note: 'Too many.', browserMetrics: Array(31).fill(metric) }), ctx())).status).toBe(400); expect(mock.commitEvents).not.toHaveBeenCalled(); });
it('reads debug evidence from the canonical trip behind a fixed link', async () => {
  const oldLink = randomUUID(); const result = await (await debug(request(), { params: Promise.resolve({ id: oldLink }) })).json();
  expect(result.trip.id).toBe(mock.trip!.id); expect(mock.filters).toContainEqual(['roamer_events','trip_id',mock.trip!.id]); expect(mock.filters).not.toContainEqual(['roamer_events','trip_id',oldLink]);
});
it('rejects feedback from an old tab after a reset instead of carrying it into the fresh trip', async () => { expect((await note(request({ note: 'Old trip feedback.' }), { params: Promise.resolve({ id: randomUUID() }) })).status).toBe(409); expect(mock.commitEvents).not.toHaveBeenCalled(); });
