import { describe, expect, it, vi } from 'vitest';
import type { CommandRow } from '../lib/db';
import { requestScopedStop } from './deadline';
import { priceUpdate } from './progress';

const make = (): CommandRow => ({ id: 'task', trip_id: 'trip', owner_id: 'owner', revision: 1, kind: 'browser', payload: {}, status: 'running', delivery: 'unknown', created_at: '2026-09-26T12:00:00.000Z' });
describe('bounded owned browser work', () => {
  it('records one distinct stop request before sending, without claiming the work has stopped', async () => {
    const command = make(); const records: Record<string, string>[] = [];
    const record = async (fields: Record<string, string>) => { records.push(fields); command.payload = { ...command.payload, ...fields }; };
    const send = vi.fn(async (id, text, guard) => { expect(command.payload.stopDelivery).toBe('unknown'); expect(guard()).toBe(true); expect(id).not.toBe(command.id); expect(text).toContain('command task'); return { accepted: true }; });
    await requestScopedStop(command, { isCurrent: () => true, record, send });
    expect(command.payload.stopDelivery).toBe('accepted'); expect(JSON.stringify(records)).not.toContain('stopped');
    await requestScopedStop(command, { isCurrent: () => true, record, send });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not stop a bot once the lane belongs to another command', async () => {
    const command = make(); let current = true; const send = vi.fn();
    const record = vi.fn(async fields => { command.payload = { ...command.payload, ...fields }; current = false; });
    await requestScopedStop(command, { isCurrent: () => current, record, send });
    expect(send).not.toHaveBeenCalled(); expect(command.payload.stopDelivery).toBe('not_sent');
  });
  it('checks ownership again after a queued CLI stop gains its slot', async () => {
    const command = make(); let current = true;
    const record = async (fields: Record<string, string>) => { command.payload = { ...command.payload, ...fields }; };
    const send = vi.fn(async (_id, _text, guard) => { current = false; return { skipped: !guard() }; });
    await requestScopedStop(command, { isCurrent: () => current, record, send });
    expect(command.payload.stopDelivery).toBe('not_sent');
  });
  it('keeps an ambiguous stop unknown and never resends it', async () => {
    const command = make(); const record = async (fields: Record<string, string>) => { command.payload = { ...command.payload, ...fields }; };
    const send = vi.fn().mockRejectedValue(new Error('Timed out'));
    await requestScopedStop(command, { isCurrent: () => true, record, send });
    await requestScopedStop(command, { isCurrent: () => true, record, send });
    expect(command.payload.stopDelivery).toBe('unknown'); expect(send).toHaveBeenCalledTimes(1);
  });
});
describe('immediate factual findings', () => {
  it('publishes the actual party, dates and price scope without declaring a complete trip or impersonating speech', () => {
    const message = priceUpdate('Porto', 'stays', { total: 490.66, currency: 'GBP', travellers: 3, departureDate: '2026-10-16', returnDate: '2026-10-21', checkedAt: '2026-09-26T12:00:00.000Z', url: 'https://www.booking.com/hotel/pt/example', label: 'Selected room', scope: 'whole-stay', includes: 'Tax treatment unconfirmed', provider: 'Booking.com via Apify' });
    expect(message).toContain('£490.66'); expect(message).toContain('whole stay, 3 people, 2026-10-16–2026-10-21'); expect(message).toContain('separate checks');
    expect(message).not.toMatch(/I found|I checked|trip total|all included|perfect/i);
  });
});
