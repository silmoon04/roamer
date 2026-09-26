import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { adminDb, type TripRow } from '../src/lib/db';

const base = 'http://127.0.0.1:3000';
const output = 'output/stress/slower-isolated';
const db = adminDb();
if(process.env.ROAMER_LIVE_TEST_APPROVED!=='1')throw new Error('Live test is gated. Wait for the coordinator to confirm the isolated worker is ready.');
const {data:workspace,error:workspaceError}=await db.from('roamer_workspaces').select('bot_id,browser_bot_id,bot_name').eq('id','stress-slower').eq('owner_id',process.env.ROAMER_USER_ID!).single();
if(workspaceError||!workspace?.bot_id||workspace.bot_name!=='Roamer Test Slower')throw new Error('Isolated slower bot is not configured.');
const {count:activeCount,error:activeError}=await db.from('roamer_commands').select('id,roamer_trips!inner(workspace_id)',{count:'exact',head:true}).eq('owner_id',process.env.ROAMER_USER_ID!).eq('roamer_trips.workspace_id','stress-slower').in('status',['queued','running']);
if(activeError||activeCount)throw new Error('The slower workspace already has active commands, or its queue could not be checked.');
await mkdir(output, { recursive: true });
await mkdir('.roamer', { recursive: true });
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: process.env.ROAMER_ACCESS_CODE }) });
if (!login.ok) throw new Error(`Sign-in status ${login.status}.`);
const { session } = await login.json();
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };
const creation = await fetch(base + '/api/trips', { method: 'POST', headers, body: JSON.stringify({workspace:'stress-slower'}) });
if (!creation.ok) throw new Error(`Trip creation status ${creation.status}; no retry attempted.`);
const { trip: created } = await creation.json();
if(created.workspace_id!=='stress-slower'||created.bot_id!==workspace.bot_id||created.browser_bot_id!==workspace.browser_bot_id)throw new Error('Created trip is not bound to the isolated slower bot. No message was sent.');
const id = created.id as string;
await db.from('roamer_trips').update({ title: 'Stress · slower city break' }).eq('id', id);
await writeFile(`${output}/trip.json`, JSON.stringify({ tripId: id, title: 'Stress · slower city break', url: `${base}/?trip=${id}` }, null, 2));
console.log(JSON.stringify({ stage: 'created', tripId: id }));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: `sb-${project}-auth-token`, session });
const started = Date.now();
const marks: Record<string, number> = {};
const commands: { label: string; id: string; submittedMs: number; ackMs: number; status: number }[] = [];
const snapshots: unknown[] = [];
const browserErrors: string[] = [];
const uiChecks: unknown[] = [];
let trip: TripRow = created;
let lastVersion = -1;
let answered = false;
let requirementsSent = false;
let correctionSent = false;
let idleSince = 0;
let stopReason = '15-minute limit';
page.on('pageerror', e => browserErrors.push(e.message.split('\n')[0].slice(0, 220)));

async function capture(name: string) {
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
}
async function submit(label: string, action: () => Promise<unknown>) {
  if (commands.length >= 4) throw new Error('Four-command limit reached.');
  const begin = Date.now();
  const received = page.waitForResponse(r => r.url().endsWith('/commands') && r.request().method() === 'POST' && r.status() !== 503, { timeout: 90000 });
  await action();
  const r = await received;
  const sent = r.request().postDataJSON();
  commands.push({ label, id: sent.id, submittedMs: begin - started, ackMs: Date.now() - begin, status: r.status() });
  if (!r.ok()) throw new Error(`${label} returned ${r.status()}; no resend attempted.`);
  console.log(JSON.stringify({ stage: 'command', label, id: sent.id, ackMs: Date.now() - begin }));
}
async function message(label: string, text: string) {
  await page.getByLabel('Message Roamer').fill(text);
  await submit(label, () => page.getByRole('button', { name: 'Send message', exact: true }).click());
}

