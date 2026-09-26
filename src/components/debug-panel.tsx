'use client';

import { useEffect, useState } from 'react';
import { Bug, ChevronDown, Clock3, Download, MessageSquare, RefreshCw, X } from 'lucide-react';
import { browserMetricsForTrip } from '@/lib/browser-metrics';

type DebugCommand = { id: string; kind: string; status: string; created_at: string; updated_at: string; delivery?: string; error?: string; startedAt?: string; queueMs?: number | null; runtimeMs?: number | null; payload?: Record<string, unknown> };
type DebugEvent = { id: string; seq: number; type: string; revision: number; occurred_at: string; created_at: string; payload: Record<string, unknown> };
type DebugData = { serverTime: string; trip: { id: string; workspaceId: string; version: number; revision: number; phase: string; botId: string; botName: string; browserBotId?: string }; worker?: { status: string; heartbeat: string }; commands: DebugCommand[]; events: DebugEvent[] };
type Api = (path: string, body?: unknown) => Promise<any>;
const duration = (ms?: number | null) => ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const time = (date: string) => new Date(date).toLocaleTimeString('en-GB', { hour12: false });

export default function DebugPanel({ tripId, api }: { tripId?: string; api: Api }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<DebugData | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<'timing' | 'events' | 'notes'>('timing');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refreshed, setRefreshed] = useState('');

  useEffect(() => { setOpen(new URLSearchParams(location.search).get('debug') === '1'); }, []);
  useEffect(() => { setData(null); setError(''); setSaved(false); }, [tripId]);
  useEffect(() => {
    if (!open || !tripId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api(`/api/trips/${tripId}/debug`);
        if (!disposed) { setData(next); setError(''); setRefreshed(new Date().toISOString()); }
      } catch (e) { if (!disposed) setError((e as Error).message); }
      finally { if (!disposed) timer = setTimeout(refresh, 5000); }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [tripId, open, api]);

  function exportData() {
    const metrics = browserMetricsForTrip((window as unknown as { __ROAMER_METRICS?: unknown[] }).__ROAMER_METRICS, tripId ?? '');
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...data, browserMetrics: metrics }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `roamer-debug-${tripId}.json`; link.click(); URL.revokeObjectURL(url);
  }
  async function saveNote() {
    if (!note.trim() || !tripId || saving) return;
    setSaving(true); setSaved(false);
    try {
      const browserMetrics = browserMetricsForTrip((window as unknown as { __ROAMER_METRICS?: unknown[] }).__ROAMER_METRICS, tripId);
      await api(`/api/trips/${tripId}/debug`, { note: note.trim(), clientAt: new Date().toISOString(), observedVersion: data?.trip.version, browserMetrics });
      setNote(''); setSaved(true);
    }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  }
  const recentReply = data?.events.findLast(e => e.type === 'grok_bundle' && e.payload.sentAt && e.payload.observedAt);
  const bridgeMs = recentReply ? Date.parse(String(recentReply.payload.observedAt)) - Date.parse(String(recentReply.payload.sentAt)) : null;
  const metrics = typeof window === 'undefined' ? [] : (window as unknown as { __ROAMER_METRICS?: { type: string; ms: number; tripId?: string; committedAt?: string; receivedAt?: string; renderedAt?: string; visibilityState?: string; renderVisibilityState?: string }[] }).__ROAMER_METRICS ?? [];
  const click = metrics.filter(m => m.tripId === tripId && m.type === 'interaction').at(-1);
  const update = metrics.filter(m => m.tripId === tripId && m.type === 'realtime-render' && m.committedAt && m.receivedAt && m.visibilityState !== 'hidden' && m.renderVisibilityState !== 'hidden').at(-1);

  return <aside className={`debug-panel ${open ? 'open' : ''}`} aria-label="Trip debugging">
    <div className="debug-toolbar">
      <button className="debug-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="debug-content"><Bug size={16} />Debug view<ChevronDown size={15} /></button>
      <span className="debug-bot">{data?.trip.botName ?? 'Timing, inputs & outputs'}</span>
      {open && <><button onClick={exportData} disabled={!data} aria-label="Export debug data"><Download size={15} /><span>Export JSON</span></button><button onClick={() => setOpen(false)} aria-label="Close debug view"><X size={18} /></button></>}
    </div>
    {open && <div id="debug-content" className="debug-content">
      <div className="debug-navigation" aria-label="Debug sections">
        <button aria-pressed={view === 'timing'} onClick={() => setView('timing')}><Clock3 size={14} />Timing & tasks</button>
        <button aria-pressed={view === 'events'} onClick={() => setView('events')}><RefreshCw size={14} />Inputs & outputs</button>
        <button aria-pressed={view === 'notes'} onClick={() => setView('notes')}><MessageSquare size={14} />Your feedback</button>
        <small>{refreshed ? `Updated ${time(refreshed)}` : 'Loading saved events…'}</small>
      </div>
      {error && <p className="debug-error" role="status">{error}</p>}
      <div className="debug-scroll">
        {view === 'timing' && <>
          <div className="debug-metrics"><span>Last click <strong>{duration(click?.ms)}</strong></span><span>Database → screen <strong>{duration(update ? Date.parse(update.renderedAt ?? update.receivedAt!) - Date.parse(update.committedAt!) : null)}</strong></span><span>Grok → worker <strong>{duration(bridgeMs)}</strong></span><span>Revision <strong>{data?.trip.revision ?? '—'}</strong></span></div>
          <p className="debug-explanation">Queue time, Grok work and provider time are separate. Screen timings exclude hidden tabs, whose drawing can pause. Database and bridge timestamps come from different machines. A dash means no sample yet.</p>
          {data?.commands.length ? <table className="debug-table"><thead><tr><th>Task / input</th><th>State</th><th>Queued</th><th>Running</th><th>Delivery</th></tr></thead><tbody>{data.commands.map(c => <tr key={c.id}><td><details><summary>{c.kind} · {time(c.created_at)}</summary><code>{c.id}</code><pre>{JSON.stringify(c.payload, null, 2)}</pre>{c.error && <p>{c.error}</p>}</details></td><td>{c.status}</td><td>{duration(c.queueMs)}</td><td>{duration(c.runtimeMs)}</td><td>{c.delivery ?? '—'}</td></tr>)}</tbody></table> : <p>No commands have been sent in this trip.</p>}
        </>}
        {view === 'events' && <div className="debug-events">{data?.events.map(e => <details key={e.id}><summary><time>{time(e.created_at)}</time><strong>{e.type}</strong><span>rev {e.revision}</span></summary><pre>{JSON.stringify({ eventId: e.id, occurredAt: e.occurred_at, committedAt: e.created_at, ...e.payload }, null, 2)}</pre></details>)}{data && !data.events.length && <p>Send a message to see its input and the resulting updates here.</p>}</div>}
        {view === 'notes' && <form className="debug-feedback" onSubmit={e => { e.preventDefault(); void saveNote(); }}><label htmlFor="debug-note">What felt wrong, slow or unclear?</label><textarea id="debug-note" value={note} onChange={e => { setNote(e.target.value); setSaved(false); }} maxLength={2000} rows={3} placeholder="For example: I changed the dates, but couldn’t tell whether the search had restarted." /><div><button className="button primary" disabled={!note.trim() || saving || !tripId}>{saving ? 'Saving…' : 'Save testing note'}</button><span role="status">{saved ? 'Saved with this trip and its current timings.' : 'Notes are saved for debugging; they aren’t sent to Grok.'}</span></div></form>}
      </div>
      {data && <div className="debug-footer">{data.trip.workspaceId} · {data.trip.id} · Bot {data.trip.botId}<span>Worker: {data.worker?.status ?? 'unavailable'}</span></div>}
    </div>}
  </aside>;
}
