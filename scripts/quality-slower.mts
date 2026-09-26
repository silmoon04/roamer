import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { adminDb } from '../src/lib/db';
import { visibleCriteria } from '../src/lib/domain';

const base = 'https://roamer-chi.vercel.app';
const workspace = 'stress-slower';
const prompt = 'I am considering Ljubljana for five nights next month. We like art and good food, and we need a private bathroom. Do not search yet. What details do you need first?';
if (!process.argv.includes('--send-live')) throw new Error('This script sends one real tester message. Pass --send-live only during a coordinated test run.');
const db = adminDb();
const registration = await db.from('roamer_workspaces').select('bot_id').eq('id', workspace).eq('owner_id', process.env.ROAMER_USER_ID!).single();
if (registration.error || !registration.data?.bot_id) throw new Error('The isolated tester bot is not registered. No message was sent.');
const expectedBot = registration.data.bot_id;
const busy = await db.from('roamer_commands').select('id,roamer_trips!inner(workspace_id)', { count: 'exact', head: true }).eq('owner_id', process.env.ROAMER_USER_ID!).eq('roamer_trips.workspace_id', workspace).in('status', ['queued', 'running']);
if (busy.error || busy.count) throw new Error('The isolated tester has active work. No message was sent.');
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: process.env.ROAMER_ACCESS_CODE }), signal: AbortSignal.timeout(30000) });
if (!login.ok) throw new Error(`Login failed: HTTP ${login.status}`);
const { session } = await login.json();
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` };
const created = await fetch(`${base}/api/trips`, { method: 'POST', headers, body: JSON.stringify({ workspace }), signal: AbortSignal.timeout(30000) });
if (!created.ok) throw new Error(`Trip creation failed: HTTP ${created.status}`);
const { trip } = await created.json();
if (trip.workspace_id !== workspace || trip.bot_id !== expectedBot) throw new Error('Unexpected tester binding; no message was sent.');
console.log(JSON.stringify({ stage: 'created', tripId: trip.id, workspace, at: new Date().toISOString() }));
await mkdir('output/quality-slower', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
try {
  const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
  await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: `sb-${project}-auth-token`, session });
  await page.goto(`${base}/?workspace=${workspace}&trip=${trip.id}`);
  await expect(page.locator('.app-shell')).toHaveAttribute('data-trip-id', trip.id, { timeout: 30000 });
  await page.evaluate(() => {
    const record = { click: 0, user: 0, assistant: 0, text: '' };
    (window as Window & { qualityTiming?: typeof record }).qualityTiming = record;
    document.addEventListener('click', event => { if ((event.target as Element).closest('button[aria-label="Send message"]')) record.click = Date.now(); });
    new MutationObserver(() => {
      if (document.querySelector('.message.user .message-text')) record.user ||= Date.now();
      const reply = document.querySelector('.message.assistant .message-text')?.textContent;
      if (reply) { record.assistant ||= Date.now(); record.text ||= reply; }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await page.getByLabel('Message Roamer').fill(prompt);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().method() === 'POST', { timeout: 30000 });
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const accepted = await responsePromise;
  if (!accepted.ok()) throw new Error(`Message rejected: HTTP ${accepted.status()}. It will not be resent.`);
  const commandId = accepted.request().postDataJSON().id;
  console.log(JSON.stringify({ stage: 'sent', tripId: trip.id, commandId, at: new Date().toISOString() }));
  await expect(page.locator('.message.assistant .message-text').first()).toBeVisible({ timeout: 90000 });
  await page.screenshot({ path: 'output/quality-slower/reply.png', fullPage: true });
  const timing = await page.evaluate(() => (window as Window & { qualityTiming?: { click: number; user: number; assistant: number; text: string } }).qualityTiming!);
  const [saved, commands, events] = await Promise.all([
    db.from('roamer_trips').select('state').eq('id', trip.id).single(),
    db.from('roamer_commands').select('id,kind,status,delivery,created_at,updated_at').eq('trip_id', trip.id),
    db.from('roamer_events').select('type,payload,created_at').eq('trip_id', trip.id).in('type', ['assistant_message', 'grok_bundle'])
  ]);
  for (const result of [saved, commands, events]) if (result.error) throw result.error;
  const bundle = events.data!.find(event => event.type === 'grok_bundle');
  const message = events.data!.find(event => event.type === 'assistant_message');
  const result = { tripId: trip.id, workspace, commandId, prompt, reply: timing.text, replyWords: timing.text.split(/\s+/).length, timingsMs: { clickFeedback: timing.user - timing.click, clickToReply: timing.assistant - timing.click, commitToVisible: message ? timing.assistant - Date.parse(message.created_at) : null, grokToBridge: bundle?.payload.sentAt ? Date.parse(bundle.payload.observedAt) - Date.parse(bundle.payload.sentAt) : null }, criteria: visibleCriteria(saved.data!.state), requirements: saved.data!.state.requirements, commandCount: commands.data!.length, providerJobs: commands.data!.filter(command => command.kind !== 'conversation').length, conversationStatus: commands.data!.find(command => command.id === commandId)?.status };
  await writeFile('output/quality-slower/result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
