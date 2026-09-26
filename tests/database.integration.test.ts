import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { adminDb, commitEvents, createTrip, event, getTrip, type TripRow } from '../src/lib/db';
import { applyEvent } from '../src/lib/domain';
import { POST } from '../src/app/api/trips/[id]/commands/route';

const live = process.env.ROAMER_LIVE_TESTS === '1';
const created: string[] = [];
let token = '';
let owner = '';
const fixture = async (): Promise<TripRow> => { const t = await createTrip(owner, 'stress-careful'); created.push(t.id); return t; };
const send = async (tripId: string, body: Record<string, unknown>) => POST(new Request(`http://localhost/api/trips/${tripId}/commands`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: tripId }) });

describe.skipIf(!live)('live Supabase transaction and privacy checks', () => {
  beforeAll(async () => {
    config({ path: '.env.local', quiet: true });
    owner = process.env.ROAMER_USER_ID!;
    const workers = await adminDb().from('roamer_workers').select('heartbeat,status').eq('owner_id', owner);
    if (workers.error) throw Error('Cannot verify that the local worker is stopped before queue tests.');
    if (workers.data?.some(worker => worker.status !== 'offline' && Date.now() - Date.parse(worker.heartbeat) < 60000)) throw Error('Stop the local worker before running queue integration fixtures; these tests must not send messages to Grok.');
    const { data, error } = await adminDb().auth.signInWithPassword({ email: process.env.ROAMER_USER_EMAIL!, password: process.env.ROAMER_ACCESS_CODE! });
    if (error || !data.session) throw Error('Test account authentication unavailable');
    token = data.session.access_token;
  });
  afterAll(async () => {
    if (created.length) { const { error } = await adminDb().from('roamer_trips').delete().in('id', created); if (error) throw Error('Fixture cleanup failed'); }
  });
  it('commits accepted message and worker command once across duplicate requests', async () => {
    const t = await fixture(); const id = randomUUID();
    const replies = await Promise.all([send(t.id, { id, kind: 'message', text: 'Atomicity fixture, do not send to Grok.' }), send(t.id, { id, kind: 'message', text: 'Atomicity fixture, do not send to Grok.' })]);
    expect(replies.map(r => r.status)).toEqual([200, 200]);
    const db = adminDb(); const [{ data: events }, { data: commands }] = await Promise.all([db.from('roamer_events').select('id').eq('trip_id', t.id), db.from('roamer_commands').select('id').eq('trip_id', t.id)]);
    expect(events).toHaveLength(2); expect(commands).toHaveLength(1); expect((await getTrip(t.id)).state.messages).toHaveLength(1); expect((await getTrip(t.id)).state.actions).toMatchObject([{ id, status: 'queued', kind: 'conversation' }]);
  });
  it('accepts only one clicked/voice answer racing for the same question', async () => {
    const t = await fixture(); await commitEvents(t.id, current => [event(t.id, current.state.revision, 'question', { id: 'drive', prompt: 'Will you drive?', options: ['Yes', 'No'] })]);
    const replies = await Promise.all([send(t.id, { id: randomUUID(), kind: 'answer', questionId: 'drive', answer: 'No' }), send(t.id, { id: randomUUID(), kind: 'answer', questionId: 'drive', answer: 'Yes' })]);
    expect(replies.map(r => r.status).sort()).toEqual([200, 409]);
    const { data: commands } = await adminDb().from('roamer_commands').select('id').eq('trip_id', t.id); expect(commands).toHaveLength(1);
  });
  it('rolls back the event when command insertion fails', async () => {
    const t = await fixture(); const id = randomUUID(); const db = adminDb();
    await db.from('roamer_commands').insert({ id, trip_id: t.id, owner_id: owner, revision: 0, kind: 'conversation', payload: {}, status: 'done' });
    const e = event(t.id, 0, 'user_message', { text: 'Must roll back.' }, id);
    const { error } = await db.rpc('roamer_commit', { p_trip: t.id, p_expected_version: t.version, p_state: applyEvent(t.state, e), p_events: [e], p_command: { id, kind: 'conversation', payload: {} } });
    expect(error).toBeTruthy(); expect((await getTrip(t.id)).version).toBe(0);
    const { data: persisted } = await db.from('roamer_events').select('id').eq('id', id); expect(persisted).toEqual([]);
  });
  it('rejects a stale compare-and-swap without changing the current state', async () => {
    const t = await fixture(); await commitEvents(t.id, current => [event(t.id, current.state.revision, 'assistant_message', { text: 'Committed.' })]);
    const e = event(t.id, 0, 'assistant_message', { text: 'Stale.' }); const { data, error } = await adminDb().rpc('roamer_commit', { p_trip: t.id, p_expected_version: 0, p_state: applyEvent(t.state, e), p_events: [e] });
    expect(error).toBeNull(); expect(data).toBe(false); expect((await getTrip(t.id)).state.messages.map(m => m.text)).toEqual(['Committed.']);
  });
  it('rejects invalid trip dates before committing events or jobs', async () => {
    const t = await fixture(); const response = await send(t.id, { id: randomUUID(), kind: 'criteria', patch: { departureStart: '2026-10-10', departureEnd: '2026-10-01' } }); expect(response.status).toBe(400); expect((await getTrip(t.id)).version).toBe(0);
  });
  it('persists new revision on the queued command with a date change', async () => {
    const t = await fixture(); const id = randomUUID(); const response = await send(t.id, { id, kind: 'criteria', patch: { departureDate: '2026-10-12' } }); expect(response.status).toBe(200); const { data } = await adminDb().from('roamer_commands').select('revision').eq('id', id).single(); expect(data?.revision).toBe(1);
  });
  it('blocks anonymous trip reads and authenticated direct writes or privileged RPCs', async () => {
    const t = await fixture(); const url = process.env.NEXT_PUBLIC_SUPABASE_URL!; const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const anon = createClient(url, key, { auth: { persistSession: false } });
    const anonymous = await anon.from('roamer_trips').select('id').eq('id', t.id); expect(anonymous.data ?? []).toEqual([]);
    const signed = createClient(url, key, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
    const write = await signed.from('roamer_trips').update({ title: 'Forbidden update' }).eq('id', t.id).select('id'); expect(write.data ?? []).toEqual([]);
    const claim = await signed.rpc('roamer_claim'); expect(claim.error).toBeTruthy();
    const rate = await signed.rpc('roamer_login_attempt', { p_bucket: 'forbidden' }); expect(rate.error).toBeTruthy();
    expect((await getTrip(t.id)).title).not.toBe('Forbidden update');
  });
  it('rejects requests without authentication', async () => {
    const t = await fixture(); const response = await POST(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ id: randomUUID(), kind: 'message', text: 'No.' }) }), { params: Promise.resolve({ id: t.id }) }); expect(response.status).toBe(401); expect((await getTrip(t.id)).version).toBe(0);
  });
  it('does not disclose an existing trip to a different owner', async () => {
    const t = await fixture(); await expect(getTrip(t.id, randomUUID())).rejects.toMatchObject({ status: 404, message: 'Trip not found.' });
  });
});
