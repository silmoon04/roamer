import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultCriteria, suitabilityFingerprint, type Candidate, type TripRequirement } from '../lib/domain';
import type { CommandRow } from '../lib/db';
import { contradictsStayStyle, normalizeFlights, normalizeStays, searchFlights, stayFacts, stayTaxDescription, type ProviderContext } from '../lib/providers';
import { writeFile } from 'node:fs/promises';
import { assistantText, bundlesFromEntry, gbot, setBotAllowlist, stableId } from './bridge';
import { backoffDelay, retryConnection } from './resilience';
import { acceptsBrowserQuote, browserScope, browserTaskIsCurrent } from './browser-scope';
import { allowedBotEvent, commandBot, receiptMatches, registeredBots, transcriptKey } from './bots';
import { requirementRequest, transportRequest } from './research-prompts';
import { browserProtocol, protocol } from './protocol';

const context: ProviderContext = { id: 'test', criteria: { ...defaultCriteria, departureDate: '2026-10-10' }, destination: { name: 'Kraków', country: 'Poland', airport: 'KRK' } };
const at = '2026-09-26T12:00:00.000Z';
describe('model protocol shape', () => {
  it('gives every bot an explicit payload-wrapped event example that the parser accepts', () => {
    for (const prompt of [protocol, browserProtocol('price'), browserProtocol('requirements'), browserProtocol('transport')]) {
      const example = prompt.match(/<roamer>(.*?)<\/roamer>/)?.[0]
        .replace('EXACT_REQUEST_TRIP_ID', '11111111-1111-4111-8111-111111111111')
        .replace('EXACT_REQUEST_COMMAND_ID', '22222222-2222-4222-8222-222222222222')
        .replace('EXACT_REQUEST_REVISION', '0');
      expect(example).toBeTruthy();
      expect(bundlesFromEntry({ id: 'example', kind: 'send-message', message: { type: 'text', content: example } })[0].events).toEqual([{ type: 'assistant_message', payload: { text: 'Your short reply.' } }]);
    }
  });
  it('uses one free-text essentials request without inventing selectable travel facts', () => {
    expect(protocol).toContain('Do not emit a question event for this intake');
    expect(protocol).toContain('Omit unknown and unchanged fields from trip_patch.payload');
  });
});
const flight = { origin: 'STN', destination: 'KRK', departureDate: '2026-10-10', returnDate: '2026-10-15', tripType: 'round-trip', currency: 'GBP', price: 142, airlines: ['Ryanair'], outbound: { segments: [{}] }, return: { segments: [{}] } };
const stay = { name: 'An actual stay', currency: '£', checkInDate: '2026-10-10', checkOutDate: '2026-10-15', url: 'https://www.booking.com/hotel/pl/test.html?group_adults=2', image: 'https://cf.bstatic.com/test.jpg', rooms: [{ available: true, roomType: 'Apartment', options: [{ price: 329.62, displayedPrice: 308.12, excludedTaxesPrice: 21.50, persons: 2, currency: '£', hasGeniusDiscount: false, yourChoices: ['Non-refundable'] }] }] };
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn().mockResolvedValue(undefined), writeFile: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('provider evidence normalization', () => {
  it('keeps the actor party price once and dates both return legs', () => {
    const quote = normalizeFlights([flight], context, at, 'run')[0];
    expect(quote.total).toBe(142); expect(quote.travellers).toBe(2); expect(quote.scope).toBe('return-flights');
    expect(decodeURIComponent(quote.url)).toContain('2 adults'); expect(decodeURIComponent(quote.url)).toContain('2026-10-15');
  });
  it('rejects wrong dates, currencies, destinations and missing return legs', () => {
    expect(normalizeFlights([{ ...flight, currency: 'USD' }, { ...flight, returnDate: '2026-10-16' }, { ...flight, destination: 'OPO' }, { ...flight, return: null }, { recordType: 'raw_response', googleResponses: [] }], context, at, 'run')).toEqual([]);
  });
  it('keeps whole stay total including listed taxes, without multiplying nights', () => {
    const quote = normalizeStays([stay], context, at, 'run')[0];
    expect(quote.total).toBe(329.62); expect(quote.includes).toContain('£21.50'); expect(quote.includes).toContain('Non-refundable');
  });
  it('rejects mismatched occupancy, member-only rates and excluded stays', () => {
    expect(normalizeStays([{ ...stay, url: 'https://www.booking.com/hotel/pl/test?group_adults=1' }], context, at, 'run')).toEqual([]);
    expect(normalizeStays([stay], context, at, 'run', 'An actual stay')).toEqual([]);
    const member = structuredClone(stay); member.rooms[0].options[0].hasGeniusDiscount = true;
    expect(normalizeStays([member], context, at, 'run')).toEqual([]);
  });
  it('does not accept a hotel headline price without a matching available room', () => {
    expect(normalizeStays([{ ...stay, price: 100, rooms: [] }], context, at, 'run')).toEqual([]);
  });
});
describe('provider transport recovery', () => {
  it('does not repeat an actor launch after an ambiguous network failure', async () => {
    vi.stubEnv('APIFY_TOKEN', 'test-token');
    const fetch = vi.fn().mockRejectedValue(new Error('Network interruption'));
    vi.stubGlobal('fetch', fetch);
    await expect(searchFlights(context)).rejects.toThrow('Network interruption');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].method).toBe('POST');
  });
  it('rejects the live double-and-sofa layout for three real beds even though it sleeps three', () => {
    const room = { ...stay.rooms[0], bedTypes: [{ room: 'Bedroom 1', beds: ['1 large double bed'] }, { room: 'Living room', beds: ['1 sofa bed'] }], options: [{ ...stay.rooms[0].options[0], persons: 3 }] };
    const row = { ...stay, type: 'apartment', url: 'https://www.booking.com/hotel/pt/test?group_adults=3', rooms: [room] };
    const three = { ...context, criteria: { ...context.criteria, travellers: 3, stayStyle: 'one room, three real beds, flexible cancellation' } };
    expect(stayFacts(row, room, room.options[0]).beds).toEqual([{ type: 'large double bed', count: 1 }, { type: 'sofa bed', count: 1 }]);
    expect(normalizeStays([row], three, at, 'run')).toEqual([]);
  });
  it('selects a sourced compatible room option instead of the cheapest incompatible one', () => {
    const row = { ...stay, type: 'hotel', rooms: [
      { ...stay.rooms[0], roomType: 'Double', bedTypes: [{ beds: ['1 double bed'] }] },
      { ...stay.rooms[0], roomType: 'Twin', bedTypes: [{ beds: ['2 single beds'] }], options: [{ ...stay.rooms[0].options[0], price: 400, displayedPrice: 378.5, yourChoices: ['Free cancellation before 8 October 2026'] }] }
    ] };
    const quote = normalizeStays([row], { ...context, criteria: { ...context.criteria, stayStyle: 'hotel, two separate beds, flexible cancellation' } }, at, 'run')[0];
    expect(quote.total).toBe(400); expect(quote.includes).toContain('Twin');
  });
  it('keeps unknown bed arrangements provisional and never combines alternative layouts', () => {
    expect(stayFacts({}, { bedTypes: [{ beds: ['1 double bed or 2 single beds'] }] }, {}).beds).toBeUndefined();
    expect(contradictsStayStyle({ roomName: 'Sleeps three' }, 'three real beds')).toBe(false);
  });
  it('does not substitute an apartment for an explicit hotel requirement', () => {
    expect(contradictsStayStyle({ propertyType: 'apartment' }, 'quiet hotel, ground floor and lift')).toBe(true);
    expect(contradictsStayStyle({ propertyType: 'apartment' }, 'Private hotel room')).toBe(true);
    expect(contradictsStayStyle({ propertyType: 'apartment' }, 'Quiet private hotel room, step-free entrance AND lift')).toBe(true);
    expect(contradictsStayStyle({ propertyType: 'apartment' }, 'hotel or apartment')).toBe(false);
    expect(contradictsStayStyle({ propertyType: 'hotel' }, 'not a hotel')).toBe(false);
  });
  it('records exact selected-room accessibility without turning a lift into step-free access', () => {
    const facts = stayFacts({ facilities: [{ name: 'Lift' }] }, { facilities: ['Upper floors accessible by elevator', 'Entire unit located on ground floor'] }, {});
    expect(facts.accessibility).toBe('Upper floors accessible by elevator · Entire unit located on ground floor');
    expect(stayFacts({ facilities: [{ name: 'Lift' }] }, {}, {}).accessibility).toBeUndefined();
    expect(contradictsStayStyle(facts, 'step-free bathroom AND lift')).toBe(false);
  });
  it('rejects a rate priced for a different number of guests even when room capacity is enough', () => {
    const otherParty = structuredClone(stay); otherParty.rooms[0].options[0].persons = 3;
    expect(normalizeStays([otherParty], context, at, 'run')).toEqual([]);
  });
  it('only describes taxes as included when the source price breakdown balances', () => {
    expect(stayTaxDescription({ price: 490.6647797593034, displayedPrice: 451.928086620411, excludedTaxesPrice: 38.7366931388924 })).toContain('includes');
    expect(stayTaxDescription({ price: 450, displayedPrice: 450, excludedTaxesPrice: 38 })).toContain('unconfirmed');
    expect(stayTaxDescription({ price: 450 })).toContain('unconfirmed');
  });
  it('retries a transient dataset read without launching a second actor', async () => {
    vi.stubEnv('APIFY_TOKEN', 'test-token');
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { id: 'run-test', status: 'SUCCEEDED', defaultDatasetId: 'dataset-test', finishedAt: at } }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json([flight]));
    vi.stubGlobal('fetch', fetch);
    const quotes = await searchFlights(context);
    expect(quotes[0].total).toBe(142);
    expect(fetch.mock.calls.filter(call => call[1].method === 'POST')).toHaveLength(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body).sortBy).toBe('best');
    expect(fetch.mock.calls.filter(call => call[1].method === 'GET')).toHaveLength(2);
  });
  it('preserves the failed actor receipt before surfacing its failure', async () => {
    vi.stubEnv('APIFY_TOKEN', 'test-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ data: { id: 'failed-run-test', status: 'FAILED', defaultDatasetId: 'failed-dataset' } })));
    await expect(searchFlights(context)).rejects.toThrow('failed');
    expect(writeFile).toHaveBeenCalledWith('.roamer/evidence/test-failed.json', expect.stringContaining('failed-run-test'));
  });
});
describe('worker connection recovery', () => {
  it('survives startup failures, then returns the recovered result without replaying it', async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error('Network unavailable')).mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce('connected');
    const wait = vi.fn().mockResolvedValue(undefined); const failed = vi.fn();
    expect(await retryConnection(operation, { stopped: () => false, wait, failed })).toBe('connected');
    expect(operation).toHaveBeenCalledTimes(3); expect(failed).toHaveBeenCalledTimes(2);
    expect(wait.mock.calls.map(c => c[0])).toEqual([500, 1000]);
  });
  it('stops reconnecting when shutdown is requested and caps the delay', async () => {
    let stopped = false; const operation = vi.fn().mockRejectedValue(new Error('Offline'));
    expect(await retryConnection(operation, { stopped: () => stopped, wait: async () => { stopped = true; }, failed: () => undefined })).toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(1); expect(backoffDelay(100)).toBe(10000);
  });
});
describe('browser task boundaries', () => {
  const criteria = { ...defaultCriteria, noCar: true };
  const candidate: Candidate = { id: 'krakow-krk', name: 'Kraków', country: 'Poland', airport: 'KRK', image: '', summary: '', highlights: [], sources: [], status: 'partial', stay: normalizeStays([stay], context, at, 'run')[0] };
  const command = (purpose: 'price' | 'transport'): CommandRow => ({ id: 'browser-task', trip_id: 'trip', owner_id: 'owner', revision: 1, kind: 'browser', status: 'queued', created_at: at, payload: { purpose, priceKind: purpose === 'price' ? 'flights' : undefined, candidateId: candidate.id, browserScope: browserScope(criteria, candidate, purpose, purpose === 'price' ? 'flights' : undefined) } });
  it('rejects stale price dates but preserves an unaffected budget change', () => {
    expect(browserTaskIsCurrent(command('price'), criteria, [candidate])).toBe(true);
    expect(browserTaskIsCurrent(command('price'), { ...criteria, budget: 1200 }, [candidate])).toBe(true);
    expect(browserTaskIsCurrent(command('price'), { ...criteria, departureDate: '2026-10-11' }, [candidate])).toBe(false);
    expect(browserTaskIsCurrent(command('price'), { ...criteria, originCode: 'MAN' }, [candidate])).toBe(false);
  });
  it('rejects transport checks for a different or removed stay', () => {
    expect(browserTaskIsCurrent(command('transport'), criteria, [candidate])).toBe(true);
    expect(browserTaskIsCurrent(command('transport'), criteria, [{ ...candidate, stay: undefined }])).toBe(false);
    expect(browserTaskIsCurrent(command('transport'), criteria, [{ ...candidate, stay: { ...candidate.stay!, label: 'A different stay' } }])).toBe(false);
    expect(browserTaskIsCurrent(command('transport'), { ...criteria, noCar: false }, [candidate])).toBe(false);
  });
  it('rejects removed destinations and legacy tasks without a verified scope', () => {
    expect(browserTaskIsCurrent(command('price'), criteria, [])).toBe(false);
    const legacy = command('price'); delete legacy.payload.browserScope;
    expect(browserTaskIsCurrent(legacy, criteria, [candidate])).toBe(false);
  });
  it('accepts browser prices only for their active requested task and candidate', () => {
    const active = command('price');
    expect(acceptsBrowserQuote(active, active.id, candidate.id, 'flights')).toBe(true);
    expect(acceptsBrowserQuote(active, undefined, candidate.id, 'flights')).toBe(false);
    expect(acceptsBrowserQuote(active, active.id, 'other', 'flights')).toBe(false);
    expect(acceptsBrowserQuote(active, active.id, candidate.id, 'stays')).toBe(false);
    expect(acceptsBrowserQuote(command('transport'), active.id, candidate.id, 'flights')).toBe(false);
    expect(acceptsBrowserQuote(undefined, active.id, candidate.id, 'flights')).toBe(false);
  });
  it('retires a requirements check when the exact wording or selected room changes', () => {
    const requirements: TripRequirement[] = [{ id: 'access', text: 'Ground floor access AND a lift', source: 'message', sourceId: 'message' }];
    const task = { ...command('transport'), payload: { purpose: 'requirements', candidateId: candidate.id, browserScope: browserScope(criteria, candidate, 'requirements', undefined, requirements) } };
    expect(browserTaskIsCurrent(task, criteria, [candidate], requirements)).toBe(true);
    expect(browserTaskIsCurrent(task, criteria, [candidate], [{ ...requirements[0], text: 'Ground floor access OR a lift' }])).toBe(false);
    expect(browserTaskIsCurrent(task, criteria, [{ ...candidate, stay: { ...candidate.stay!, facts: { beds: [{ type: 'sofa bed', count: 1 }] } } }], requirements)).toBe(false);
  });
  it('keeps transport tied to the stated interests and exact requirement ledger', () => {
    const request = transportRequest({ ...criteria, interests: ['art', 'food'] }, candidate);
    expect(request).toContain('art, food'); expect(request).not.toMatch(/hik|walking area/);
    expect(request).toContain('AND/OR');
    const requirements: TripRequirement[] = [{ id: 'access', text: 'Step-free bathroom AND a lift', source: 'message', sourceId: 'message' }];
    const task = { ...command('transport'), payload: { ...command('transport').payload, browserScope: browserScope(criteria, candidate, 'transport', undefined, requirements) } };
    expect(browserTaskIsCurrent(task, criteria, [candidate], requirements)).toBe(true);
    expect(browserTaskIsCurrent(task, criteria, [candidate], [{ ...requirements[0], text: 'Step-free bathroom OR a lift' }])).toBe(false);
    expect(requirementRequest(candidate, ['access'], suitabilityFingerprint(candidate, criteria, requirements))).toContain('AND/OR/exclusion');
  });
});
describe('Grok bridge boundaries', () => {
  const text = '<roamer>{"tripId":"11111111-1111-4111-8111-111111111111","revision":0,"events":[{"type":"assistant_message","payload":{"text":"Hello"}}]}</roamer>';
  it('never ingests JSON echoed in a user message', () => {
    expect(assistantText({ id: 'a', kind: 'message', role: 'user', content: text })).toBe('');
    expect(bundlesFromEntry({ id: 'a', kind: 'message', role: 'user', content: text })).toEqual([]);
  });
  it('accepts actual assistant send-message events', () => {
    expect(bundlesFromEntry({ id: 'a', kind: 'send-message', message: { type: 'text', content: text } })).toHaveLength(1);
  });
  it('rejects fabricated model quotes and malformed JSON', () => {
    expect(() => bundlesFromEntry({ id: 'a', kind: 'send-message', message: { type: 'text', content: text.replace('assistant_message', 'quote') } })).toThrow();
    expect(() => bundlesFromEntry({ id: 'a', kind: 'send-message', message: { type: 'text', content: '<roamer>{bad}</roamer>' } })).toThrow();
  });
  it('produces repeatable database UUIDs for transcript deduplication', () => {
    expect(stableId('same')).toBe(stableId('same'));
    expect(stableId('same')).not.toBe(stableId('different'));
    expect(stableId('same')).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-8[a-f\d]{3}-[a-f\d]{12}$/);
  });
});

