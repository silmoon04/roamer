import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dates, initialState, suitabilityFingerprint, type Candidate, type TripState, type Quote } from '../src/lib/domain';

let authSession: unknown;
const measurements: { name: string; ms: number }[] = [];
test.beforeAll(async ({ request }) => {
  const response = await request.post('/api/login', { data: { code: process.env.ROAMER_ACCESS_CODE } });
  expect(response.status()).toBe(200); authSession = (await response.json()).session;
  mkdirSync('output/visual-state', { recursive: true });
});
test.afterAll(() => writeFileSync('output/visual-state/timings.json', JSON.stringify({ kind: 'Intercepted UI fixtures; no Grok commands or database writes', measurements }, null, 2)));

function populatedState(): TripState {
  const state = initialState(); state.criteria.departureDate = '2026-10-16'; state.criteria.travellers = 2; state.criteria.budget = 1400;
  state.confirmedCriteria = Object.keys(state.criteria) as (keyof typeof state.criteria)[];
  state.criteria.interests = ['Architecture', 'Local food'];
  state.requirements = [
    { id: 'step-free', text: 'A step-free entrance AND a lift to our room, or a confirmed ground-floor room. Do not infer access from photos.', source: 'message', sourceId: 'original-access' },
    { id: 'hotel', text: 'A private hotel room. No hostels or holiday apartments.', source: 'message', sourceId: 'original-stay' },
    { id: 'quiet', text: 'A quiet neighbourhood, with tram or rail nearby and less than 3 km of walking each day.', source: 'message', sourceId: 'original-pace' }
  ];
  state.messages = [{ id: 'assistant-1', role: 'assistant', text: 'The room price is available. The lift and entrance still need checking.', at: new Date().toISOString() }];
  const quote: Quote = { total: 190, currency: 'GBP', travellers: 2, ...dates(state.criteria), checkedAt: new Date().toISOString(), url: 'https://example.com/flight', label: 'London–Vienna return', scope: 'return-flights', includes: 'Two adults, cabin bags', provider: 'Deterministic test fixture' };
  const candidate: Candidate = { id: 'vienna', name: 'Vienna', country: 'Austria', airport: 'VIE', image: '/images/ljubljana.jpg', summary: 'Fixture photography and provider evidence for interface verification only.', highlights: ['Architecture', 'Local food'], sources: [], flight: quote, stay: { ...quote, total: 430, label: 'Long property name with a garden and a very detailed room description', scope: 'whole-stay', url: 'https://example.com/stay', includes: 'Five nights, one room, two adults; breakfast and local taxes included.', image: '/images/porto.jpg' }, status: 'partial' };
  const fingerprint = suitabilityFingerprint(candidate, state.criteria, state.requirements);
  candidate.requirementChecks = [
    { requirementId: 'hotel', status: 'contradicted', summary: 'The listing describes a holiday apartment, not a hotel room.', sources: [{ title: 'Property listing', url: 'https://example.com/property', checkedAt: quote.checkedAt, excerpt: 'Entire apartment with one bedroom and a private kitchen.' }], fingerprint, checkedAt: quote.checkedAt },
    { requirementId: 'quiet', status: 'supported', summary: 'The quiet-area and short tram routes are confirmed in this fixture.', sources: [{ title: 'Fixture transport evidence', url: 'https://example.com/transport', checkedAt: quote.checkedAt, excerpt: 'Residential street; tram stop 150 m away. Daily walking itinerary: 2.4 km.' }], fingerprint, checkedAt: quote.checkedAt }
  ];
  state.candidates = [candidate];
  state.actions = [{ id: 'access-check', kind: 'browser', label: 'Checking the entrance and lift in Vienna', provider: 'Grok browser', destination: 'Vienna', status: 'queued', startedAt: new Date().toISOString() }];
  return state;
}

