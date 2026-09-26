import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { adminDb, type TripRow } from '../src/lib/db';
import { canPriceSearch, visibleCriteria } from '../src/lib/domain';

if (!process.argv.includes('--send-live')) throw new Error('This script sends two real messages. Run only after the coordinated worker restart with --send-live.');
const workspace = 'stress-careful';
const db = adminDb(); const owner = process.env.ROAMER_USER_ID!;
const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = `output/stress/careful-intake-${stamp}`;
const busy = await db.from('roamer_commands').select('id,roamer_trips!inner(workspace_id)').eq('owner_id', owner).eq('roamer_trips.workspace_id', workspace).in('status', ['queued','running']);
if (busy.error || busy.data?.length) throw new Error('The careful tester bot is busy or its queue could not be verified. No new trip or message was sent.');
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: process.env.ROAMER_ACCESS_CODE }) });
assert.equal(login.status, 200, `Login status ${login.status}`); const { session } = await login.json();
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };
const response = await fetch(base + '/api/trips', { method: 'POST', headers, body: JSON.stringify({ workspace }) });
assert.equal(response.status, 200, `Trip creation status ${response.status}`); let trip: TripRow = (await response.json()).trip;
assert.equal(trip.workspace_id, workspace); assert.ok(trip.bot_id); const id = trip.id;
await db.from('roamer_trips').update({ title: 'Jamaica · intake regression' }).eq('id', id).eq('owner_id', owner);
await mkdir(output, { recursive: true }); await mkdir('.roamer', { recursive: true });
await writeFile(`.roamer/intake-gate-${stamp}-trip.json`, JSON.stringify({ id, workspace, botId: trip.bot_id, startedAt: new Date().toISOString() }));
console.log(JSON.stringify({ stage: 'created', tripId: id, workspace, botId: trip.bot_id, output }));
const browser = await chromium.launch({ channel: 'chrome', headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: `sb-${project}-auth-token`, session });
const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
const timeline: unknown[] = []; const assertions: Record<string, unknown> = {}; const requests: unknown[] = [];
const started = Date.now(); let latestCommands: any[] = []; let outcome = 'not started';
async function read() {
  const [snapshot, commands] = await Promise.all([db.from('roamer_trips').select('*').eq('id', id).eq('owner_id', owner).single(), db.from('roamer_commands').select('id,kind,status,payload,created_at,updated_at,delivery,error').eq('trip_id', id).eq('owner_id', owner).order('created_at')]);
  if (snapshot.error || commands.error) throw new Error('A read-only observation failed; no message will be resent.');
  trip = snapshot.data; latestCommands = commands.data ?? [];
  timeline.push({ at: new Date().toISOString(), elapsedMs: Date.now() - started, version: trip.version, criteria: visibleCriteria(trip.state), canPriceSearch: canPriceSearch(trip.state), questions: trip.state.questions, jobs: latestCommands.map(job => ({ id: job.id, kind: job.kind, purpose: job.payload.purpose, operation: job.payload.operation, providerKind: job.payload.kind, status: job.status })) });
}
async function send(text: string) {
  const began = Date.now(); await page.getByLabel('Message Roamer').fill(text);
  const pending = page.waitForResponse(result => result.url().endsWith(`/api/trips/${id}/commands`) && ![502,503,504].includes(result.status()), { timeout: 90000 });
  await page.getByRole('button', { name: 'Send message', exact: true }).click(); const result = await pending;
  requests.push({ id: result.request().postDataJSON()?.id, status: result.status(), ackMs: Date.now() - began });
  assert.equal(result.status(), 200, `Message status ${result.status()}`);
}
function priceJobs() { return latestCommands.filter(job => job.kind === 'research' && ['flights','stays'].includes(job.payload.kind) || job.kind === 'browser' && job.payload.purpose === 'price'); }
try {
  await page.goto(`${base}/?trip=${id}`); await expect(page.locator('.app-shell')).toHaveAttribute('data-trip-id', id, { timeout: 45000 });
  assert.equal(visibleCriteria(trip.state).budget, null); assert.equal(visibleCriteria(trip.state).origin, null); assert.equal(visibleCriteria(trip.state).travellers, null); assertions.newTripUnknown = true;
  await page.screenshot({ path: `${output}/01-blank.png`, fullPage: true });
  await send('I want to go to Jamaica.'); const firstSent = Date.now();
  let firstIdle = 0;
  while (Date.now() - firstSent < 180000) {
    await read(); assert.equal(priceJobs().length, 0, 'A price job was queued before budget and logistics were provided.');
    assert.equal(visibleCriteria(trip.state).budget, null, 'An unstated budget was promoted to confirmed.'); assert.equal(visibleCriteria(trip.state).origin, null, 'An unstated origin was promoted to confirmed.'); assert.equal(visibleCriteria(trip.state).travellers, null, 'An unstated party size was promoted to confirmed.');
    const replied = trip.state.messages.some(message => message.role === 'assistant'); const active = latestCommands.some(job => ['queued','running'].includes(job.status));
    if (replied && !active) { firstIdle ||= Date.now(); if (Date.now() - firstIdle > 4000) break; } else firstIdle = 0;
    if (!active && latestCommands.some(job => job.kind === 'conversation' && job.status === 'error')) break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  assertions.firstStageMs = Date.now() - firstSent; assertions.priceJobsBeforeDetails = priceJobs().length; assertions.questions = trip.state.questions.map(question => question.prompt); assertions.assistant = trip.state.messages.filter(message => message.role === 'assistant').map(message => message.text);
  await page.screenshot({ path: `${output}/02-clarification.png`, fullPage: true });
  if (!trip.state.messages.some(message => message.role === 'assistant') || latestCommands.some(job => ['queued','running'].includes(job.status))) { outcome = 'Initial clarification blocked or still running; details were not resent.'; }
  else {
    await send('There are two adults leaving London for five nights. We can depart between 10 and 20 October 2026. Our total budget is £3,500 GBP for both people. Please check just one base in Jamaica, Montego Bay, with a private room and good local food.'); const detailsSent = Date.now();
    while (Date.now() - detailsSent < 150000) {
      await read();
      if (priceJobs().length) { assert.ok(canPriceSearch(trip.state), 'Prices started without confirmed details.'); assertions.priceJobsAfterDetails = priceJobs().map(job => ({ id: job.id, kind: job.payload.kind, status: job.status })); assertions.detailsToPriceQueueMs = Date.now() - detailsSent; outcome = 'Unknown intake blocked prices; explicit details enabled price jobs.'; break; }
      if (!latestCommands.some(job => ['queued','running'].includes(job.status)) && latestCommands.some(job => job.kind === 'conversation' && job.status === 'error')) { outcome = 'Explicit details were saved but the bridge failed.'; break; }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    if (outcome === 'not started') outcome = 'Explicit details sent; no price job observed before cutoff.';
  }
  await page.screenshot({ path: `${output}/03-final-1440.png`, fullPage: true }); await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: `${output}/04-final-390.png`, fullPage: true });
} catch (error) { outcome = error instanceof Error ? error.message : String(error); throw error; }
finally {
  const metrics = await page.evaluate(() => (window as any).__ROAMER_METRICS ?? []).catch(() => []);
  const result = { tripId: id, workspace, botId: trip.bot_id, startedAt: new Date(started).toISOString(), outcome, assertions, requests, errors, metrics, timeline, finalState: trip.state, commands: latestCommands };
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2)); await writeFile(`.roamer/intake-gate-${stamp}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ stage: 'finished', tripId: id, outcome, assertions, errors, output })); await browser.close();
}
