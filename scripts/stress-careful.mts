import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { adminDb, type TripRow } from '../src/lib/db';

const base = 'http://127.0.0.1:3000';
const db = adminDb();
const out = 'output/stress/careful';
await mkdir(out, { recursive: true }); await mkdir('.roamer', { recursive: true });
const began = Date.now(); const deadline = began + 780000;
const marks: Record<string, number> = {};
const issues: string[] = [];
const actions: { kind: string; id: string; ms: number; status: number; at: string }[] = [];
const snapshots: unknown[] = [];
const pageErrors: string[] = [];
const timeout = () => AbortSignal.timeout(25000);
async function login() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: process.env.ROAMER_ACCESS_CODE }), signal: timeout() });
    if (r.ok) return (await r.json()).session;
    if (![502, 503, 504].includes(r.status) || attempt === 2) throw new Error(`Sign-in status ${r.status}`);
  }
}
const session = await login();
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };
const response = await fetch(base + '/api/trips', { method: 'POST', headers, body: '{}', signal: timeout() });
if (!response.ok) throw new Error(`New trip status ${response.status}`);
let trip: TripRow = (await response.json()).trip;
const id = trip.id;
await db.from('roamer_trips').update({ title: 'Stress · careful couple' }).eq('id', id);
await writeFile('.roamer/stress-careful-trip.json', JSON.stringify({ id, startedAt: new Date(began).toISOString() }));
console.log(JSON.stringify({ stage: 'created', tripId: id }));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: `sb-${project}-auth-token`, session });
page.on('pageerror', e => pageErrors.push(e.message));
let commandCount = 0;
async function submit(kind: string, click: () => Promise<unknown>) {
  if (commandCount >= 4) throw new Error('Four-command stress budget reached.');
  const start = Date.now();
  const pending = page.waitForResponse(r => r.url().endsWith(`/api/trips/${id}/commands`) && ![502, 503, 504].includes(r.status()), { timeout: 90000 });
  await click(); const r = await pending;
  const body = r.request().postDataJSON();
  actions.push({ kind, id: body.id, ms: Date.now() - start, status: r.status(), at: new Date(start).toISOString() });
  if (!r.ok()) throw new Error(`Command ${kind} status ${r.status()}`);
  commandCount++; return body.id as string;
}
async function message(text: string, kind: string) {
  await page.getByLabel('Message Roamer').fill(text);
  return submit(kind, () => page.getByRole('button', { name: 'Send message', exact: true }).click());
}
async function screenshot(name: string) { await page.screenshot({ path: `${out}/${name}.png`, fullPage: true }); }
function choose(prompt: string, options: string[]) {
  const p = prompt.toLowerCase();
  const patterns = /budget|£|spend/.test(p) ? [/food.*transport|whole|total|all.?in/i] : /date|depart|flexib/.test(p) ? [/any|flex|10.*20/i] : /driv|car|transport/.test(p) ? [/no car|without|public|don't|do not|neither/i] : /hik|walk|active/.test(p) ? [/moderate|gentle|day|easy/i] : [/private|quiet|cosy|cozy/i, /both|any|flex/i];
  return patterns.map(pattern => options.find(o => pattern.test(o))).find(Boolean) ?? options[0];
}
let answered = false; let midId: string | undefined; let changed = false; let firstReplyPhoto = false; let resultPhoto = false;
let idleSince = 0; let lastLog = 0; let finish = 'deadline'; let commandRows: Record<string, unknown>[] = [];
try {
  await page.goto(`${base}/?trip=${id}`);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-trip-id', id, { timeout: 45000 });
  marks.loaded = Date.now() - began; await screenshot('01-start');
  await message('We are a couple, two adults leaving London for five nights in Europe. We can depart any day from 10 to 20 October 2026. Our £1,000 is the total for both of us, including flights, accommodation, food and local transport. We like hiking, good food and cosy accommodation. Please compare just ONE destination for this first pass to keep the search focused. We need to arrive before 21:00. Start the research while we clarify the details.', 'initial');
  marks.initialAccepted = Date.now() - began;
  while (Date.now() < deadline) {
    const [stateResult, jobResult, queueResult] = await Promise.all([
      db.from('roamer_trips').select('*').eq('id', id).single(),
      db.from('roamer_commands').select('id,kind,status,created_at,updated_at,error,delivery,revision').eq('trip_id', id).order('created_at'),
      db.from('roamer_commands').select('trip_id,kind,status,created_at').in('status', ['queued', 'running'])
    ]);
    if (stateResult.error || jobResult.error) { issues.push('A database observation failed; continued without resending a command.'); await new Promise(r => setTimeout(r, 2500)); continue; }
    trip = stateResult.data; commandRows = jobResult.data ?? [];
    const s = trip.state; const elapsed = Date.now() - began;
    const active = commandRows.filter(j => ['queued', 'running'].includes(String(j.status)));
    if (s.messages.some(m => m.role === 'assistant')) marks.firstResponse ??= elapsed;
    if (s.candidates.some(c => c.sources.length || c.flight || c.stay)) marks.firstUsefulResult ??= elapsed;
    if (s.candidates.some(c => c.flight || c.stay)) marks.firstPrice ??= elapsed;
    if (s.candidates.some(c => c.status === 'checked')) marks.firstCheckedCandidate ??= elapsed;
    if (marks.firstResponse && !firstReplyPhoto) { await screenshot('02-first-reply'); firstReplyPhoto = true; }
    if (marks.firstUsefulResult && !resultPhoto) { await screenshot('03-first-evidence'); resultPhoto = true; }
    if (Date.now() - lastLog > 15000) {
      const summary = { at: new Date().toISOString(), seconds: Math.round(elapsed / 1000), revision: s.revision, messages: s.messages.length, unanswered: s.questions.filter(q => !q.answer && !q.skipped).length, ownActive: active.map(j => ({ id: j.id, kind: j.kind, status: j.status })), sharedActive: queueResult.data?.length, candidates: s.candidates.map(c => ({ name: c.name, status: c.status, flight: !!c.flight, stay: !!c.stay, sources: c.sources.length })) };
      snapshots.push(summary); console.log(JSON.stringify({ stage: 'progress', ...summary })); lastLog = Date.now();
    }
    const question = s.questions.find(q => !q.answer && !q.skipped);
    if (question && !answered && !midId) {
      const option = choose(question.prompt, question.options);
      await submit('answer', () => page.getByRole('button', { name: option!, exact: true }).first().click());
      answered = true; marks.answerAccepted = elapsed; await screenshot('04-answer');
    }
    if (!midId && marks.firstResponse && (answered || s.candidates.length > 0 || elapsed > 180000)) {
      midId = await message('A few important details: neither of us drives, we are both vegetarian, and we need a quiet private room rather than a dorm or a party hotel. Keep the pre-21:00 arrival requirement. Can you explain which of those requirements you have actually checked, and what is still an assumption? Keep the shortlist to one destination.', 'constraints-and-clarification');
      marks.constraintsAccepted = Date.now() - began; await screenshot('05-constraints');
    }
    if (midId && !changed && commandRows.some(j => j.id === midId && j.status === 'done')) {
      await page.getByRole('button', { name: 'Edit trip details', exact: true }).click();
      await page.getByLabel('Specific departure (optional)').fill('2026-10-12');
      await submit('date', () => page.getByRole('button', { name: 'Save trip details', exact: true }).click());
      await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 30000 }); changed = true; marks.dateAccepted = Date.now() - began; await screenshot('06-date-change');
    }
    if (!active.length && marks.firstResponse && changed) {
      idleSince ||= Date.now();
      if (Date.now() - idleSince > 15000) { finish = s.candidates.some(c => c.status === 'checked') ? 'checked' : 'blocked-or-partial'; marks.finished = elapsed; break; }
    } else idleSince = 0;
    if (!active.length && commandRows.some(j => j.kind === 'conversation' && j.status === 'error')) { finish = 'conversation-blocked'; marks.blocked = elapsed; break; }
    await new Promise(r => setTimeout(r, 2200));
  }
} catch (error) { issues.push(error instanceof Error ? error.message : String(error)); finish = 'test-interrupted'; }
finally {
  const final = await db.from('roamer_trips').select('*').eq('id', id).single(); if (final.data) trip = final.data;
  const { data: jobs } = await db.from('roamer_commands').select('id,kind,status,created_at,updated_at,error,delivery,revision').eq('trip_id', id).order('created_at'); commandRows = jobs ?? commandRows;
  await screenshot('07-final-desktop').catch(() => {});
  const photos = await page.locator('.candidate-card img').evaluateAll(images => images.map(img => ({ alt: (img as HTMLImageElement).alt, loaded: (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0 }))).catch(() => []);
  const metrics = await page.evaluate(() => (window as unknown as { __ROAMER_METRICS?: unknown[] }).__ROAMER_METRICS ?? []).catch(() => []);
  const visible = await page.locator('body').innerText().catch(() => '');
  await page.setViewportSize({ width: 390, height: 844 }); await screenshot('08-final-mobile-chat').catch(() => {});
  await page.getByRole('tab', { name: 'Your trip', exact: true }).click().catch(() => {}); await screenshot('09-final-mobile-trip').catch(() => {});
  const timings = commandRows.map(job => {
    const a = trip.state.actions.find(a => a.id === job.id);
    return { id: job.id, kind: job.kind, status: job.status, queueWaitMs: a ? Date.parse(a.startedAt) - Date.parse(String(job.created_at)) : null, processingMs: a?.finishedAt ? Date.parse(a.finishedAt) - Date.parse(a.startedAt) : null, error: job.error };
  });
  const report = { tripId: id, title: 'Stress · careful couple', startedAt: new Date(began).toISOString(), elapsedMs: Date.now() - began, finish, marks, submitted: actions, timings, photos, metrics, issues, pageErrors, snapshots, visible, state: trip.state };
  await writeFile('.roamer/stress-careful-receipt.json', JSON.stringify(report, null, 2));
  await writeFile(`${out}/results.json`, JSON.stringify({ ...report, visible: undefined, state: undefined }, null, 2));
  console.log(JSON.stringify({ stage: 'finished', tripId: id, finish, marks, submitted: actions, issues, pageErrors, photos }));
  await browser.close();
}
