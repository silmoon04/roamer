import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyEvent, candidateStatus, candidateTotal, dates, initialState, parseModelBundles, requirementCheckPayloadSchema, requirementResults, suitabilityFingerprint, tripRequirements, withSuitability, type Candidate, type DomainEvent, type Quote, type TripState } from '../src/lib/domain';

const at = '2026-09-26T12:00:00.000Z'; const tripId = randomUUID();
function change(type: string, payload: Record<string, unknown>, revision = 0): DomainEvent { return { id: randomUUID(), tripId, type, payload, revision, occurredAt: at }; }
function pricedState(): TripState {
  const state = initialState(); state.confirmedCriteria = Object.keys(state.criteria) as (keyof typeof state.criteria)[]; const quote = (scope: Quote['scope']): Quote => ({ scope, total: 200, currency: 'GBP', travellers: 2, ...dates(state.criteria), checkedAt: at, url: 'https://example.com/room', label: scope === 'whole-stay' ? 'Selected private room' : 'Return flight', includes: 'Two adults', provider: 'Fixture' });
  state.candidates = [{ id: 'vienna', name: 'Vienna', country: 'Austria', airport: 'VIE', image: '', summary: 'Check 10–15 October', highlights: [], sources: [], status: 'checked', flight: quote('return-flights'), stay: quote('whole-stay') }]; state.phase = 'ready'; return state;
}
function check(state: TripState, status: 'supported' | 'contradicted' | 'unknown' = 'supported') {
  const candidate = state.candidates[0]; const requirement = tripRequirements(state)[0];
  return { candidateId: candidate.id, requirementId: requirement.id, status, summary: 'The selected room has the documented access route.', sources: [{ title: 'Property access statement', url: 'https://example.com/room/access', checkedAt: at, excerpt: 'Step-free entrance; lift serves the selected room floor.' }], fingerprint: suitabilityFingerprint(candidate, state.criteria, tripRequirements(state)), checkedAt: at };
}
const exact = 'The hotel must have a step-free entrance and a lift to my room, or a confirmed ground-floor room.';

