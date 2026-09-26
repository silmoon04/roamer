import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { adminDb, type TripRow } from '../src/lib/db';
import { visibleCriteria } from '../src/lib/domain';

if (!process.argv.includes('--send-live')) throw new Error('Await the coordinated go before sending the one real test message.');
const db = adminDb(); const owner = process.env.ROAMER_USER_ID!; const workspace = 'stress-careful';
const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const busy = await db.from('roamer_commands').select('id,roamer_trips!inner(workspace_id)').eq('owner_id', owner).eq('roamer_trips.workspace_id', workspace).in('status', ['queued','running']);
if (busy.error || busy.data?.length) throw new Error('Careful tester is busy. No message was sent.');
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: process.env.ROAMER_ACCESS_CODE }), signal: AbortSignal.timeout(20000) });
assert.equal(login.status, 200); const { session } = await login.json();
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };
const created = await fetch(base + '/api/trips', { method: 'POST', headers, body: JSON.stringify({ workspace }), signal: AbortSignal.timeout(20000) }); assert.equal(created.status, 200);
let trip: TripRow = (await created.json()).trip; assert.equal(trip.workspace_id, workspace); const id = trip.id;
await mkdir('output/final', { recursive: true });
console.log(JSON.stringify({ stage: 'created', tripId: id, workspace, botId: trip.bot_id }));
const browser = await chromium.launch({ channel: 'chrome', headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: `sb-${project}-auth-token`, session });
const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
let jobs: any[] = []; let ackMs: number | null = null; let firstReplyMs: number | null = null; let outcome = 'No assistant reply observed before cutoff.'; let sentAt: number | null = null;
const samples: unknown[] = [];
try {
  await page.goto(`${base}/?trip=${id}`); await expect(page.locator('.app-shell')).toHaveAttribute('data-trip-id', id, { timeout: 30000 });
  assert.equal(visibleCriteria(trip.state).budget, null); assert.equal(visibleCriteria(trip.state).origin, null); assert.equal(visibleCriteria(trip.state).travellers, null);
  await page.getByLabel('Message Roamer').fill('I want to go to Jamaica.');
  const response = page.waitForResponse(result => result.url().endsWith(`/api/trips/${id}/commands`) && ![502,503,504].includes(result.status()), { timeout: 30000 });
  sentAt = Date.now(); await page.getByRole('button', { name: 'Send message', exact: true }).click(); const accepted = await response; ackMs = Date.now() - sentAt; assert.equal(accepted.status(), 200);
  while (Date.now() - sentAt < 90000) {
    const [snapshot, commands] = await Promise.all([db.from('roamer_trips').select('*').eq('id', id).eq('owner_id', owner).single(), db.from('roamer_commands').select('id,kind,status,payload,delivery,created_at,updated_at').eq('trip_id', id).eq('owner_id', owner)]);
    if (snapshot.error || commands.error) { outcome = 'Read-only observation failed; nothing was resent.'; break; }
    trip = snapshot.data; jobs = commands.data ?? []; const visible = visibleCriteria(trip.state);
    const prices = jobs.filter(job => job.kind === 'research' && ['flights','stays'].includes(job.payload.kind) || job.kind === 'browser' && job.payload.purpose === 'price');
    samples.push({ elapsedMs: Date.now() - sentAt, version: trip.version, visibleCriteria: visible, priceJobs: prices.length, questions: trip.state.questions.map(question => question.prompt) });
    assert.equal(prices.length, 0, 'Price jobs were queued before required details were supplied.'); assert.equal(visible.budget, null, 'Budget was assumed.'); assert.equal(visible.origin, null, 'Origin was assumed.'); assert.equal(visible.travellers, null, 'Party size was assumed.');
    if (trip.state.messages.some(message => message.role === 'assistant')) { firstReplyMs ??= Date.now() - sentAt; outcome = 'Assistant responded; budget, origin and party remained unknown, with no price jobs.'; }
    if (firstReplyMs !== null && !jobs.some(job => job.kind === 'conversation' && ['queued','running'].includes(job.status))) break;
    if (jobs.some(job => job.kind === 'conversation' && job.status === 'error')) { outcome = 'Conversation failed; no automatic resend.'; break; }
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  await page.screenshot({ path: 'output/final/intake-1440.png', fullPage: true });
} catch (error) { outcome = error instanceof Error ? error.message : String(error); }
finally {
  const result = { tripId: id, workspace, botId: trip.bot_id, outcome, ackMs, firstReplyMs, sentAt: sentAt ? new Date(sentAt).toISOString() : null, visibleCriteria: visibleCriteria(trip.state), questions: trip.state.questions, assistant: trip.state.messages.filter(message => message.role === 'assistant').map(message => message.text), commands: jobs.map(job => ({ id: job.id, kind: job.kind, purpose: job.payload.purpose, providerKind: job.payload.kind, status: job.status, delivery: job.delivery })), errors, samples };
  await writeFile('output/final/intake.json', JSON.stringify(result, null, 2));
  await writeFile('output/final/intake.md', `# Destination-only intake check\n\nTrip: ${id}; workspace: ${workspace}. One real website message: "I want to go to Jamaica." No follow-up was sent.\n\n${outcome}\n\n- API acknowledgement: ${ackMs ?? 'unavailable'} ms.\n- First assistant response: ${firstReplyMs ?? 'not observed'} ms.\n- Confirmed budget/origin/party: ${JSON.stringify({ budget: result.visibleCriteria.budget, origin: result.visibleCriteria.origin, travellers: result.visibleCriteria.travellers })}.\n- Questions: ${result.questions.map(question => question.prompt).join(' | ') || 'None observed'}.\n- Browser errors: ${errors.length}.\n\nAssistant text:\n\n${result.assistant.join('\n\n') || 'None observed.'}\n\nFull bounded observations are in intake.json; screenshot intake-1440.png if the page capture succeeded. Native voice remains unverified.\n`);
  console.log(JSON.stringify({ stage: 'finished', ...result, samples: samples.length })); await browser.close();
}
