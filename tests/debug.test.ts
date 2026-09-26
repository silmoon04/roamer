import { afterEach, expect, it, vi } from 'vitest';
import { debugCommandPayload, debugCommandTiming, debugEventPayload, redactDebugText } from '../src/lib/debug';
import { initialState } from '../src/lib/domain';
import type { TripRow } from '../src/lib/db';

afterEach(() => vi.unstubAllEnvs());
it('redacts configured secrets and credential patterns from otherwise useful text', () => {
  vi.stubEnv('ROAMER_ACCESS_CODE', 'private-demo-code');
  const result = redactDebugText('Checked Paris. private-demo-code Bearer abc123 api_key=secret-value sk-1234567890123456');
  expect(result).toContain('Checked Paris.'); for (const secret of ['private-demo-code','abc123','secret-value','sk-1234567890123456']) expect(result).not.toContain(secret);
});
it('does not export unrecognized provider payloads', () => { expect(debugEventPayload('provider_dump', { raw: 'large private response', password: 'bad' })).toEqual({ omitted: true }); });
it('exports human-facing events while omitting unexpected fields and nested credentials', () => {
  expect(debugEventPayload('assistant_message', { text: 'Checking Kraków.', raw: 'secret-response' })).toEqual({ text: 'Checking Kraków.' });
  expect(debugCommandPayload({ text: 'Two people', token: 'secret', destination: { name: 'Kraków', secret: 'secret' }, criteria: { nights: 5, apiKey: 'secret' } })).toEqual({ text: 'Two people', destination: { name: 'Kraków' }, criteria: { nights: 5 } });
});
it('retains bridge timestamps and saved critique for debugging', () => {
  expect(debugEventPayload('grok_bundle', { sentAt: 'a', observedAt: 'b', resultingRevision: 2, raw: 'private' })).toEqual({ sentAt: 'a', observedAt: 'b', resultingRevision: 2 });
  expect(debugEventPayload('debug_note', { note: 'The date picker was confusing.', clientAt: 'c' })).toEqual({ note: 'The date picker was confusing.', clientAt: 'c' });
});
it('bounds copied strings and source collections', () => {
  expect(redactDebugText('x'.repeat(7000))).toHaveLength(5000);
  const payload = debugEventPayload('browser_evidence', { sources: Array.from({ length: 50 }, () => ({ title: 'Source', url: 'https://example.com', raw: 'private' })) });
  expect(payload.sources).toHaveLength(5); expect(JSON.stringify(payload)).not.toContain('private');
});
const fixture = (): TripRow => ({ id: 'trip', owner_id: 'owner', workspace_id: 'personal', bot_id: 'bot', browser_bot_id: null, title: 'Trip', version: 1, is_replay: false, updated_at: '2026-09-26T12:00:00.000Z', state: initialState() });
const command = { id: 'job', kind: 'conversation', status: 'queued', created_at: '2026-09-26T12:00:00.000Z', updated_at: '2026-09-26T12:00:00.000Z', attempts: 0 };
it('keeps queue time separate from Grok runtime before a command is claimed', () => {
  const trip = fixture(); trip.state.actions.push({ id: 'job', kind: 'conversation', provider: 'Grok', label: 'Waiting', status: 'queued', startedAt: command.created_at });
  expect(debugCommandTiming(command, trip, Date.parse('2026-09-26T12:00:15Z'))).toEqual({ startedAt: null, queueMs: 15000, runtimeMs: null });
});
it('measures finished runtime from the actual action start', () => {
  const trip = fixture(); trip.state.actions.push({ id: 'job', kind: 'conversation', provider: 'Grok', label: 'Reply', status: 'done', startedAt: '2026-09-26T12:00:10.000Z', finishedAt: '2026-09-26T12:00:25.000Z' });
  expect(debugCommandTiming({ ...command, status: 'done', attempts: 1 }, trip, Date.parse('2026-09-26T12:01:00Z'))).toEqual({ startedAt: '2026-09-26T12:00:10.000Z', queueMs: 10000, runtimeMs: 15000 });
});
