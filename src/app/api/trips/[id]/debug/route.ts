import { z } from 'zod';
import { authenticatedUser, apiError } from '@/lib/auth';
import { adminDb, commitEvents, event, getTrip, getWorkspace, getWorkerHealth } from '@/lib/db';
import { debugCommandPayload, debugCommandTiming, debugEventPayload, debugTripState, redactDebugText } from '@/lib/debug';
import { HttpError } from '@/lib/errors';
import { browserMetricSchema } from '@/lib/browser-metrics';

const noStore = { 'Cache-Control': 'no-store' };
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await authenticatedUser(request); const { id } = await params; z.uuid().parse(id);
    const trip = await getTrip(id, user.id); const db = adminDb();
    const [workspace, events, commands, worker] = await Promise.all([
      getWorkspace(trip.workspace_id, user.id),
      db.from('roamer_events').select('id,seq,type,revision,occurred_at,created_at,payload').eq('trip_id', id).eq('owner_id', user.id).order('seq', { ascending: false }).limit(80),
      db.from('roamer_commands').select('id,kind,status,created_at,updated_at,delivery,error,attempts,payload').eq('trip_id', id).eq('owner_id', user.id).order('created_at', { ascending: false }).limit(40),
      getWorkerHealth(user.id, trip.bot_id)
    ]);
    if (events.error || commands.error) throw events.error ?? commands.error;
    const now = Date.now();
    return Response.json({
      serverTime: new Date(now).toISOString(),
      trip: { id, workspaceId: trip.workspace_id, version: trip.version, revision: trip.state.revision, phase: trip.state.phase, botId: trip.bot_id, botName: workspace.bot_name, browserBotId: trip.browser_bot_id, ...debugTripState(trip) },
      worker: worker ? { ...worker, detail: worker.detail ? redactDebugText(worker.detail) : null } : null,
      commands: (commands.data ?? []).reverse().map(command => ({ ...command, payload: debugCommandPayload(command.payload), error: command.error ? redactDebugText(command.error) : null, botId: command.kind === 'research' ? null : command.kind === 'browser' ? trip.browser_bot_id ?? trip.bot_id : trip.bot_id, ...debugCommandTiming(command, trip, now) })),
      events: (events.data ?? []).reverse().map(e => ({ ...e, payload: debugEventPayload(e.type, e.payload) }))
    }, { headers: noStore });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await authenticatedUser(request); const { id } = await params; z.uuid().parse(id);
    const trip = await getTrip(id, user.id);
    if (trip.workspace_id === 'legacy') throw new HttpError(409, 'Start a fresh trip to use your private Grok bot. This earlier conversation is read-only.');
    const input = z.object({ note: z.string().trim().min(1).max(2000), clientAt: z.iso.datetime().optional(), observedVersion: z.number().int().nonnegative().optional(), browserMetrics: z.array(browserMetricSchema).max(30).optional() }).strict().parse(await request.json());
    if (input.browserMetrics?.some(metric => metric.tripId !== id)) throw new HttpError(400, 'Browser timings must belong to this trip.');
    input.note = redactDebugText(input.note);
    await commitEvents(id, current => { if (current.owner_id !== user.id) throw new HttpError(404, 'Trip not found.'); return [event(id, current.state.revision, 'debug_note', input)]; });
    return Response.json({ ok: true }, { headers: noStore });
  } catch (error) { return apiError(error); }
}