async function mockWorkspace(page: Page, state: TripState = populatedState()) {
  const id = randomUUID();
  let trip = { id, owner_id: 'browser-fixture', workspace_id: 'stress-slower', bot_id: randomUUID(), browser_bot_id: randomUUID(), title: 'Isolated UI fixture', state, version: 1, is_replay: false, updated_at: new Date().toISOString() };
  const commands: Record<string, any>[] = [];
  let delay = 500;
  let commandHook: ((body: Record<string, any>) => void) | undefined;
  const project = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
  await page.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: `sb-${project}-auth-token`, session: authSession });
  await page.route('**/api/trips**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() === 'POST') {
      if (path !== `/api/trips/${id}/commands`) { await route.fulfill({ status: 409, json: { error: 'Fixture rejects non-command writes.' } }); return; }
      const body = request.postDataJSON(); commands.push(body);
      await new Promise(resolve => setTimeout(resolve, delay));
      if (commandHook) commandHook(body);
      else if (body.kind === 'message') trip.state.messages.push({ id: body.id, role: 'user', text: body.text, at: new Date().toISOString() });
      else if (body.kind === 'answer') trip.state.questions = trip.state.questions.map(q => q.id === body.questionId ? { ...q, answer: body.answer, skipped: body.skipped } : q);
      else if (body.kind === 'save') trip.state.candidates = trip.state.candidates.map(c => c.id === body.candidateId ? { ...c, saved: body.saved } : c);
      trip = { ...trip, state: structuredClone(trip.state), version: trip.version + 1, updated_at: new Date().toISOString() };
      await route.fulfill({ json: { trip } }); return;
    }
    if (path === '/api/trips') { await route.fulfill({ json: { trips: [trip] } }); return; }
    if (path === `/api/trips/${id}/debug`) { await route.fulfill({ json: { serverTime: new Date().toISOString(), trip: { id, workspaceId: 'stress-slower', version: trip.version, revision: trip.state.revision, phase: trip.state.phase, botId: trip.bot_id, botName: 'Roamer Test Slower' }, commands: [], events: [], worker: { status: 'online', heartbeat: new Date().toISOString() } } }); return; }
    if (path === `/api/trips/${id}`) { await route.fulfill({ json: { trip, worker: { status: 'online', heartbeat: new Date().toISOString() } } }); return; }
    await route.fulfill({ status: 404, json: { error: 'Not part of this fixture.' } });
  });
  await page.goto(`/?trip=${id}`); await expect(page.locator('.app-shell')).toHaveAttribute('data-trip-id', id);
  return {
    id, commands,
    setDelay(ms: number) { delay = ms; },
    onCommand(hook: (body: Record<string, any>) => void) { commandHook = hook; },
    get state() { return trip.state; },
    async update(next: TripState) { trip = { ...trip, state: structuredClone(next), version: trip.version + 1, updated_at: new Date().toISOString() }; await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); }
  };
}

