import { describe, expect, it } from 'vitest';
import { CliGate, pollingPolicy } from './polling';
import { protocol } from './protocol';

describe('reply polling priority', () => {
  it('keeps unused tester/research lanes dormant after a restart', () => {
    expect(pollingPolicy(false, false, 0, 1000000).enabled).toBe(false);
    expect(pollingPolicy(true, false, 0, 1000000)).toMatchObject({ enabled: true, intervalMs: 2000 });
    expect(pollingPolicy(false, true, 0, 1000000)).toMatchObject({ enabled: true, intervalMs: 2000, priority: 1 });
  });
  it('retains slower late-receipt recovery without competing at active-reply priority', () => {
    expect(pollingPolicy(false, false, 999000, 1000000)).toMatchObject({ enabled: true, priority: 0, intervalMs: 5000 });
    expect(pollingPolicy(false, false, 800000, 1000000)).toMatchObject({ enabled: true, priority: 0, intervalMs: 10000 });
    expect(pollingPolicy(false, false, 300000, 1000000).enabled).toBe(false);
  });
  it('sends first, then reads active replies, before queued background polling', async () => {
    const gate = new CliGate(1), order: string[] = [];
    const release = await gate.acquire(0);
    const background = gate.acquire(0).then(done => { order.push('background'); done(); });
    const active = gate.acquire(1).then(done => { order.push('active'); done(); });
    const send = gate.acquire(2).then(done => { order.push('send'); done(); });
    release(); await Promise.all([background, active, send]);
    expect(order).toEqual(['send', 'active', 'background']);
  });
  it('directs the conversation bot to reply without waiting for browser research', () => {
    expect(protocol).toContain('Do not browse, run tools, or wait for research');
    expect(protocol).toContain('one or two sentences');
  });
});