try {
  await page.goto(`${base}/?trip=${id}`);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-trip-id', id, { timeout: 60000 });
  await capture('01-start');
  await message('initial', 'I’m travelling solo from London for five nights between 10 and 20 October 2026, with £850 total. Please research Vienna only, not a list of destinations. I’m interested in architecture and local food, not hiking. I can comfortably walk about 3 km a day and would rather use rail or trams. I want a private hotel room, no hostels. Start looking while we work out the details.');
  while (Date.now() - started < 900000) {
    const { data, error } = await db.from('roamer_trips').select('*').eq('id', id).single();
    if (error) { await new Promise(r => setTimeout(r, 2000)); continue; }
    trip = data;
    const s = trip.state;
    const elapsed = Date.now() - started;
    if (s.messages.some(m => m.role === 'assistant')) marks.firstGrokResponse ??= elapsed;
    if (s.candidates.some(c => c.sources.length || c.flight || c.stay)) marks.firstUsefulResult ??= elapsed;
    if (s.candidates.some(c => c.flight || c.stay)) marks.firstPrice ??= elapsed;
    if (s.candidates.some(c => c.status === 'checked')) marks.firstCheckedCandidate ??= elapsed;
    if (trip.version !== lastVersion) {
      const state = structuredClone(s);
      snapshots.push({ elapsed, version: trip.version, state });
      await writeFile('.roamer/stress-slower-isolated-raw.json', JSON.stringify({ tripId: id, commands, marks, snapshots }, null, 2));
      console.log(JSON.stringify({ stage: 'state', seconds: Math.round(elapsed / 1000), revision: s.revision, messages: s.messages.length, questions: s.questions.length, candidates: s.candidates.map(c => ({ name: c.name, status: c.status, flight: !!c.flight, stay: !!c.stay })), active: s.actions.filter(a => a.status === 'running' || a.status === 'queued').map(a => a.label) }));
      lastVersion = trip.version;
    }
    const question = s.questions.find(q => !q.answer && !q.skipped);
    if (question && !answered) {
      await capture('02-first-question');
      const option = question.options.find(x => /tram|quiet|relaxed|low|private|yes|flex|whole|total/i.test(x)) ?? question.options[0];
      await submit('first-mcq', () => page.getByRole('button', { name: option, exact: true }).first().click());
      answered = true; marks.firstQuestionAnswered = elapsed;
      await capture('03-question-answered');
    }
    if (answered && !requirementsSent && s.candidates.length && elapsed - marks.firstQuestionAnswered > 5000) {
      await message('quiet-accessible', 'A change of priority: I want a quiet neighbourhood, not nightlife. The hotel must have a step-free entrance and a lift to my room, or a confirmed ground-floor room. Please treat those as requirements, and verify them from the property’s own details or a direct answer rather than assuming from photos. Keep walking to about 3 km a day and stick with Vienna only.');
      requirementsSent = true; marks.requirementsSubmitted = elapsed;
      await capture('04-accessibility-requirement');
    }
    if (requirementsSent && !correctionSent && (marks.firstPrice !== undefined || elapsed - marks.requirementsSubmitted > 90000)) {
      await capture('05-before-party-date-correction');
      await message('party-date-correction', 'Correction: a friend is coming, so make this two adults in one private room, with £1,400 total for both of us. We will leave on 16 October 2026 for five nights. Keep Vienna, the quiet neighbourhood, step-free/lift requirement, no hostels, and the 3 km daily walking limit. Please retire prices checked for just one person or different dates.');
      correctionSent = true; marks.correctionSubmitted = elapsed;
      await capture('06-party-date-correction');
    }
    const { data: rows } = await db.from('roamer_commands').select('id,status,kind,created_at,updated_at,delivery,error').eq('trip_id', id);
    const pending = rows?.filter(r => r.status === 'queued' || r.status === 'running') ?? [];
    if (correctionSent && !pending.length) {
      idleSince ||= Date.now();
      if (Date.now() - idleSince > 20000) { marks.completedOrBlocked = elapsed; stopReason = s.candidates.some(c => c.status === 'checked') ? 'checked candidate' : 'queue settled with partial/blocked results'; break; }
    } else idleSince = 0;
    if (!pending.length && s.actions.some(a => a.kind === 'conversation' && a.status === 'error') && !answered) { marks.blocked = elapsed; stopReason = 'initial conversation failed'; break; }
    await new Promise(r => setTimeout(r, 2000));
  }
} catch (e) {
  stopReason = (e as Error).message.split('\n')[0].slice(0, 200);
  marks.scriptStopped = Date.now() - started;
  console.log(JSON.stringify({ stage: 'stopped', reason: stopReason }));
} finally {
  const final = await db.from('roamer_trips').select('*').eq('id', id).single();
  if (final.data) trip = final.data;
  const { data: commandRows } = await db.from('roamer_commands').select('id,kind,status,created_at,updated_at,delivery,error,attempts').eq('trip_id', id).order('created_at');
  await capture('07-final-desktop').catch(() => {});
  if (await page.locator('.candidate-card').count()) {
    await page.locator('.candidate-card').first().scrollIntoViewIfNeeded().catch(() => {});
    await page.locator('.candidate-card').first().locator('img').evaluateAll(async imgs => { await Promise.race([Promise.all(imgs.map(i => i.decode().catch(() => {}))), new Promise(r => setTimeout(r, 7000))]); }).catch(() => {});
    await capture('08-final-card').catch(() => {});
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Chat', exact: true }).click().catch(() => {});
  await capture('09-mobile-chat').catch(() => {});
  await page.getByRole('tab', { name: 'Your trip' }).click().catch(() => {});
  await page.locator('.trip-scroll').evaluate(el => el.scrollTop = 0).catch(() => {});
  await capture('10-mobile-trip').catch(() => {});
  uiChecks.push(await page.evaluate(() => ({ width: innerWidth, horizontalOverflow: document.documentElement.scrollWidth > innerWidth, status: document.querySelector('.live-label')?.textContent, imageStates: [...document.images].map(i => ({ alt: i.alt, loaded: i.complete && i.naturalWidth > 0, url: i.src })) })).catch(() => null));
  if (await page.locator('.candidate-card').count()) { await page.locator('.candidate-card').first().scrollIntoViewIfNeeded().catch(() => {}); await capture('11-mobile-card').catch(() => {}); }
  const metrics = await page.evaluate(() => (window as any).__ROAMER_METRICS ?? []).catch(() => []);
  const stateText = await page.locator('body').innerText().catch(() => '');
  const result = { tripId: id, title: 'Stress · slower city break', startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, stopReason, marks, commands, commandRows, metrics, browserErrors, uiChecks, stateText, state: trip.state };
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2));
  await writeFile('.roamer/stress-slower-isolated-raw.json', JSON.stringify({ ...result, snapshots }, null, 2));
  console.log(JSON.stringify({ stage: 'finished', tripId: id, stopReason, marks, commands: commands.length }));
  await browser.close();
}