describe('isolated workspace bot routing', () => {
  const workspaces = [
    { id: 'personal', owner_id: 'owner', bot_id: 'personal-bot', bot_name: 'Personal', browser_bot_id: 'personal-research' },
    { id: 'stress-friends', owner_id: 'owner', bot_id: 'friends-bot', bot_name: 'Friends', browser_bot_id: null },
    { id: 'other', owner_id: 'other-owner', bot_id: 'other-bot', bot_name: 'Other', browser_bot_id: null },
    { id: 'legacy', owner_id: 'owner', bot_id: 'legacy-bot', bot_name: 'Travel Agent', browser_bot_id: null }
  ];
  const registry = registeredBots(workspaces, 'owner');
  const command: CommandRow = { id: 'command', trip_id: 'friends-trip', owner_id: 'owner', revision: 0, kind: 'conversation', status: 'error', delivery: 'unknown', created_at: at, payload: {} };
  const personal = registry.find(bot => bot.id === 'personal-bot')!;
  const friends = registry.find(bot => bot.id === 'friends-bot')!;
  it('routes independent personas and reserves the personal research bot for browser jobs', () => {
    expect(commandBot(command, workspaces[0], registry)?.id).toBe('personal-bot');
    expect(commandBot({ kind: 'browser' }, workspaces[0], registry)?.id).toBe('personal-research');
    expect(commandBot(command, workspaces[1], registry)?.id).toBe('friends-bot');
    expect(commandBot({ kind: 'browser' }, workspaces[1], registry)?.id).toBe('friends-bot');
    expect(commandBot({ kind: 'research' }, workspaces[1], registry)).toBeUndefined();
    expect(registry.map(bot => bot.id)).not.toContain('other-bot');
    expect(registry.map(bot => bot.id)).not.toContain('legacy-bot');
    expect(personal.alwaysPoll).toBe(true); expect(friends.alwaysPoll).toBe(false);
  });
  it('rejects missing, foreign and arbitrary bindings instead of falling back to a shared bot', async () => {
    expect(() => commandBot(command, {}, registry)).toThrow('not registered');
    expect(() => commandBot(command, workspaces[2], registry)).toThrow('not registered');
    setBotAllowlist(registry);
    await expect(gbot(['send', 'arbitrary-bot', 'Do not send'])).rejects.toThrow('allowlist');
    await expect(gbot(['send', 'Friends', 'Do not send'])).rejects.toThrow('allowlist');
  });
  it('accepts a late sent receipt after timeout without requiring an active waiter or resending', () => {
    expect(receiptMatches(friends, friends, command, command.trip_id, command.id)).toBe(true);
    expect(receiptMatches(personal, friends, command, command.trip_id, command.id)).toBe(false);
    expect(receiptMatches(friends, friends, command, 'personal-trip', command.id)).toBe(false);
    expect(receiptMatches(friends, friends, command, command.trip_id, 'another-command')).toBe(false);
    expect(receiptMatches(friends, friends, { ...command, delivery: undefined }, command.trip_id, command.id)).toBe(false);
    expect(receiptMatches(friends, friends, { ...command, status: 'queued' }, command.trip_id, command.id)).toBe(false);
  });
  it('namespaces identical opaque transcript entries by their bot', () => {
    expect(stableId(transcriptKey(friends, 't1s0', 0, 'applied'))).not.toBe(stableId(transcriptKey(personal, 't1s0', 0, 'applied')));
    expect(stableId(transcriptKey(friends, 't1s0', 0, 'applied'))).toBe(stableId(transcriptKey(friends, 't1s0', 0, 'applied')));
  });
  it('restricts browser replies to their issued purpose and candidate', () => {
    const browser = { ...command, kind: 'browser', payload: { purpose: 'price', priceKind: 'flights', candidateId: 'porto' } };
    expect(allowedBotEvent(browser, 'assistant_message', { text: 'Checking.' })).toBe(true);
    expect(allowedBotEvent(browser, 'browser_quote', { candidateId: 'porto', kind: 'flights' })).toBe(true);
    expect(allowedBotEvent(browser, 'browser_quote', { candidateId: 'krakow', kind: 'flights' })).toBe(false);
    expect(allowedBotEvent(browser, 'browser_quote', { candidateId: 'porto', kind: 'stays' })).toBe(false);
    expect(allowedBotEvent(browser, 'trip_patch', { budget: 2000 })).toBe(false);
    expect(allowedBotEvent(browser, 'profile_patch', { noCar: false })).toBe(false);
    expect(allowedBotEvent(browser, 'search_request', { destinations: [] })).toBe(false);
    expect(allowedBotEvent(browser, 'browser_evidence', { candidateId: 'porto' })).toBe(false);
    expect(allowedBotEvent({ ...browser, payload: { purpose: 'transport', candidateId: 'porto' } }, 'browser_evidence', { candidateId: 'porto' })).toBe(true);
    expect(allowedBotEvent(command, 'browser_quote', { candidateId: 'porto', kind: 'flights' })).toBe(false);
    expect(allowedBotEvent(undefined, 'browser_evidence', { candidateId: 'porto' })).toBe(false);
    expect(allowedBotEvent(undefined, 'requirement_check', { candidateId: 'porto' })).toBe(false);
    const requirements = { ...browser, payload: { purpose: 'requirements', candidateId: 'porto', requirementIds: ['beds'], suitabilityFingerprint: 'scope' } };
    expect(allowedBotEvent(requirements, 'requirement_check', { candidateId: 'porto', requirementId: 'beds', fingerprint: 'scope' })).toBe(true);
    expect(allowedBotEvent(requirements, 'requirement_check', { candidateId: 'porto', requirementId: 'access', fingerprint: 'scope' })).toBe(false);
    expect(allowedBotEvent(requirements, 'requirement_check', { candidateId: 'porto', requirementId: 'beds', fingerprint: 'oldscope' })).toBe(false);
    expect(allowedBotEvent(browser, 'requirement_check', { candidateId: 'porto', requirementId: 'beds', fingerprint: 'scope' })).toBe(false);
  });
  it('gives each browser purpose only its matching output contract', () => {
    expect(browserProtocol('requirements')).toContain('requirement_check');
    expect(browserProtocol('requirements')).not.toContain('browser_quote');
    expect(browserProtocol('price')).toContain('browser_quote');
    expect(browserProtocol('price')).not.toContain('requirement_check');
    expect(() => browserProtocol('unknown')).toThrow();
  });
});
