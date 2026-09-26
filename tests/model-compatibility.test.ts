import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseModelBundles } from '../src/lib/domain';
const tripId = randomUUID(); const commandId = randomUUID();
const parse = (events: unknown[], extra: Record<string, unknown> = {}) => parseModelBundles(`<roamer>${JSON.stringify({ tripId, commandId, revision: 3, events, ...extra })}</roamer>`);
it('normalizes a known flattened reply and question while preserving receipt identity', () => {
  const result = parse([{ type: 'assistant_message', text: 'Where are you departing from?' }, { type: 'question', id: 'origin', prompt: 'Where are you departing from?', options: ['London','Another city'] }]);
  expect(result).toEqual([{ tripId, commandId, revision: 3, events: [{ type: 'assistant_message', payload: { text: 'Where are you departing from?' } }, { type: 'question', payload: { id: 'origin', prompt: 'Where are you departing from?', options: ['London','Another city'] } }] }]);
});
it('normalizes a flattened discovery request through its existing schema', () => { expect(parse([{ type: 'search_request', destinations: [{ name: 'Montego Bay', country: 'Jamaica', airport: 'MBJ', reason: 'Requested Jamaica' }] }])[0].events[0]).toMatchObject({ type: 'search_request', payload: { destinations: [{ airport: 'MBJ' }] } }); });
it.each([
  { type: 'purchase', amount: 1000 },
  { type: 'trip_patch', budget: null },
  { type: 'assistant_message', payload: { text: 'Nested' }, text: 'Conflicting flat value' },
  { type: 'assistant_message', payload: null, text: 'Do not replace a present null payload' },
  { type: 'assistant_message', text: 'Hello', injected: 'Unrecognized field' },
  { type: 'trip_patch', budget: 1000, owner_id: 'different-owner' },
  { type: 'requirement_edit', id: 'protected', text: null },
  { type: 'browser_evidence', candidateId: 'jamaica', summary: 'Claim', noCarVerified: true, sources: [{ title: 'Bad link', url: 'javascript:alert(1)', checkedAt: '2026-09-26T12:00:00Z' }] }
])('still rejects unsupported, conflicting or invalid flattened data: %j', event => { expect(() => parse([event])).toThrow('invalid Roamer event'); });
it('does not relax the bundle identity or revision contract', () => { expect(() => parse([{ type: 'assistant_message', text: 'Hi' }], { revision: -1 })).toThrow(); expect(() => parse([{ type: 'assistant_message', text: 'Hi' }], { tripId: 'not-a-uuid' })).toThrow(); });
it('preserves already valid nested events', () => { expect(parse([{ type: 'trip_patch', payload: { region: 'Jamaica' } }])[0].events[0]).toEqual({ type: 'trip_patch', payload: { region: 'Jamaica' } }); });
