import { beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { applyEvent, initialState, type DomainEvent } from '../src/lib/domain';
import { POST } from '../src/app/api/trips/[id]/commands/route';
import type { QueuedCommand, TripRow } from '../src/lib/db';
const mock = vi.hoisted(() => ({ trip: undefined as TripRow | undefined, batches: [] as DomainEvent[][], commands: [] as QueuedCommand[], requestIds: [] as string[], prior: undefined as Record<string, unknown> | undefined }));
vi.mock('../src/lib/auth', () => ({ authenticatedUser: async () => ({ id: 'owner' }), apiError: (e: Error & { status?: number }) => Response.json({ error: e.message }, { status: e.status ?? 400 }) }));
vi.mock('../src/lib/db', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/db')>('../src/lib/db');
  return { ...actual, getTrip: async () => mock.trip, getWebTrip: async () => mock.trip, adminDb: () => {
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: mock.prior }) }; return { from: () => query };
  }, commitEvents: async (_id: string, make: (t: TripRow) => DomainEvent[], makeCommand: (t: TripRow) => QueuedCommand | null, requestId: string) => {
    const events = make(mock.trip!); mock.batches.push(events); const command = makeCommand(mock.trip!); if (command) mock.commands.push(command); mock.requestIds.push(requestId);
    mock.trip = { ...mock.trip!, state: events.reduce(applyEvent, mock.trip!.state), version: mock.trip!.version + events.length }; return mock.trip;
  } };
});
beforeEach(() => { mock.trip = { id: randomUUID(), owner_id: 'owner', workspace_id: 'personal', bot_id: 'personal-bot', browser_bot_id: null, title: 'Fixture', state: initialState(), version: 0, is_replay: false, updated_at: new Date().toISOString() }; mock.batches = []; mock.commands = []; mock.requestIds = []; mock.prior = undefined; });
async function send(command: Record<string, unknown>) { return POST(new Request('http://local', { method: 'POST', body: JSON.stringify(command) }), { params: Promise.resolve({ id: mock.trip!.id }) }); }
it('accepts the request and queued feedback in the same transaction as the command', async () => {
  const id = randomUUID(); expect((await send({ id, kind: 'message', text: 'Help us plan a trip.' })).status).toBe(200);
  expect(mock.batches).toHaveLength(1); expect(mock.batches[0].map(e => e.type)).toEqual(['user_message', 'action']);
  expect(mock.batches[0][0].id).toBe(id); expect(mock.batches[0][1].id).not.toBe(id);
  expect(mock.commands).toMatchObject([{ id, kind: 'conversation' }]); expect(mock.requestIds).toEqual([id]);
  expect(mock.trip!.state.actions).toMatchObject([{ id, status: 'queued', label: 'Waiting for Grok', provider: 'Grok' }]);
});
it('queues feedback at the updated trip revision after a date change', async () => {
  const id = randomUUID(); await send({ id, kind: 'criteria', patch: { departureDate: '2026-10-12' } });
  expect(mock.batches[0][1].revision).toBe(1); expect(mock.trip!.state.revision).toBe(1); expect(mock.trip!.state.actions[0].queuedAt).toBe(mock.batches[0][0].occurredAt);
});
it('does not show a waiting task for a save which requires no agent work', async () => {
  mock.trip!.state.candidates = [{ id: 'krakow', name: 'Kraków', country: 'Poland', airport: 'KRK', image: '', summary: '', highlights: [], sources: [], status: 'researching' }];
  await send({ id: randomUUID(), kind: 'save', candidateId: 'krakow', saved: true }); expect(mock.commands).toEqual([]); expect(mock.trip!.state.actions).toEqual([]);
});
it('shows the appropriate provider and destination for a retried search', async () => {
  mock.prior = { kind: 'research', status: 'error', revision: 0, payload: { kind: 'stays', destination: { name: 'Kraków' } } };
  const id = randomUUID(); await send({ id, kind: 'retry', actionId: randomUUID() });
  expect(mock.trip!.state.actions).toMatchObject([{ id, status: 'queued', kind: 'stays', provider: 'Apify', label: 'Waiting to check stays in Kraków', destination: 'Kraków' }]);
});
it('rejects new work on an earlier shared-bot trip without creating an event or command', async () => {
  mock.trip!.workspace_id = 'legacy';
  expect((await send({ id: randomUUID(), kind: 'message', text: 'New work' })).status).toBe(409);
  expect(mock.commands).toEqual([]); expect(mock.batches).toEqual([]);
});
it('queues a deliberate requirement correction with the updated revision and exact text', async () => {
  mock.trip!.state = applyEvent(mock.trip!.state, { id: 'original', tripId: mock.trip!.id, type: 'user_message', payload: { text: 'Hotel entrance must be step-free and the room must have lift access.' }, revision: 0, occurredAt: new Date().toISOString() });
  const requirementId = mock.trip!.state.requirements![0].id; const id = randomUUID();
  expect((await send({ id, kind: 'requirement', requirementId, text: 'Step-free entrance and a confirmed ground-floor room.' })).status).toBe(200);
  expect(mock.batches[0].map(event => event.type)).toEqual(['requirement_edit', 'action']); expect(mock.batches[0][1].revision).toBe(1); expect(mock.trip!.state.revision).toBe(1);
  expect(mock.trip!.state.requirements?.map(requirement => requirement.text)).toEqual(['Step-free entrance and a confirmed ground-floor room.']); expect(mock.commands[0].payload.text).toContain('Step-free entrance and a confirmed ground-floor room.');
});
it('rejects a requirement edit if the source is no longer active', async () => { expect((await send({ id: randomUUID(), kind: 'requirement', requirementId: 'missing', text: null })).status).toBe(404); expect(mock.commands).toEqual([]); });
it('rejects a stale tab writing through the fixed old link into the fresh trip', async () => {
  const oldLink = randomUUID();
  const response = await POST(new Request('http://local', { method: 'POST', body: JSON.stringify({ id: randomUUID(), kind: 'message', text: 'A fresh idea.' }) }), { params: Promise.resolve({ id: oldLink }) });
  expect(response.status).toBe(409); expect(mock.batches).toEqual([]); expect(mock.commands).toEqual([]);
});
it('rejects a mutation if the trip became archived after the initial read', async () => { mock.trip!.archived = true; expect((await send({ id: randomUUID(), kind: 'message', text: 'Stale tab' })).status).toBe(409); expect(mock.commands).toEqual([]); });
