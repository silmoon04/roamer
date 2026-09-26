import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { applyEvent, browserQuotePayloadSchema, candidateStatus, candidateTotal, criteriaSchema, dates, defaultCriteria, fingerprint, initialState, parseModelBundles, quoteMatches, type Candidate, type DomainEvent, type Quote, type TripState } from '../src/lib/domain';

const tripId = randomUUID();
const at = '2026-09-26T12:00:00.000Z';
function event(type: string, payload: Record<string, unknown>, revision = 0): DomainEvent { return { id: randomUUID(), tripId, type, payload, revision, occurredAt: at }; }
function quote(scope: Quote['scope'] = 'return-flights', total = 240): Quote { return { total, currency: 'GBP', travellers: 2, ...dates(defaultCriteria), checkedAt: at, url: 'https://example.com/booking', label: scope === 'whole-stay' ? 'Old Town Stay' : 'London to Kraków', scope, includes: 'Two travellers', provider: 'fixture' }; }
function candidate(): Candidate { return { id: 'krakow', name: 'Kraków', country: 'Poland', airport: 'KRK', image: '/krakow.jpg', summary: 'A walkable city', highlights: ['Food'], sources: [], flight: quote(), stay: quote('whole-stay', 400), status: 'checked', transport: { summary: 'Bus to the trail', verified: true, sources: [{ title: 'Bus schedule', url: 'https://example.com/transit', checkedAt: at }] } }; }
function state(): TripState { return { ...initialState(), confirmedCriteria: Object.keys(defaultCriteria) as (keyof typeof defaultCriteria)[], candidates: [candidate()], actions: [{ id: 'flight-search', label: 'Checking flights', provider: 'Apify', kind: 'flights', status: 'running', startedAt: at }] }; }

describe('criteria and model validation', () => {
  it('rejects reversed windows', () => expect(criteriaSchema.safeParse({ ...defaultCriteria, departureEnd: '2026-10-01' }).success).toBe(false));
  it('rejects fixed departure outside the window', () => expect(criteriaSchema.safeParse({ ...defaultCriteria, departureDate: '2026-10-25' }).success).toBe(false));
  it('rejects impossible calendar dates', () => expect(criteriaSchema.safeParse({ ...defaultCriteria, departureStart: '2026-02-30' }).success).toBe(false));
  it('rejects unexpected criteria fields', () => expect(criteriaSchema.safeParse({ ...defaultCriteria, injected: true }).success).toBe(false));
  it('adds nights across month and year boundaries in UTC', () => expect(dates({ ...defaultCriteria, departureDate: '2026-12-29' })).toEqual({ departureDate: '2026-12-29', returnDate: '2027-01-03' }));
  it('accepts structured model output amid speech', () => expect(parseModelBundles(`Hello <roamer>${JSON.stringify({ tripId, revision: 0, events: [{ type: 'assistant_message', payload: { text: 'Checking flights.' } }] })}</roamer>`)).toHaveLength(1));
  it('rejects malformed model JSON', () => expect(() => parseModelBundles('<roamer>{bad}</roamer>')).toThrow('invalid Roamer event'));
  it('rejects unsupported model events', () => expect(() => parseModelBundles(`<roamer>${JSON.stringify({ tripId, revision: 0, events: [{ type: 'purchase', payload: {} }] })}</roamer>`)).toThrow('invalid Roamer event'));
  it('rejects model source JavaScript URLs', () => expect(() => parseModelBundles(`<roamer>${JSON.stringify({ tripId, revision: 0, events: [{ type: 'browser_evidence', payload: { candidateId: 'krakow', summary: 'Bus', noCarVerified: true, sources: [{ title: 'Bus', url: 'javascript:alert(1)', checkedAt: at }] } }] })}</roamer>`)).toThrow('invalid Roamer event'));
  it('keeps initial profile arrays independent from trip interests', () => { const s = initialState(); s.criteria.interests.push('hiking'); expect(s.profile.interests).toEqual([]); });
});

