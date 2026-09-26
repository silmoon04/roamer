import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { applyEvent, withSuitability, type DomainEvent, type TripState } from './domain';
import { HttpError } from './errors';
import { newTripForWorkspace, type WorkspaceId, type WorkspaceRow } from './workspaces';

export function adminDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase is not configured.');
  return createClient(url,key,{ auth: { persistSession: false, autoRefreshToken: false } });
}
export type TripRow = { id: string; owner_id: string; workspace_id: WorkspaceId | 'legacy'; bot_id: string | null; browser_bot_id: string | null; title: string; state: TripState; version: number; is_replay: boolean; updated_at: string };
export type CommandRow = { id: string; trip_id: string; owner_id: string; revision: number; kind: string; payload: Record<string, unknown>; status: string; created_at: string; delivery?: string };
export async function getTrip(id: string, ownerId?: string): Promise<TripRow> {
  let q = adminDb().from('roamer_trips').select('*').eq('id',id);
  if (ownerId) q = q.eq('owner_id',ownerId);
  const {data,error} = await q.single();
  if (error?.code === 'PGRST116' || (!error && !data)) throw new HttpError(404, 'Trip not found.');
  if (error) throw error;
  return { ...data, state: withSuitability(data.state) };
}
export async function getWorkspace(id: WorkspaceId | 'legacy', ownerId: string): Promise<WorkspaceRow> {
  const { data, error } = await adminDb().from('roamer_workspaces').select('id,owner_id,bot_id,bot_name,browser_bot_id,profile').eq('id', id).eq('owner_id', ownerId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'Workspace not found.');
  return data;
}
export async function getWorkerHealth(ownerId: string, botId: string | null) {
  const ids = botId ? [`laptop:${botId}`, 'laptop'] : ['laptop'];
  const { data, error } = await adminDb().from('roamer_workers').select('id,heartbeat,status,detail').eq('owner_id', ownerId).in('id', ids);
  if (error) throw error;
  return data?.find(row => row.id === ids[0]) ?? data?.find(row => row.id === 'laptop') ?? null;
}
export async function createTrip(ownerId: string, workspaceId: WorkspaceId = 'personal') {
  const db = adminDb(); const workspace = await getWorkspace(workspaceId, ownerId);
  const {data,error} = await db.from('roamer_trips').insert(newTripForWorkspace(ownerId, workspace)).select('*').single();
  if (error) throw error; return data as TripRow;
}
export function event(tripId: string, revision: number, type: string, payload: Record<string,unknown>, id: string = randomUUID()): DomainEvent {
  return { id,tripId,revision,type,payload,occurredAt:new Date().toISOString() };
}
export type QueuedCommand = { id: string; kind: string; payload: Record<string, unknown> };
export async function commitEvents(tripId: string, make: (trip: TripRow) => DomainEvent[] | null, makeCommand?: (trip: TripRow) => QueuedCommand | null, requestId?: string, startingTrip?: TripRow): Promise<TripRow> {
  const db=adminDb();
  for(let attempt=0;attempt<8;attempt++) {
    const [trip, acceptedResult] = await Promise.all([
      attempt === 0 && startingTrip ? Promise.resolve(startingTrip) : getTrip(tripId),
      requestId ? db.from('roamer_events').select('trip_id').eq('id', requestId).maybeSingle() : Promise.resolve(null)
    ]);
    if (acceptedResult) {
      const { data: accepted, error: acceptedError } = acceptedResult;
      if (acceptedError) throw acceptedError;
      if (accepted?.trip_id === tripId) return getTrip(tripId);
      if (accepted) throw new HttpError(409, 'This request was already used for another trip.');
    }
    const proposed=make(trip); if (!proposed?.length) return trip;
    const {data: existing,error: readError}=requestId && proposed.every(e => e.id === requestId) ? { data: [], error: null } : await db.from('roamer_events').select('id').in('id',proposed.map(e=>e.id));
    if(readError)throw readError;
    const known=new Set(existing?.map(e=>e.id)); const events=proposed.filter(e=>!known.has(e.id)); if(!events.length)return trip;
    const state=events.reduce(applyEvent,trip.state);
    const command = makeCommand?.(trip) ?? null;
    const {data,error}=await db.rpc('roamer_commit',{p_trip:tripId,p_expected_version:trip.version,p_state:state,p_events:events,...(command ? { p_command: command } : {})});
    if(error)throw error;
    if(data)return {...trip,state,version:trip.version+events.length};
  }
  throw new HttpError(409, 'The trip changed during this update. Please try again.');
}
export async function queueCommand(trip:TripRow,kind:string,payload:Record<string,unknown>,id: string=randomUUID()) {
  const {error}=await adminDb().from('roamer_commands').upsert({id,trip_id:trip.id,owner_id:trip.owner_id,revision:trip.state.revision,kind,payload},{onConflict:'id',ignoreDuplicates:true});
  if(error)throw error; return id;
}