for (const width of [390, 768, 1280, 1440]) test(`evidence cards and questions stay usable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width < 1000 ? 844 : 1000 });
  const state = populatedState(); state.questions = [{ id: 'time', prompt: 'Would you prefer an early flight or a later departure?', options: ['Early flight', 'Later departure', 'Either works'] }];
  await mockWorkspace(page, state);
  if (width < 1000) await page.getByRole('tab', { name: 'Your trip', exact: true }).click();
  const card = page.locator('.candidate-card'); await card.scrollIntoViewIfNeeded();
  await expect(card.getByText('Prices checked', { exact: true })).toBeVisible();
  await expect(card.locator('.candidate-price-preview')).toContainText('£620');
  await expect(page.locator('.trip-details-fold')).not.toHaveAttribute('open', '');
  expect(await page.locator('.trip-scroll').evaluate(el=>Array.from(el.children).findIndex(node=>node.classList.contains('candidate-list'))<Array.from(el.children).findIndex(node=>node.classList.contains('trip-details-fold')))).toBe(true);
  await expect(card.getByText('Needs checking', { exact: true })).toBeVisible();
  await expect(card.getByText('Doesn’t meet', { exact: true })).toBeVisible();
  await expect(card.getByText('Verified', { exact: true })).toBeVisible();
  const mismatch = card.locator('.candidate-requirements li.contradicted'); await mismatch.locator('summary').click();
  await expect(mismatch.getByText('Entire apartment with one bedroom and a private kitchen.', { exact: true })).toBeVisible();
  await expect(mismatch.getByRole('link', { name: 'Property listing' })).toHaveAttribute('href', 'https://example.com/property');
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].filter(img => img.getBoundingClientRect().width).map(img => img.decode().catch(() => {}))); });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.trip-scroll').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const interactive = await card.locator('button,a,summary').evaluateAll(elements => elements.filter(el => el.getBoundingClientRect().width).map(el => ({ text: el.textContent?.trim(), height: el.getBoundingClientRect().height })));
  expect(interactive.filter(el => el.height < 43.5)).toEqual([]);
  await page.screenshot({ path: `output/visual-state/evidence-${width}.png`, fullPage: true });
  if (width < 1000) {
    await page.locator('.mobile-trip-question').scrollIntoViewIfNeeded(); await expect(page.locator('.mobile-trip-question').getByRole('button', { name: 'Later departure', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  }
  await page.getByLabel('Message Roamer').fill('A draft to preserve while comparing the options.');
  await page.getByRole('button', { name: 'Edit trip details', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Edit trip details', exact: true })).toBeFocused();
  await expect(page.getByLabel('Message Roamer')).toHaveValue('A draft to preserve while comparing the options.');
});

test('pending answers and messages respond immediately while searches continue', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = populatedState(); state.questions = [{ id: 'time', prompt: 'Which departure works?', options: ['Early flight', 'Later departure'] }];
  const fixture = await mockWorkspace(page, state); fixture.setDelay(1200);
  await page.getByRole('button', { name: 'Later departure', exact: true }).first().click();
  await expect(page.locator('.answered-question strong')).toHaveText('Later departure');
  await expect(page.locator('.inline-activity')).toContainText('Checking the entrance and lift in Vienna');
  await expect.poll(() => fixture.commands.length).toBe(1);
  await page.getByLabel('Message Roamer').fill('Keep the dates, but make the room quieter.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await expect(page.locator('.sending-label')).toHaveText('Saving…');
  await expect(page.locator('.sending-label')).not.toBeVisible();
  expect(fixture.commands.map(command => command.kind)).toEqual(['answer', 'message']);
  const metrics = await page.evaluate(() => (window as unknown as { __ROAMER_METRICS: { type: string; ms: number }[] }).__ROAMER_METRICS ?? []);
  const clicks = metrics.filter(metric => metric.type === 'interaction');
  expect(clicks).toHaveLength(2); expect(clicks.every(metric => metric.ms < 100)).toBe(true);
  measurements.push(...clicks.map(metric => ({ name: 'optimistic interaction to animation frame', ms: metric.ms })));
  await page.screenshot({ path: 'output/visual-state/answered-pending-390.png', fullPage: true });
});

test('fallback updates preserve card order, selection, expanded evidence and drafts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const fixture = await mockWorkspace(page);
  await page.getByLabel('Message Roamer').fill('Keep this draft.');
  const next = structuredClone(fixture.state); next.candidates[0].image = '/images/porto.jpg';
  await fixture.update(next); await expect(page.getByLabel('New trip updates')).toBeVisible();
  await page.locator('#trip-view-tab').click(); await expect(page.getByLabel('New trip updates')).not.toBeVisible();
  const card = page.locator('.candidate-card'); await card.scrollIntoViewIfNeeded();
  await card.locator('.source-details summary').click();
  await card.locator('.candidate-summary').evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); });
  const selection = await page.evaluate(() => window.getSelection()?.toString());
  const scroll = await page.locator('.trip-scroll').evaluate(el => el.scrollTop);
  const update = structuredClone(fixture.state); update.candidates[0].saved = true; update.actions[0].status = 'running';
  await fixture.update(update); await expect(page.getByRole('button', { name: 'Unsave Vienna', exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selection);
  expect(await page.locator('.trip-scroll').evaluate(el => el.scrollTop)).toBe(scroll);
  await expect(card.locator('.source-details')).toHaveAttribute('open', '');
  await expect(card.locator('.candidate-photo img')).toHaveAttribute('src', '/images/porto.jpg');
  await page.getByRole('tab', { name: 'Chat', exact: true }).click(); await expect(page.getByLabel('Message Roamer')).toHaveValue('Keep this draft.');
  const metrics = await page.evaluate(() => (window as unknown as { __ROAMER_METRICS: { type: string; ms: number }[] }).__ROAMER_METRICS ?? []);
  measurements.push(...metrics.filter(metric => metric.type === 'poll-render').map(metric => ({ name: 'intercepted fallback response to animation frame', ms: metric.ms })));
});

test('stale quote snapshots cannot relabel old prices with new dates or occupancy', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); const state = populatedState();
  state.criteria.departureDate = '2026-10-18'; state.criteria.travellers = 3;
  await mockWorkspace(page, state);
  const card = page.locator('.candidate-card'); await card.scrollIntoViewIfNeeded();
  await expect(card.locator('.quote-stale')).toBeVisible();
  await expect(card.getByRole('link', { name: 'See flight to Vienna' })).not.toBeVisible();
  await expect(card.getByRole('link', { name: 'See stay in Vienna' })).not.toBeVisible();
  await expect(card.locator('.cost-summary')).not.toBeVisible();
  await expect(card.getByText('Prices checked', { exact: true })).not.toBeVisible();
  await expect(card.locator('.candidate-requirements .unknown')).toHaveCount(3);
  await page.screenshot({ path: 'output/visual-state/stale-quotes-1440.png', fullPage: true });
});

test('failed photos, worker interruption and reduced motion have deliberate states', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.setViewportSize({ width: 390, height: 844 });
  const state = populatedState(); state.candidates[0].image = '/images/missing-test-photo.jpg';
  state.actions[0] = { ...state.actions[0], status: 'error', retryable: false, detail: 'The browser worker stopped before confirming whether the request was delivered.' };
  await page.route('**/images/missing-test-photo.jpg', route => route.fulfill({ status: 404, body: '' }));
  const fixture = await mockWorkspace(page, state);
  await expect(page.getByText('1 check needs attention.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check Grok', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check Grok', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Roamer Test Slower');
  await page.keyboard.press('Escape'); await page.locator('.candidate-card').scrollIntoViewIfNeeded();
  await expect(page.locator('.candidate-photo .photo-fallback')).toContainText('Photo unavailable');
  expect(fixture.commands).toHaveLength(0);
  expect(await page.locator('.spin').evaluateAll(elements => elements.every(el => getComputedStyle(el).animationName === 'none'))).toBe(true);
  await page.screenshot({ path: 'output/visual-state/photo-and-worker-failure-390.png', fullPage: true });
});

test('requirements can be edited and removal stays staged until saved', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); const fixture = await mockWorkspace(page);
  await page.locator('.requirements-note summary').click(); await page.getByRole('button', { name: 'Edit requirements', exact: true }).click();
  const firstForm = page.getByRole('dialog').locator('form').first();
  await firstForm.getByRole('button', { name: 'Remove request', exact: true }).click();
  await expect(firstForm.getByText('This request will be removed when you save.', { exact: true })).toBeVisible(); expect(fixture.commands).toHaveLength(0);
  await firstForm.getByRole('button', { name: 'Save removal', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible(); expect(fixture.commands).toHaveLength(1);
  expect(fixture.commands[0]).toMatchObject({ kind: 'requirement', requirementId: 'step-free', text: null });
});

test('fresh chat is centred, fields stay blank and one essentials submission supplies the missing details', async ({page})=>{
  await page.setViewportSize({width:1440,height:1000});const fixture=await mockWorkspace(page,initialState());
  await expect(page.locator('.workspace')).toHaveClass(/chat-only/);await expect(page.locator('#trip-panel')).not.toBeVisible();
  await expect(page.getByText('£1,000',{exact:false})).not.toBeVisible();
  const box=await page.locator('#chat-panel').boundingBox();expect(box).not.toBeNull();expect(Math.abs(box!.x+box!.width/2-720)).toBeLessThan(2);
  await page.getByRole('button',{name:'Edit trip details',exact:true}).click();
  for(const label of ['Leaving from','People','Total budget (£)','Nights','Earliest departure','Latest departure','Specific departure (optional)'])await expect(page.getByRole('dialog').getByLabel(label,{exact:true})).toHaveValue('');
  await expect(page.getByRole('button',{name:'Save trip details',exact:true})).toBeDisabled();await page.keyboard.press('Escape');
  await page.screenshot({path:'output/visual-state/fresh-centred-1440.png',fullPage:true});
  await page.getByLabel('Message Roamer').fill('I would like a short city break.');await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.locator('.sending-label')).not.toBeVisible();
  await expect(page.locator('#trip-panel')).not.toBeVisible();
  const next=structuredClone(fixture.state);next.criteria.origin='Edinburgh';next.confirmedCriteria=['origin'];next.messages.push({id:'reply',role:'assistant',text:'Edinburgh is the starting point. How many people are travelling, and what is the total budget?',at:new Date().toISOString()});
  await fixture.update(next);await expect(page.locator('#trip-panel')).toBeVisible();await expect(page.locator('.criteria-card')).toContainText('Budget not set');
  const essentials=page.getByRole('form',{name:'Trip essentials'});await expect(essentials).toBeVisible();
  await essentials.getByLabel('People',{exact:true}).fill('1');await essentials.getByLabel('Total budget (£)',{exact:true}).fill('850');
  await essentials.getByRole('button',{name:'Send details',exact:true}).click();await expect(essentials.getByText('Saved. Waiting for Grok to update the trip.',{exact:true})).toBeVisible();
  expect(fixture.commands).toHaveLength(2);expect(fixture.commands[1].text).toBe('1 traveller. £850 total budget for everyone.');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'output/visual-state/essentials-390.png',fullPage:true});
});

test('a blank criteria editor submits only entered fields and explicit GBP currency',async({page})=>{
  await page.setViewportSize({width:1440,height:1000});const fixture=await mockWorkspace(page,initialState());
  await page.getByRole('button',{name:'Edit trip details',exact:true}).click();await page.getByLabel('Leaving from',{exact:true}).fill('Edinburgh');await page.getByLabel('People',{exact:true}).fill('1');await page.getByLabel('Total budget (£)',{exact:true}).fill('850');
  await page.getByRole('button',{name:'Save trip details',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible();expect(fixture.commands).toHaveLength(1);
  expect(fixture.commands[0].patch).toEqual({origin:'Edinburgh',travellers:1,budget:850,currency:'GBP'});
});
