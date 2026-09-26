import { z } from 'zod';
import { authenticatedUser, apiError } from '@/lib/auth';
import { adminDb, commitEvents, event, getTrip, type QueuedCommand } from '@/lib/db';
import { applyEvent, criteriaPatchSchema, type Action } from '@/lib/domain';
import { HttpError } from '@/lib/errors';

const objectId = z.string().trim().min(1).max(120);
const commandSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.uuid(), kind: z.literal('message'), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ id: z.uuid(), kind: z.literal('answer'), questionId: objectId, answer: z.string().trim().max(500), skipped: z.boolean().optional() }).strict(),
  z.object({ id: z.uuid(), kind: z.literal('criteria'), patch: criteriaPatchSchema }).strict(),
  z.object({ id: z.uuid(), kind: z.literal('profile'), patch: z.object({ interests: z.array(z.string().max(50)).max(12), noCar: z.boolean().nullable(), stayStyle: z.string().max(120), notes: z.array(z.string().max(250)).max(12) }).strict() }).strict(),
  z.object({ id: z.uuid(), kind: z.literal('save'), candidateId: objectId, saved: z.boolean() }).strict(),
  z.object({ id: z.uuid(), kind: z.literal('replace_stay'), candidateId: objectId }).strict(),
  z.object({ id: z.uuid(), kind: z.literal('requirement'), requirementId: z.string().min(1).max(160), text: z.string().trim().min(1).max(4000).nullable() }).strict(),
  z.object({ id: z.uuid(), kind: z.literal('retry'), actionId: z.uuid() }).strict()
]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await authenticatedUser(request);
    const { id } = await params;
    z.uuid().parse(id);
    const authorized = await getTrip(id, user.id);
    if (authorized.workspace_id === 'legacy') throw new HttpError(409, 'Start a fresh trip to use your private Grok bot. This earlier conversation is read-only.');
    if (authorized.is_replay) throw new HttpError(409, 'This is a saved run. Start a new trip to make changes.');
    const command = commandSchema.parse(await request.json());
    let prior: { kind: string; payload: Record<string, unknown>; revision: number; status: string; delivery?: string } | null = null;
    if (command.kind === 'retry') {
      const { data, error } = await adminDb().from('roamer_commands').select('kind,payload,revision,status,delivery').eq('id', command.actionId).eq('trip_id', id).maybeSingle();
      if (error) throw error;
      prior = data;
    }
    let queued: QueuedCommand | null = null;
    const trip = await commitEvents(id, t => {
      if (t.owner_id !== user.id) throw new HttpError(404, 'Trip not found.');
      if (t.workspace_id === 'legacy') throw new HttpError(409, 'Start a fresh trip to use your private Grok bot. This earlier conversation is read-only.');
      if (t.is_replay) throw new HttpError(409, 'This is a saved run. Start a new trip to make changes.');
      let text = '';
      let type = '';
      let payload: Record<string, unknown> = {};
      const context: Record<string, unknown> = {};
      queued = null;
      if (command.kind === 'message') { text = command.text; type = 'user_message'; payload = { text }; }
      if (command.kind === 'answer') {
        const q = t.state.questions.find(q => q.id === command.questionId);
        if (!q || q.answer !== undefined || q.skipped) throw new HttpError(409, 'This question has already been answered.');
        if (!command.skipped && !command.answer) throw new HttpError(400, 'Choose an answer or skip this question.');
        type = 'question_answered'; payload = { id: q.id, answer: command.answer, skipped: Boolean(command.skipped) };
        text = command.skipped ? `Skip the question: ${q.prompt}` : `Answer to "${q.prompt}": ${command.answer}`;
      }
      if (command.kind === 'criteria') { type = 'trip_patch'; payload = command.patch; text = `I updated my trip details: ${JSON.stringify(command.patch)}. Recheck only affected results.`; }
      if (command.kind === 'profile') { type = 'profile_patch'; payload = command.patch; }
      if (command.kind === 'requirement') {
        const requirement = t.state.requirements?.find(item => item.id === command.requirementId);
        if (!requirement) throw new HttpError(404, 'That requirement is no longer in this trip.');
        type = 'requirement_edit'; payload = { id: requirement.id, text: command.text };
        text = command.text === null ? `I removed this requirement: ${requirement.text}. Keep the remaining requirements.` : `I changed this requirement: ${requirement.text}. Replace it with: ${command.text}. Keep the other requirements.`;
      }
      if (command.kind === 'save' || command.kind === 'replace_stay') {
        const c = t.state.candidates.find(c => c.id === command.candidateId);
        if (!c) throw new HttpError(404, 'That destination is no longer in this trip.');
        if (command.kind === 'save') { type = 'save_candidate'; payload = { id: c.id, saved: command.saved }; }
        else {
          type = 'replace_stay'; payload = { id: c.id }; context.candidateId = c.id; context.excludeStay = c.stay?.label ?? '';
          text = `Find a different stay in ${c.name}. Exclude ${c.stay?.label ?? 'the previous stay'}. Keep the flights and other destinations.`;
        }
      }
      if (command.kind === 'retry') {
        if (!prior || prior.status !== 'error') throw new HttpError(409, 'This task cannot be retried.');
        if (prior.delivery === 'unknown') throw new HttpError(409, 'Message delivery is uncertain. Check Grok before sending again.');
        if (prior.revision !== t.state.revision) throw new HttpError(409, 'Trip details changed. Ask for a new search with your current dates.');
        type = 'retry_requested'; payload = { actionId: command.actionId };
        queued = { id: command.id, kind: prior.kind, payload: prior.payload };
      }
      if (text) queued = { id: command.id, kind: 'conversation', payload: { text, ...context } };
      const accepted = event(id, t.state.revision, type, payload, command.id);
      if (!queued) return [accepted];
      const kind = (queued.kind === 'research' ? queued.payload.kind : queued.kind) as Action['kind'];
      const destination = (queued.payload.destination as { name?: string } | undefined)?.name;
      const label = kind === 'conversation' ? 'Waiting for Grok' : kind === 'browser' ? 'Waiting for a browser check' : kind === 'flights' ? `Waiting to check flights${destination ? ` to ${destination}` : ''}` : kind === 'stays' ? `Waiting to check stays${destination ? ` in ${destination}` : ''}` : `Waiting to research${destination ? ` ${destination}` : ''}`;
      const action: Action = { id: command.id, kind, status: 'queued', label, provider: kind === 'conversation' || kind === 'browser' ? 'Grok' : kind === 'discovery' ? 'Tavily' : 'Apify', queuedAt: accepted.occurredAt, startedAt: accepted.occurredAt, ...(destination ? { destination } : {}) };
      return [accepted, event(id, applyEvent(t.state, accepted).revision, 'action', action as unknown as Record<string, unknown>)];
    }, () => queued, command.id, authorized);
    return Response.json({ trip }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}