describe('search revisions and evidence', () => {
  it('invalidates both prices on date change and retires affected actions', () => { const s = applyEvent(state(), event('trip_patch', { departureDate: '2026-10-12' })); expect(s.revision).toBe(1); expect(s.candidates[0].flight).toBeUndefined(); expect(s.candidates[0].stay).toBeUndefined(); expect(s.actions[0].status).toBe('superseded'); });
  it('preserves flights when only stay style changes', () => { const s = applyEvent(state(), event('trip_patch', { stayStyle: 'Small guesthouse' })); expect(s.candidates[0].flight).toEqual(quote()); expect(s.candidates[0].stay).toBeUndefined(); expect(s.actions[0].status).toBe('running'); });
  it('preserves accommodation when origin changes', () => { const s = applyEvent(state(), event('trip_patch', { origin: 'Manchester', originCode: 'MAN' })); expect(s.candidates[0].flight).toBeUndefined(); expect(s.candidates[0].stay).toEqual(quote('whole-stay', 400)); });
  it('requires fresh transport evidence after no-car preference changes', () => { const s = applyEvent(state(), event('trip_patch', { noCar: true })); expect(s.candidates[0].transport).toBeUndefined(); expect(s.candidates[0].status).toBe('partial'); expect(candidateTotal(s.candidates[0], s.criteria)).toBe(640); });
  it('invalidates seasonal transport evidence when dates change', () => { const s = applyEvent(state(), event('trip_patch', { departureDate: '2026-10-12' })); expect(s.candidates[0].transport).toBeUndefined(); });
  it('preserves prices on budget change', () => { const s = applyEvent(state(), event('trip_patch', { budget: 800 })); expect(candidateTotal(s.candidates[0], s.criteria)).toBe(640); });
  it('retires destination evidence and jobs when the requested region changes', () => { const s = applyEvent(state(), event('trip_patch', { region: 'Asia' })); expect(s.candidates).toEqual([]); expect(s.actions[0].status).toBe('superseded'); });
  it('does not revise unchanged criteria', () => expect(applyEvent(state(), event('trip_patch', { budget: 1000 })).revision).toBe(0));
  it('cannot resurrect a superseded action', () => { const s = applyEvent(state(), event('trip_patch', { departureDate: '2026-10-12' })); expect(applyEvent(s, event('action', { ...s.actions[0], status: 'running' })).actions[0].status).toBe('superseded'); });
  it('preserves an explicit unsafe-to-retry state on an uncertain delivery', () => { const before = state(); const s = applyEvent(before, event('action', { ...before.actions[0], status: 'error', retryable: false, detail: 'Check the existing Grok conversation.' })); expect(s.actions[0].retryable).toBe(false); expect(s.actions[0].status).toBe('error'); });
  it('does not supersede the conversation which is updating trip details', () => { const before = state(); before.actions.push({ ...before.actions[0], id: 'conversation', kind: 'conversation' }); const s = applyEvent(before, event('trip_patch', { noCar: true, interests: ['hiking'] })); expect(s.actions.find(a => a.id === 'conversation')?.status).toBe('running'); });
  it('retires an obsolete provider error after its search inputs change', () => { const before = state(); before.actions[0].status = 'error'; const s = applyEvent(before, event('trip_patch', { departureDate: '2026-10-12' })); expect(s.actions[0].status).toBe('superseded'); });
  it('keeps provider errors visible when unrelated preferences change', () => { const before = state(); before.actions[0].status = 'error'; const s = applyEvent(before, event('trip_patch', { noCar: true })); expect(s.actions[0].status).toBe('error'); });
  it('rejects old dates even when event revision is current', () => { let s = applyEvent(state(), event('trip_patch', { departureDate: '2026-10-12' })); s = applyEvent(s, event('quote', { candidateId: 'krakow', kind: 'flights', quote: quote() }, 1)); expect(s.candidates[0].flight).toBeUndefined(); });
  it('rejects late quotes for the previous origin', () => { let s = applyEvent(state(), event('trip_patch', { originCode: 'MAN', origin: 'Manchester' })); s = applyEvent(s, event('quote', { candidateId: 'krakow', kind: 'flights', quote: quote(), fingerprint: fingerprint(defaultCriteria, 'flights') }, 0)); expect(s.candidates[0].flight).toBeUndefined(); });
  it('accepts an unaffected in-flight quote with its matching fingerprint', () => { let s = applyEvent(state(), event('candidate', candidate() as unknown as Record<string, unknown>)); s = applyEvent(s, event('trip_patch', { budget: 800 })); s.candidates[0].flight = undefined; s = applyEvent(s, event('quote', { candidateId: 'krakow', kind: 'flights', quote: quote(), fingerprint: fingerprint(defaultCriteria, 'flights') }, 0)); expect(s.candidates[0].flight?.total).toBe(240); });
  it('rejects partial scope as a full-stay quote', () => { const c = candidate(); c.stay!.scope = 'return-flights'; expect(candidateTotal(c, defaultCriteria)).toBeNull(); });
  it.each([NaN, Infinity, -10, 0])('rejects invalid price %s', total => expect(quoteMatches({ ...quote(), total }, defaultCriteria)).toBe(false));
  it('rejects mismatched traveller count', () => expect(quoteMatches({ ...quote(), travellers: 1 }, defaultCriteria)).toBe(false));
  it('requires source evidence for no-car verification', () => { const c = candidate(); c.transport!.sources = []; expect(candidateStatus(c, { ...defaultCriteria, noCar: true })).toBe('partial'); });
  it('replacement preserves flights, invalidates transport, and increments revision', () => { const s = applyEvent(state(), event('replace_stay', { id: 'krakow' })); expect(s.candidates[0].flight).toBeDefined(); expect(s.candidates[0].stay).toBeUndefined(); expect(s.candidates[0].transport).toBeUndefined(); expect(s.revision).toBe(1); });
  it('new accommodation cannot inherit old accommodation transport evidence', () => { const s = applyEvent(state(), event('quote', { candidateId: 'krakow', kind: 'stays', quote: { ...quote('whole-stay'), label: 'New stay' } })); expect(s.candidates[0].transport).toBeUndefined(); });
});

