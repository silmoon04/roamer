import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { adminDb, type TripRow } from '../src/lib/db';

const base = 'http://127.0.0.1:3000';
const directory = 'output/stress/friends-isolated';
const workspace = 'stress-friends';
const expectedBot = '6e9e7298-1c65-4bbb-8442-955dcf6c8d2e';
const started = Date.now();
const db = adminDb();
const { count: busy, error: busyError } = await db.from('roamer_commands').select('id,roamer_trips!inner(workspace_id)', { count: 'exact', head: true }).eq('owner_id', process.env.ROAMER_USER_ID!).eq('roamer_trips.workspace_id', workspace).in('status', ['queued', 'running']);
if (busyError) throw busyError;
if (busy) throw new Error('The friends workspace already has active work; no new trip or messages were created.');
await mkdir(directory, { recursive: true });
await mkdir('.roamer', { recursive: true });
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: process.env.ROAMER_ACCESS_CODE }), signal: AbortSignal.timeout(60000) });
if (!login.ok) throw new Error(`Website login failed: HTTP ${login.status}`);
const { session } = await login.json();
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };
const createdResponse = await fetch(`${base}/api/trips`, { method: 'POST', headers, body: JSON.stringify({ workspace }), signal: AbortSignal.timeout(60000) });
if (!createdResponse.ok) throw new Error(`Trip creation failed: HTTP ${createdResponse.status}`);
const created = await createdResponse.json();
if (created.trip.workspace_id !== workspace || created.trip.bot_id !== expectedBot) throw new Error('The created trip does not belong to the dedicated friends bot. No message was sent.');
const id = created.trip.id;
console.log(JSON.stringify({ stage: 'created', tripId: id, at: new Date().toISOString() }));
await writeFile('.roamer/stress-friends-isolated-trip.json', JSON.stringify({ id, workspace, botId: expectedBot, startedAt: new Date(started).toISOString() }));
await db.from('roamer_trips').update({ title: 'Stress · changing friends' }).eq('id', id);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: `sb-${project}-auth-token`, session });
const errors: string[] = [], submitted: unknown[] = [], timeline: unknown[] = [];
const marks: Record<string, number> = {};
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.url().endsWith('/commands')) submitted.push({ at: new Date().toISOString(), status: response.status(), request: response.request().postDataJSON() }); });
async function submit(action: () => Promise<unknown>) {
  const received = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().method() === 'POST', { timeout: 60000 });
  await action();
  const response = await received;
  if (!response.ok()) throw new Error(`Command failed with HTTP ${response.status()}; not resending an uncertain command.`);
  return response.json();
}
async function message(text: string) { await page.getByLabel('Message Roamer').fill(text); return submit(() => page.getByRole('button', { name: 'Send message', exact: true }).click()); }
async function screenshot(label: string) { await page.screenshot({ path: `${directory}/${label}.png`, fullPage: true }); }
let trip: TripRow = created.trip;
let answered = false, tightened = false, movedDates = false, lastVersion = -1, idleSince = 0;
try {
  await page.goto(`${base}/?workspace=${workspace}&trip=${id}`);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-trip-id', id, { timeout: 60000 });
  await screenshot('01-before-request-1440');
  await message("Three friends, three adults, want five nights in Europe from London between 10 and 20 October 2026. Start by checking 12 October. Our total budget is £1,500 for all three. We like food, art and coastal walks. We need three real separate beds, not a shared bed or sofa bed. One friend may join later, so flexible cancellation matters. Please look at just one destination for now and ask us the next useful question while you search.");
  marks.initialSubmitted = Date.now() - started;
  await screenshot('02-request-submitted-1440');
  while (Date.now() - started < 900000) {
    const result = await db.from('roamer_trips').select('*').eq('id', id).single();
    if (result.error || !result.data) { errors.push(`Read failed at ${new Date().toISOString()}`); await new Promise(r => setTimeout(r, 2000)); continue; }
    trip = result.data; const state = trip.state; const elapsed = Date.now() - started;
    if (state.messages.some(m => m.role === 'assistant')) marks.firstAssistant ??= elapsed;
    if (state.candidates.length) marks.firstCandidate ??= elapsed;
    if (state.candidates.some(c => c.sources.length || c.flight || c.stay)) marks.firstUsefulResult ??= elapsed;
    if (state.candidates.some(c => c.flight || c.stay)) marks.firstPrice ??= elapsed;
    if (trip.version !== lastVersion) {
      timeline.push({ at: new Date().toISOString(), version: trip.version, revision: state.revision, criteria: state.criteria, profile: state.profile, questions: state.questions, messages: state.messages, actions: state.actions, candidates: state.candidates });
      console.log(JSON.stringify({ stage: 'update', seconds: Math.round(elapsed / 1000), revision: state.revision, travellers: state.criteria.travellers, budget: state.criteria.budget, noCar: state.criteria.noCar, date: state.criteria.departureDate, candidates: state.candidates.map(c => ({ name: c.name, status: c.status, flight: !!c.flight, stay: !!c.stay })), pending: state.actions.filter(a => a.status === 'running').map(a => a.label) }));
      lastVersion = trip.version;
    }
    const question = state.questions.find(q => !q.answer && !q.skipped);
    if (question && !answered) {
      const preferred = question.options.find(o => /three|3 |separate|free cancellation|flexible|apartment|public transport|without a car/i.test(o)) ?? question.options[0];
      await screenshot('03-question-1440');
      const option = page.getByRole('button', { name: preferred, exact: true }).first();
      await expect(option).toBeVisible({ timeout: 30000 });
      await submit(() => option.click()); answered = true; marks.questionAnswered = Date.now() - started;
    }
    if (answered && !tightened && (state.candidates.length || elapsed > (marks.questionAnswered ?? 0) + 30000)) {
      await message("We need to tighten the total to £1,200 for all three, and none of us will drive. Keep the three separate real beds and flexible cancellation requirement. Please keep checking only that one destination.");
      tightened = true; marks.budgetSubmitted = Date.now() - started;
      await screenshot('04-budget-change-1440');
    }
    if (tightened && !movedDates && state.criteria.budget === 1200 && state.criteria.noCar === true) {
      await message("The dates have changed: leave London on 16 October 2026 for five nights, coming back on the 21st. Keep the £1,200 total, three adults, three real beds, flexible cancellation and no-car plan. Recheck the same destination for these dates.");
      movedDates = true; marks.dateSubmitted = Date.now() - started;
      await screenshot('05-date-change-1440');
    }
    const counts = await db.from('roamer_commands').select('id', { count: 'exact', head: true }).eq('trip_id', id).in('status', ['queued', 'running']);
    if (!counts.error && !counts.count && movedDates) { idleSince ||= Date.now(); if (Date.now() - idleSince > 12000) { marks.finished = elapsed; break; } } else idleSince = 0;
    await new Promise(r => setTimeout(r, 2000));
  }
} catch (error) { errors.push(error instanceof Error ? error.message : 'Unknown test failure'); }
finally {
  const { data: finalTrip } = await db.from('roamer_trips').select('*').eq('id', id).single(); if (finalTrip) trip = finalTrip;
  await screenshot('06-final-1440').catch(() => undefined);
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('07-final-390-chat').catch(() => undefined);
  await page.getByRole('tab', { name: 'Your trip' }).click().catch(() => undefined);
  await screenshot('08-final-390-trip').catch(() => undefined);
  const metrics = await page.evaluate(() => (window as unknown as { __ROAMER_METRICS?: unknown[] }).__ROAMER_METRICS ?? []).catch(() => []);
  const [commands, events] = await Promise.all([db.from('roamer_commands').select('*').eq('trip_id', id).order('created_at'), db.from('roamer_events').select('*').eq('trip_id', id).order('seq')]);
  await writeFile('.roamer/stress-friends-isolated-result.json', JSON.stringify({ tripId: id, workspace, botId: expectedBot, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), marks, errors, submitted, metrics, timeline, commands: commands.data, events: events.data, state: trip.state }, null, 2));
  console.log(JSON.stringify({ stage: 'finished', tripId: id, marks, errors, submittedCommands: submitted.length, checked: trip.state.candidates.filter(c => c.status === 'checked').length }));
  await browser.close();
}
