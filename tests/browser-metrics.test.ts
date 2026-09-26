import { expect, it } from 'vitest';
import { browserMetricsForTrip } from '../src/lib/browser-metrics';
import { debugEventPayload } from '../src/lib/debug';

const tripId = '917b1e2b-2581-42db-8180-b08de53f9dad';
const metric = { type: 'interaction', tripId, ms: 22, at: '2026-09-26T15:00:00Z' };
it('keeps the recent timings for this trip without copying arbitrary browser data', () => {
  const copied = browserMetricsForTrip([{ ...metric, tripId: '9f6aa7e2-19ad-4096-b8c3-d7bf56e2b957' }, { ...metric, token: 'private' }, { ...metric, ms: -1 }, { ...metric, ms: Infinity }], tripId);
  expect(copied).toEqual([metric]);
  expect(browserMetricsForTrip(Array.from({length:100},(_,i)=>({...metric,ms:i})),tripId)).toHaveLength(30);
});
it('exports saved feedback timings with the observed version', () => {
  expect(debugEventPayload('debug_note',{note:'Late update',observedVersion:4,browserMetrics:[{...metric,secret:'private'}]})).toEqual({note:'Late update',observedVersion:4,browserMetrics:[metric]});
});
it('keeps database timestamps with offsets and distinguishes hidden-tab drawing', () => {
  const row={...metric,type:'realtime-render',committedAt:'2026-09-26T15:00:00.123456+00:00',receivedAt:'2026-09-26T15:00:00.500Z',renderedAt:'2026-09-26T15:03:00.000Z',visibilityState:'hidden',renderVisibilityState:'visible'};
  expect(browserMetricsForTrip([row],tripId)).toEqual([row]);
});