describe('requirements and suitability evidence', () => {
  it('keeps a full original request intact when Grok weakens a later paraphrase', () => {
    let state = applyEvent(pricedState(), change('user_message', { text: exact }));
    state = applyEvent(state, change('profile_patch', { notes: [exact] })); state = applyEvent(state, change('trip_patch', { stayStyle: 'step-free or lift' }));
    expect(state.requirements?.some(requirement => requirement.text === exact && requirement.source === 'message')).toBe(true);
    expect(state.requirements?.some(requirement => requirement.text === exact && requirement.provenance?.some(source => source.source === 'profile'))).toBe(true);
    expect(state.candidates[0].status).not.toBe('checked');
  });
  it('requires suitability evidence even when both prices and car-free transport are checked', () => {
    const state = applyEvent(pricedState(), change('user_message', { text: 'Three real separate beds. No shared bed or sofa bed.' }));
    state.criteria.noCar = true; state.candidates[0].transport = { summary: 'Tram', verified: true, sources: [{ title: 'Operator', url: 'https://example.com/tram', checkedAt: at }] };
    expect(candidateTotal(state.candidates[0], state.criteria)).toBe(400); expect(candidateStatus(state.candidates[0], state.criteria, state.requirements)).toBe('partial'); expect(state.phase).toBe('checking');
  });
  it('does not infer bed configuration from party capacity or a property photo', () => {
    const state = applyEvent(pricedState(), change('user_message', { text: 'Three real separate beds, no sofa bed.' })); state.candidates[0].stay!.facts = { roomName: 'Apartment for three adults', beds: [{ type: 'large double bed', count: 1 }, { type: 'sofa bed', count: 1 }] };
    expect(requirementResults(state.candidates[0], state.criteria, state.requirements)[0].status).toBe('unknown'); expect(withSuitability(state).candidates[0].status).toBe('partial');
  });
  it('gates legacy ready snapshots with preserved profile notes on read', () => {
    const old = pricedState(); old.profile.notes = [exact]; delete old.requirements; const current = withSuitability(old);
    expect(current.requirements?.[0].text).toBe(exact); expect(current.phase).toBe('checking'); expect(current.candidates[0].status).toBe('partial'); expect(old.phase).toBe('ready');
  });
  it('gates explicit stay styles even when a caller has no saved ledger', () => { const state = pricedState(); expect(candidateStatus(state.candidates[0], { ...state.criteria, stayStyle: 'Private hotel room' })).toBe('partial'); });
  it('does not call known over-budget prices checked even without an extra request', () => { const state = pricedState(); expect(candidateStatus(state.candidates[0], { ...state.criteria, budget: 300 })).toBe('partial'); });
  it('accepts current source-backed evidence separately from the prices', () => {
    const state = applyEvent(pricedState(), change('user_message', { text: exact })); const next = applyEvent(state, change('requirement_check', check(state), state.revision));
    expect(next.candidates[0].status).toBe('checked'); expect(next.phase).toBe('ready'); expect(requirementResults(next.candidates[0], next.criteria, next.requirements)[0].status).toBe('supported');
  });
  it('keeps contradictions and unknown findings out of ready state', () => {
    for (const status of ['contradicted', 'unknown'] as const) { const state = applyEvent(pricedState(), change('user_message', { text: exact })); const next = applyEvent(state, change('requirement_check', check(state, status))); expect(next.candidates[0].status).toBe('partial'); expect(next.phase).toBe('checking'); expect(requirementResults(next.candidates[0], next.criteria, next.requirements)[0].status).toBe(status); }
  });
  it.each([{ sources: [] }, { sources: [{ title: 'Listing', url: 'https://example.com', checkedAt: at }] }, { sources: [{ title: 'Bad', url: 'javascript:alert(1)', checkedAt: at, excerpt: 'Claim' }] }])('rejects a supported claim without valid concrete source evidence: %j', patch => {
    const state = applyEvent(pricedState(), change('user_message', { text: exact })); const payload = { ...check(state), ...patch }; expect(requirementCheckPayloadSchema.safeParse(payload).success).toBe(false); expect(applyEvent(state, change('requirement_check', payload)).candidates[0].requirementChecks ?? []).toEqual([]);
  });
  it('accepts an honest unknown result without a fabricated source', () => { const state = applyEvent(pricedState(), change('user_message', { text: exact })); expect(requirementCheckPayloadSchema.safeParse({ ...check(state, 'unknown'), sources: [] }).success).toBe(true); });
  it('rejects evidence for an unknown requirement or an earlier revision', () => {
    const state = applyEvent(pricedState(), change('user_message', { text: exact })); expect(applyEvent(state, change('requirement_check', { ...check(state), requirementId: 'unknown' })).candidates[0].requirementChecks ?? []).toEqual([]);
    expect(applyEvent({ ...state, revision: 2 }, change('requirement_check', check(state), 1)).candidates[0].requirementChecks ?? []).toEqual([]);
  });
  it('invalidates a selected-room check after replacement or a different room fact', () => {
    const base = applyEvent(pricedState(), change('user_message', { text: exact })); const checked = applyEvent(base, change('requirement_check', check(base)));
    const replaced = applyEvent(checked, change('replace_stay', { id: 'vienna' })); expect(replaced.candidates[0].requirementChecks).toEqual([]);
    const changed = applyEvent(checked, change('quote', { candidateId: 'vienna', kind: 'stays', quote: { ...checked.candidates[0].stay, facts: { roomName: 'Different room' } } })); expect(changed.candidates[0].requirementChecks).toEqual([]); expect(changed.candidates[0].status).toBe('partial');
  });
  it('invalidates budget, date, price and newly added requirement evidence', () => {
    const base = applyEvent(pricedState(), change('user_message', { text: exact })); const checked = applyEvent(base, change('requirement_check', check(base)));
    const mutations = [change('trip_patch', { budget: 300 }), change('trip_patch', { departureDate: '2026-10-16' }), change('quote', { candidateId: 'vienna', kind: 'stays', quote: { ...checked.candidates[0].stay, total: 999 } }), change('profile_patch', { notes: ['Quiet private hotel room'] }), change('user_message', { text: 'Neither of us drives.' })];
    for (const mutation of mutations) { const next = applyEvent(checked, mutation); expect(next.candidates[0].requirementChecks).toEqual([]); expect(next.phase).not.toBe('ready'); }
  });
  it('preserves older notes when a model later omits them', () => { let state = applyEvent(pricedState(), change('profile_patch', { notes: [exact] })); state = applyEvent(state, change('profile_patch', { notes: [] })); expect(state.requirements?.map(requirement => requirement.text)).toContain(exact); });
  it('deduplicates exact whitespace-normalized requirements while preserving both source records', () => { let state = applyEvent(pricedState(), change('user_message', { text: 'Neither of us drives.' })); state = applyEvent(state, change('profile_patch', { notes: ['Neither  of us drives.'] })); expect(state.requirements).toHaveLength(1); expect(state.requirements![0].text).toBe('Neither of us drives.'); expect(state.requirements![0].provenance?.map(source => source.source)).toEqual(['message','profile']); });
  it('does not collapse different conjunctions or exclusions into one requirement', () => { let state = applyEvent(pricedState(), change('user_message', { text: 'Step-free entrance and lift.' })); state = applyEvent(state, change('profile_patch', { notes: ['Step-free entrance or lift.'] })); expect(state.requirements).toHaveLength(2); });
  it('preserves a current check when only duplicate provenance is added', () => { const before = applyEvent(pricedState(), change('user_message', { text: exact })); const checked = applyEvent(before, change('requirement_check', check(before))); const repeated = applyEvent(checked, change('profile_patch', { notes: [exact] })); expect(repeated.requirements).toHaveLength(1); expect(repeated.candidates[0].status).toBe('checked'); });
  it('retires every provenance record when the user removes a deduplicated requirement', () => { let state = applyEvent(pricedState(), change('user_message', { text: 'Neither of us drives.' })); state = applyEvent(state, change('profile_patch', { notes: ['Neither of us drives.'] })); const removed = applyEvent(state, change('requirement_edit', { id: state.requirements![0].id, text: null })); expect(tripRequirements(removed)).toEqual([]); expect(removed.retiredRequirementIds).toHaveLength(2); });
  it('preserves the question and exact clicked answer as original context', () => { let state = applyEvent(pricedState(), change('question', { id: 'beds', prompt: 'Which sleeping arrangement?', options: ['One room, three beds', 'Two rooms'] })); state = applyEvent(state, change('question_answered', { id: 'beds', answer: 'One room, three beds' })); expect(state.requirements?.[0].text).toBe('Which sleeping arrangement?\nAnswer: One room, three beds'); });
  it('allows an explicit user edit without resurrecting the retired source on later updates', () => {
    const state = applyEvent(pricedState(), change('user_message', { text: exact })); const id = state.requirements![0].id;
    const edited = applyEvent(state, change('requirement_edit', { id, text: 'A confirmed ground-floor room is enough.' })); expect(edited.revision).toBe(1); expect(edited.requirements?.map(requirement => requirement.text)).toEqual(['A confirmed ground-floor room is enough.']);
    const refreshed = applyEvent(edited, change('assistant_message', { text: 'Understood.' }, 1)); expect(refreshed.requirements?.some(requirement => requirement.id === id)).toBe(false);
  });
  it('allows the user to remove a field-derived requirement without regenerating it', () => { const state = pricedState(); state.criteria.stayStyle = 'Hotel only'; const current = withSuitability(state); const removed = applyEvent(current, change('requirement_edit', { id: current.requirements![0].id, text: null })); expect(removed.requirements).toEqual([]); expect(withSuitability(removed).requirements).toEqual([]); expect(removed.candidates[0].status).toBe('checked'); });
  it('does not let model output edit or remove original requirements', () => { expect(() => parseModelBundles(`<roamer>${JSON.stringify({ tripId, revision: 0, events: [{ type: 'requirement_edit', payload: { id: 'anything', text: null } }] })}</roamer>`)).toThrow(); });
  it('does not make standalone acknowledgements into requirements or discard attached constraints', () => { const thanks = applyEvent(pricedState(), change('user_message', { text: 'Thanks!' })); expect(thanks.messages[0].text).toBe('Thanks!'); expect(thanks.requirements).toEqual([]); const request = applyEvent(thanks, change('user_message', { text: 'Thanks, but we still need a step-free entrance.' })); expect(request.requirements?.map(requirement => requirement.text)).toEqual(['Thanks, but we still need a step-free entrance.']); });
  it('removes stale candidate date prose and ignores a late candidate update', () => { const next = applyEvent(pricedState(), change('trip_patch', { departureDate: '2026-10-16' })); expect(next.candidates[0].summary).toContain('2026-10-16 to 2026-10-21'); expect(next.candidates[0].summary).not.toContain('10–15'); expect(applyEvent(next, change('candidate', { ...next.candidates[0], summary: 'Check 10–15 October' }, 0)).candidates[0].summary).toBe(next.candidates[0].summary); });
  it('keeps the old date in original wording but verifies only the newly selected dates', () => {
    let state = applyEvent(pricedState(), change('user_message', { text: 'Five nights departing 12 October, with a private hotel room.' }));
    state = applyEvent(state, change('trip_patch', { departureDate: '2026-10-13' }));
    const reference = pricedState().candidates[0];
    state = applyEvent(state, change('quote', { candidateId: 'vienna', kind: 'flights', quote: { ...reference.flight, ...dates(state.criteria) } }, state.revision));
    state = applyEvent(state, change('quote', { candidateId: 'vienna', kind: 'stays', quote: { ...reference.stay, ...dates(state.criteria) } }, state.revision));
    expect(state.requirements?.[0].text).toContain('12 October'); expect(state.criteria.departureDate).toBe('2026-10-13');
    const verified = applyEvent(state, change('requirement_check', { ...check(state), summary: 'Private hotel room for the current 13–18 October trip.', sources: [{ title: 'Selected room', url: 'https://example.com/room', checkedAt: at, excerpt: 'Private hotel room, two adults, 13–18 October.' }] }, state.revision));
    expect(verified.candidates[0].status).toBe('checked'); expect(verified.candidates[0].stay?.departureDate).toBe('2026-10-13');
    const outdated = applyEvent(verified, change('quote', { candidateId: 'vienna', kind: 'stays', quote: { ...reference.stay, departureDate: '2026-10-12', returnDate: '2026-10-17' } }, verified.revision));
    expect(outdated.candidates[0].stay?.departureDate).toBe('2026-10-13');
  });
});
