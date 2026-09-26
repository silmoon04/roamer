import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { adminDb } from '../src/lib/db';

const db = adminDb();
const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const fixtureIds: string[] = [];
const results: { check: string; passed: boolean; ms?: number }[] = [];
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: process.env.ROAMER_ACCESS_CODE }) });
assert.equal(login.status, 200, `Login status ${login.status}`);
const { session } = await login.json();
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };
async function api(path: string, body?: unknown) {
  const response = await fetch(base + path, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const data = await response.json(); assert.ok(response.ok, `${path}: status ${response.status}`); return data;
}
try {
  const started = Date.now();
  const personal = (await api('/api/trips', {})).trip; fixtureIds.push(personal.id);
  const stress = (await api('/api/trips', { workspace: 'stress-careful' })).trip; fixtureIds.push(stress.id);
  assert.equal(personal.workspace_id, 'personal'); assert.equal(stress.workspace_id, 'stress-careful'); assert.notEqual(personal.bot_id, stress.bot_id); assert.ok(personal.browser_bot_id); assert.notEqual(personal.bot_id, personal.browser_bot_id);
  results.push({ check: 'Registered separate personal, research and tester bot snapshots', passed: true, ms: Date.now() - started });
  for (const trip of [personal, stress]) { await db.from('roamer_trips').update({ title: 'Isolation check fixture' }).eq('id', trip.id).eq('owner_id', process.env.ROAMER_USER_ID); }
  const personalHistory = await api('/api/trips'); const stressHistory = await api('/api/trips?workspace=stress-careful');
  assert.ok(personalHistory.trips.some((trip: { id: string }) => trip.id === personal.id)); assert.ok(!personalHistory.trips.some((trip: { id: string }) => trip.id === stress.id)); assert.ok(personalHistory.trips.every((trip: { workspace_id: string }) => trip.workspace_id === 'personal'));
  assert.ok(stressHistory.trips.some((trip: { id: string }) => trip.id === stress.id)); assert.ok(!stressHistory.trips.some((trip: { id: string }) => trip.id === personal.id));
  results.push({ check: 'History defaults to personal and explicit tester history remains separate', passed: true });
  const bindingAttempt = await db.from('roamer_trips').update({ bot_id: stress.bot_id }).eq('id', personal.id);
  assert.ok(bindingAttempt.error, 'Immutable binding update must fail');
  const freshPersonal = (await api(`/api/trips/${personal.id}`)).trip; assert.equal(freshPersonal.bot_id, personal.bot_id);
  results.push({ check: 'Database rejects service-level mutation of an existing trip bot binding', passed: true });
  const noteText = 'Isolation test: timestamps and visible updates need to agree.';
  await api(`/api/trips/${personal.id}/debug`, { note: noteText, clientAt: new Date().toISOString() });
  const debug = await api(`/api/trips/${personal.id}/debug`);
  assert.equal(debug.trip.botId, personal.bot_id); assert.equal(debug.trip.browserBotId, personal.browser_bot_id); assert.ok(debug.events.some((event: { type: string; payload: { note?: string } }) => event.type === 'debug_note' && event.payload.note === noteText)); assert.equal(debug.commands.length, 0);
  for (const secret of [process.env.ROAMER_ACCESS_CODE, process.env.SUPABASE_SERVICE_ROLE_KEY, session.access_token]) if (secret) assert.ok(!JSON.stringify(debug).includes(secret));
  results.push({ check: 'Authenticated debug note round trip saves an event, exposes no credentials and queues no task', passed: true });
  const unauthenticated = await fetch(base + `/api/trips/${personal.id}/debug`); assert.equal(unauthenticated.status, 401);
  results.push({ check: 'Debug data rejects unauthenticated access', passed: true });
  const registryWrite = await fetch(process.env.NEXT_PUBLIC_SUPABASE_URL + '/rest/v1/roamer_workspaces?id=eq.personal', { method: 'PATCH', headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ bot_id: stress.bot_id }) });
  assert.ok(registryWrite.status === 401 || registryWrite.status === 403, `Registry client-write status ${registryWrite.status}`);
  results.push({ check: 'Signed-in browser role cannot rewrite server-owned bot registry', passed: true });
  const queued = await db.from('roamer_commands').select('id', { count: 'exact', head: true }).in('trip_id', fixtureIds); assert.equal(queued.count, 0);
  results.push({ check: 'No Grok messages or research jobs were created by these checks', passed: true });
} finally {
  if (fixtureIds.length) { const cleanup = await db.from('roamer_trips').delete().in('id', fixtureIds).eq('owner_id', process.env.ROAMER_USER_ID); assert.equal(cleanup.error, null, 'Fixture cleanup failed'); }
  await mkdir('output/tests', { recursive: true }); await writeFile('output/tests/workspace-isolation.json', JSON.stringify({ at: new Date().toISOString(), results, fixtureIds, fixturesDeleted: true }, null, 2));
  console.log(JSON.stringify({ checks: results.length, results, fixturesDeleted: fixtureIds }));
}
