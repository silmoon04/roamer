import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { adminDb, commitEvents, event } from '../src/lib/db';

const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const db = adminDb();
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: process.env.ROAMER_ACCESS_CODE }) });
if (!login.ok) throw new Error(`Login returned ${login.status}`);
const { session } = await login.json();
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };
const response = await fetch(base + '/api/trips', { method: 'POST', headers, body: JSON.stringify({ workspace: 'stress-careful' }) });
if (!response.ok) throw new Error(`Fixture creation returned ${response.status}`);
const { trip } = await response.json();
if (trip.workspace_id !== 'stress-careful') throw new Error('Measurement must use a tester workspace');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
  await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: `sb-${project}-auth-token`, session });
  await page.goto(`${base}/?trip=${trip.id}`);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-trip-id', trip.id, { timeout: 60000 });
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const text = `Database timing probe ${i + 1}. This is a test fixture.`;
    const started = Date.now();
    const updated = await commitEvents(trip.id, current => [event(trip.id, current.state.revision, 'assistant_message', { text })]);
    await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 20000 });
    const metric = await page.evaluate(({ tripId, version }) => (window as unknown as { __ROAMER_METRICS?: {tripId:string;version:number;type:string;committedAt?:string;receivedAt?:string;renderedAt?:string;visibilityState?:string;renderVisibilityState?:string;ms:number}[] }).__ROAMER_METRICS?.findLast(m => m.tripId === tripId && m.version === version), { tripId: trip.id, version: updated.version });
    rows.push({ version: updated.version, commitRequestToVisibleMs: Date.now() - started, metric, timestampToVisibleMs: metric?.committedAt && metric.receivedAt && metric.visibilityState !== 'hidden' && metric.renderVisibilityState !== 'hidden' ? Date.parse(metric.renderedAt ?? metric.receivedAt) - Date.parse(metric.committedAt) : null });
  }
  const notes = await fetch(`${base}/api/trips/${trip.id}/debug`, { method: 'POST', headers, body: JSON.stringify({ note: 'Saved timing instrumentation check.', observedVersion: rows.at(-1)?.version, browserMetrics: rows.flatMap(row => row.metric ? [row.metric] : []) }) });
  if (!notes.ok) throw new Error(`Timing note save returned ${notes.status}`);
  const saved = await db.from('roamer_events').select('payload').eq('trip_id', trip.id).eq('type', 'debug_note').single();
  const commands = await db.from('roamer_commands').select('id', { count: 'exact', head: true }).eq('trip_id', trip.id);
  if (commands.error || commands.count !== 0) throw new Error('Measurement unexpectedly queued a command');
  const values = rows.flatMap(row => row.timestampToVisibleMs == null ? [] : [row.timestampToVisibleMs]).sort((a,b) => a-b);
  const percentile = (p:number) => values.length ? values[Math.ceil(values.length*p)-1] : null;
  const result = { checkedAt: new Date().toISOString(), base, fixtureTrip: trip.id, noGrokCommands: true, samples: rows, timestampToVisible: { count: values.length, p50: percentile(.5), p95: percentile(.95), max: values.at(-1) ?? null }, savedTimingCount: saved.data?.payload.browserMetrics?.length ?? 0 };
  await mkdir('output/latency', { recursive: true });
  await writeFile(`output/latency/realtime-${base.includes('localhost') || base.includes('127.0.0.1') ? 'local' : 'hosted'}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ stage: 'measured', ...result, samples: undefined }));
} finally {
  await browser.close();
  const cleanup = await db.from('roamer_trips').delete().eq('id', trip.id).eq('workspace_id', 'stress-careful').eq('owner_id', process.env.ROAMER_USER_ID!);
  if (cleanup.error) throw new Error('Timing fixture cleanup failed');
}