describe('browser price evidence', () => {
  function payload(kind: 'flights' | 'stays' = 'flights') {
    return { candidateId: 'krakow', kind, quote: { ...quote(kind === 'flights' ? 'return-flights' : 'whole-stay', 360), provider: 'Grok browser (Google Flights)' }, sources: [{ title: 'The checked fare', url: 'https://example.com/booking', checkedAt: at, excerpt: 'Two adults, return, 10–15 October.' }] };
  }
  function missingFlight() { const s = state(); s.candidates[0].flight = undefined; return s; }
  it('accepts a current complete browser quote and retains the inspected source', () => {
    const p = payload(); const bundles = parseModelBundles(`<roamer>${JSON.stringify({ tripId, revision: 0, events: [{ type: 'browser_quote', payload: p }] })}</roamer>`);
    expect(bundles[0].events[0].type).toBe('browser_quote');
    const s = applyEvent(missingFlight(), event('browser_quote', p)); expect(s.candidates[0].flight?.total).toBe(360); expect(s.candidates[0].sources).toEqual(p.sources); expect(candidateTotal(s.candidates[0], s.criteria)).toBe(760);
  });
  it('requires source evidence before accepting a browser price', () => { const p = { ...payload(), sources: [] }; expect(browserQuotePayloadSchema.safeParse(p).success).toBe(false); expect(applyEvent(missingFlight(), event('browser_quote', p)).candidates[0].flight).toBeUndefined(); });
  it.each([
    { departureDate: '2026-10-11' }, { returnDate: '2026-10-16' }, { travellers: 1 }, { currency: 'USD' },
    { scope: 'whole-stay' }, { total: 0 }, { total: -50 }, { url: 'javascript:alert(1)' },
    { checkedAt: 'not-a-time' }, { provider: 'Apify' }
  ])('rejects browser quotes with mismatched or invalid details %j', patch => { const p = payload(); const bad = { ...p, quote: { ...p.quote, ...patch } }; const s = applyEvent(missingFlight(), event('browser_quote', bad)); expect(s.candidates[0].flight).toBeUndefined(); expect(s.candidates[0].sources).toEqual([]); });
  it('rejects non-HTTP evidence links', () => { const p = payload(); p.sources[0].url = 'file:///private/fare'; expect(browserQuotePayloadSchema.safeParse(p).success).toBe(false); expect(applyEvent(missingFlight(), event('browser_quote', p)).candidates[0].flight).toBeUndefined(); });
  it('rejects earlier revision even when prices would match unchanged dates', () => { const s = missingFlight(); s.revision = 1; const next = applyEvent(s, event('browser_quote', payload(), 0)); expect(next.candidates[0].flight).toBeUndefined(); expect(next.candidates[0].sources).toEqual([]); });
  it('invalidates transport evidence when a browser finds a different stay', () => { const p = payload('stays'); p.quote.label = 'A different hotel'; const s = applyEvent(state(), event('browser_quote', p)); expect(s.candidates[0].stay?.label).toBe('A different hotel'); expect(s.candidates[0].transport).toBeUndefined(); });
  it('does not derive prices from assistant prose', () => { const s = applyEvent(missingFlight(), event('assistant_message', { text: 'The flight is £200 for two.' })); expect(s.candidates[0].flight).toBeUndefined(); expect(candidateTotal(s.candidates[0], s.criteria)).toBeNull(); });
});

describe('conversation state', () => {
  it('does not mutate prior snapshots', () => { const before = state(); applyEvent(before, event('trip_patch', { budget: 700 })); expect(before.criteria.budget).toBe(1000); });
  it('deduplicates messages by event ID', () => { const e = event('assistant_message', { text: 'Flights checked.' }); const s = applyEvent(applyEvent(initialState(), e), e); expect(s.messages).toHaveLength(1); });
  it('keeps the first answer when a late voice answer arrives', () => { let s = applyEvent(initialState(), event('question', { id: 'car', prompt: 'Will you drive?', options: ['Yes', 'No'] })); s = applyEvent(s, event('question_answered', { id: 'car', answer: 'No' })); s = applyEvent(s, event('question_answered', { id: 'car', answer: 'Yes' })); expect(s.questions[0].answer).toBe('No'); });
  it('does not revive a skipped question', () => { let s = applyEvent(initialState(), event('question', { id: 'car', prompt: 'Will you drive?', options: ['Yes', 'No'] })); s = applyEvent(s, event('question_answered', { id: 'car', answer: '', skipped: true })); s = applyEvent(s, event('question', { id: 'car', prompt: 'Drive?', options: ['Yes', 'No'] })); expect(s.questions[0].skipped).toBe(true); });
  it('updates a candidate without reordering cards', () => { const s = state(); s.candidates.push({ ...candidate(), id: 'porto', name: 'Porto' }); const next = applyEvent(s, event('candidate', { ...candidate(), summary: 'Updated' })); expect(next.candidates.map(c => c.id)).toEqual(['krakow', 'porto']); });
  it('stores profile preferences separately from trip criteria', () => { const s = applyEvent(initialState(), event('profile_patch', { interests: ['hiking'] })); expect(s.profile.interests).toEqual(['hiking']); expect(s.criteria.interests).toEqual([]); });
});
