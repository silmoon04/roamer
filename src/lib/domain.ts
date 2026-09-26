import { z } from 'zod';

const criteriaFields = z.object({
  origin: z.string().trim().min(1).max(80), originCode: z.string().regex(/^[A-Z]{3}$/),
  travellers: z.number().int().min(1).max(6), nights: z.number().int().min(1).max(30),
  departureStart: z.iso.date(), departureEnd: z.iso.date(),
  departureDate: z.iso.date().nullable(), budget: z.number().min(100).max(100000),
  currency: z.literal('GBP'), interests: z.array(z.string().max(50)).max(12),
  noCar: z.boolean().nullable(), stayStyle: z.string().max(120),
  region: z.string().trim().min(1).max(100)
}).strict();
export const criteriaPatchSchema = criteriaFields.partial();
export const criteriaSchema = criteriaFields.superRefine((c, ctx) => {
  if (c.departureEnd < c.departureStart) ctx.addIssue({ code: 'custom', path: ['departureEnd'], message: 'The end of your travel window must follow its start.' });
  if (c.departureDate && (c.departureDate < c.departureStart || c.departureDate > c.departureEnd)) ctx.addIssue({ code: 'custom', path: ['departureDate'], message: 'Choose a departure date inside your travel window.' });
});
export type Criteria = z.infer<typeof criteriaSchema>;
export type Profile = { interests: string[]; noCar: boolean | null; stayStyle: string; notes: string[] };
export type Question = { id: string; prompt: string; options: string[]; answer?: string; skipped?: boolean };
export type Message = { id: string; role: 'user' | 'assistant'; text: string; at: string; pending?: boolean };
export type Source = { title: string; url: string; checkedAt: string; excerpt?: string };
export type RequirementSource = 'message' | 'answer' | 'stayStyle' | 'profile' | 'edit';
export type TripRequirement = { id: string; text: string; source: RequirementSource; sourceId: string; provenance?: { id: string; source: RequirementSource; sourceId: string }[] };
export type RequirementCheck = { requirementId: string; status: 'supported' | 'contradicted' | 'unknown'; summary: string; sources: Source[]; fingerprint: string; checkedAt: string };
export type QuoteFacts = { propertyType?: string; roomName?: string; beds?: { type: string; count: number }[]; cancellation?: string; accessibility?: string };
export type Action = { id: string; label: string; provider: string; status: 'queued' | 'running' | 'done' | 'error' | 'superseded'; startedAt: string; queuedAt?: string; finishedAt?: string; detail?: string; retryable?: boolean; kind: 'conversation' | 'discovery' | 'flights' | 'stays' | 'browser'; destination?: string };
export type Quote = { total: number; currency: 'GBP'; travellers: number; departureDate: string; returnDate: string; checkedAt: string; url: string; label: string; scope: 'return-flights' | 'whole-stay'; includes: string; image?: string; provider: string; rawId?: string; facts?: QuoteFacts };
export type Candidate = {
  id: string; name: string; country: string; airport: string; image: string;
  imageCredit?: { author: string; license: string; licenseUrl: string; source: string };
  summary: string; highlights: string[]; sources: Source[];
  flight?: Quote; stay?: Quote; alternatives?: Quote[];
  transport?: { summary: string; verified: boolean; sources: Source[] };
  requirementChecks?: RequirementCheck[];
  status: 'researching' | 'partial' | 'checked' | 'unavailable'; saved?: boolean;
};
export type TripState = {
  revision: number; criteria: Criteria; profile: Profile; messages: Message[];
  confirmedCriteria?: (keyof Criteria)[];
  questions: Question[]; actions: Action[]; candidates: Candidate[];
  phase: 'gathering' | 'searching' | 'checking' | 'ready' | 'blocked';
  replay: boolean; replayRecordedAt?: string; updatedAt: string;
  requirements?: TripRequirement[];
  retiredRequirementIds?: string[];
};

export const defaultCriteria: Criteria = {
  origin: 'London', originCode: 'LON', travellers: 2, nights: 5,
  departureStart: '2026-10-10', departureEnd: '2026-10-20', departureDate: null,
  budget: 1000, currency: 'GBP', interests: [], noCar: null,
  stayStyle: '', region: 'Europe'
};
export function initialState(profile?: Profile): TripState {
  const p = structuredClone(profile ?? { interests: [], noCar: null, stayStyle: '', notes: [] });
  const state: TripState = { revision: 0, criteria: { ...defaultCriteria, interests: [...p.interests], noCar: p.noCar, stayStyle: p.stayStyle },
    confirmedCriteria: [...(p.interests.length ? ['interests' as const] : []), ...(p.noCar !== null ? ['noCar' as const] : []), ...(p.stayStyle.trim() ? ['stayStyle' as const] : [])],
    profile: p, messages: [], questions: [], actions: [], candidates: [], requirements: [], phase: 'gathering', replay: false, updatedAt: new Date().toISOString() };
  state.requirements = tripRequirements(state); return state;
}
export function visibleCriteria(state: Pick<TripState, 'criteria' | 'confirmedCriteria'>): { [Key in keyof Criteria]: Criteria[Key] | null } {
  const confirmed = new Set(state.confirmedCriteria ?? []);
  return Object.fromEntries(Object.entries(state.criteria).map(([key, value]) => [key, confirmed.has(key as keyof Criteria) ? value : null])) as { [Key in keyof Criteria]: Criteria[Key] | null };
}
export function missingSearchDetails(state: Pick<TripState, 'criteria' | 'confirmedCriteria'>): string[] {
  const confirmed = new Set(state.confirmedCriteria ?? []); const missing: string[] = [];
  if (!confirmed.has('origin') || !confirmed.has('originCode')) missing.push('origin');
  if (!confirmed.has('travellers')) missing.push('travellers');
  if (!confirmed.has('nights')) missing.push('nights');
  if (!(confirmed.has('departureDate') && state.criteria.departureDate) && !(confirmed.has('departureStart') && confirmed.has('departureEnd'))) missing.push('dates');
  if (!confirmed.has('budget') || !confirmed.has('currency')) missing.push('budget');
  return missing;
}
export function canPriceSearch(state: Pick<TripState, 'criteria' | 'confirmedCriteria'>) { return missingSearchDetails(state).length === 0; }

const safeUrl = z.string().url().refine(s => /^https?:\/\//.test(s), 'Use an HTTP link');
const sourceSchema = z.object({ title: z.string().max(160), url: safeUrl, checkedAt: z.iso.datetime(), excerpt: z.string().max(600).optional() });
export const quoteFactsSchema = z.object({ propertyType: z.string().max(200).optional(), roomName: z.string().max(300).optional(), beds: z.array(z.object({ type: z.string().min(1).max(150), count: z.number().int().positive().max(30) }).strict()).max(20).optional(), cancellation: z.string().max(1000).optional(), accessibility: z.string().max(1000).optional() }).strict();
export const requirementCheckPayloadSchema = z.object({
  candidateId: z.string().min(1).max(80), requirementId: z.string().min(1).max(160),
  status: z.enum(['supported', 'contradicted', 'unknown']), summary: z.string().min(1).max(1000),
  sources: z.array(sourceSchema).max(8), fingerprint: z.string().regex(/^suit:v1:[0-9a-f]{32}$/).max(128), checkedAt: z.iso.datetime()
}).strict().superRefine((value, ctx) => {
  if (value.status !== 'unknown' && (!value.sources.length || value.sources.some(source => !source.excerpt?.trim()))) ctx.addIssue({ code: 'custom', path: ['sources'], message: 'A suitability verdict requires concrete source excerpts.' });
});
export const browserQuotePayloadSchema = z.object({
  candidateId: z.string().min(1).max(80), kind: z.enum(['flights', 'stays']),
  quote: z.object({
    total: z.number().positive(), currency: z.literal('GBP'), travellers: z.number().int().min(1).max(6),
    departureDate: z.iso.date(), returnDate: z.iso.date(), checkedAt: z.iso.datetime(),
    url: safeUrl, label: z.string().min(1).max(200), scope: z.enum(['return-flights', 'whole-stay']),
    includes: z.string().min(1).max(1000), image: safeUrl.optional(),
    provider: z.string().regex(/^Grok browser \([^()\r\n]+\)$/).max(160), rawId: z.string().max(200).optional(), facts: quoteFactsSchema.optional()
  }).strict(),
  sources: z.array(sourceSchema).min(1).max(5)
}).strict().superRefine((p, ctx) => {
  if (p.quote.scope !== (p.kind === 'flights' ? 'return-flights' : 'whole-stay')) ctx.addIssue({ code: 'custom', path: ['quote', 'scope'], message: 'The quote scope does not match the search.' });
  if (p.quote.returnDate <= p.quote.departureDate) ctx.addIssue({ code: 'custom', path: ['quote', 'returnDate'], message: 'The return date must follow departure.' });
});
export const modelEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('assistant_message'), payload: z.object({ text: z.string().min(1).max(5000) }).strict() }).strict(),
  z.object({ type: z.literal('trip_patch'), payload: criteriaPatchSchema }).strict(),
  z.object({ type: z.literal('profile_patch'), payload: z.object({ interests: z.array(z.string().max(50)).max(12).optional(), noCar: z.boolean().nullable().optional(), stayStyle: z.string().max(120).optional(), notes: z.array(z.string().max(250)).max(12).optional() }).strict() }).strict(),
  z.object({ type: z.literal('question'), payload: z.object({ id: z.string().max(80), prompt: z.string().max(300), options: z.array(z.string().max(120)).min(2).max(5) }).strict() }).strict(),
  z.object({ type: z.literal('question_answered'), payload: z.object({ id: z.string().max(80), answer: z.string().max(500), skipped: z.boolean().optional() }).strict() }).strict(),
  z.object({ type: z.literal('search_request'), payload: z.object({ destinations: z.array(z.object({ name: z.string().max(80), country: z.string().max(80), airport: z.string().regex(/^[A-Z]{3}$/), reason: z.string().max(300) }).strict()).min(1).max(3) }).strict() }).strict(),
  z.object({ type: z.literal('browser_evidence'), payload: z.object({ candidateId: z.string().max(80), summary: z.string().max(500), sources: z.array(sourceSchema).min(1).max(5), noCarVerified: z.boolean() }).strict() }).strict(),
  z.object({ type: z.literal('browser_quote'), payload: browserQuotePayloadSchema }).strict(),
  z.object({ type: z.literal('requirement_check'), payload: requirementCheckPayloadSchema }).strict()
]);
export const modelBundleSchema = z.object({ tripId: z.uuid(), revision: z.number().int().nonnegative(), commandId: z.uuid().optional(), events: z.array(modelEventSchema).min(1).max(15) }).strict();
export type ModelEvent = z.infer<typeof modelEventSchema>;
export type DomainEvent = { id: string; tripId: string; revision: number; type: string; payload: Record<string, unknown>; occurredAt: string };

export function parseModelBundles(text: string) {
  const results: z.infer<typeof modelBundleSchema>[] = [];
  for (const match of text.matchAll(/<roamer>\s*([\s\S]*?)\s*<\/roamer>/g)) {
    let json: unknown;
    try { json = JSON.parse(match[1]); } catch { throw new Error('Grok returned an invalid Roamer event.'); }
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      const bundle = json as Record<string, unknown>;
      if (Array.isArray(bundle.events)) json = { ...bundle, events: bundle.events.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const entry = value as Record<string, unknown>;
        if (Object.hasOwn(entry, 'payload')) return entry;
        const { type, ...payload } = entry;
        return { type, payload };
      }) };
    }
    const parsed = modelBundleSchema.safeParse(json);
    if (!parsed.success) throw new Error('Grok returned an invalid Roamer event.');
    results.push(parsed.data);
  }
  return results;
}

export function dates(criteria: Criteria) {
  const departureDate = criteria.departureDate ?? criteria.departureStart;
  const d = new Date(`${departureDate}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + criteria.nights);
  return { departureDate, returnDate: d.toISOString().slice(0, 10) };
}
export function fingerprint(criteria: Criteria, kind: Action['kind']) {
  const common = { ...dates(criteria), travellers: criteria.travellers, region: criteria.region };
  if (kind === 'flights') return JSON.stringify({ ...common, originCode: criteria.originCode });
  if (kind === 'stays') return JSON.stringify({ ...common, stayStyle: criteria.stayStyle });
  if (kind === 'browser') return JSON.stringify({ ...common, noCar: criteria.noCar, interests: criteria.interests });
  return JSON.stringify({ interests: criteria.interests, noCar: criteria.noCar, region: criteria.region });
}
export function quoteMatches(q: Quote, criteria: Criteria) {
  const d = dates(criteria);
  return q.currency === 'GBP' && q.travellers === criteria.travellers && q.departureDate === d.departureDate && q.returnDate === d.returnDate && Number.isFinite(q.total) && q.total > 0 && safeUrl.safeParse(q.url).success && z.iso.datetime().safeParse(q.checkedAt).success;
}
export function candidateTotal(c: Candidate, criteria: Criteria) {
  if (!c.flight || !c.stay || c.flight.scope !== 'return-flights' || c.stay.scope !== 'whole-stay' || !quoteMatches(c.flight, criteria) || !quoteMatches(c.stay, criteria)) return null;
  return Math.round((c.flight.total + c.stay.total) * 100) / 100;
}
function textKey(text: string) {
  const values = [2166136261, 2246822519, 3266489917, 668265263];
  for (let i = 0; i < text.length; i++) for (let j = 0; j < values.length; j++) values[j] = Math.imul(values[j] ^ (text.charCodeAt(i) + j), 16777619 + j * 2) >>> 0;
  return values.map(value => value.toString(16).padStart(8, '0')).join('');
}
function statedRequirements(criteria: Criteria, profile?: Profile): TripRequirement[] {
  return [
    ...(criteria.stayStyle.trim() ? [{ id: `stayStyle:${textKey(criteria.stayStyle)}`, text: criteria.stayStyle, source: 'stayStyle' as const, sourceId: 'criteria.stayStyle' }] : []),
    ...(profile?.stayStyle.trim() && profile.stayStyle !== criteria.stayStyle ? [{ id: `profile-style:${textKey(profile.stayStyle)}`, text: profile.stayStyle, source: 'profile' as const, sourceId: 'profile.stayStyle' }] : []),
    ...(profile?.notes ?? []).filter(text => text.trim()).map(text => ({ id: `profile:${textKey(text)}`, text, source: 'profile' as const, sourceId: 'profile.notes' }))
  ];
}
export function tripRequirements(state: TripState): TripRequirement[] {
  const acknowledgement = new Set(['thanks', 'thanks!', 'thank you', 'thank you!', 'ok', 'okay', 'great', 'any update?', 'what is the status?', 'how long is this taking?']);
  const records: TripRequirement[] = [
    ...(state.requirements ?? []),
    ...state.messages.filter(message => message.role === 'user' && !acknowledgement.has(message.text.trim().toLowerCase())).map(message => ({ id: `message:${message.id}`, text: message.text, source: 'message' as const, sourceId: message.id })),
    ...state.questions.filter(question => question.answer && !question.skipped).map(question => ({ id: `answer:${question.id}`, text: `${question.prompt}\nAnswer: ${question.answer}`, source: 'answer' as const, sourceId: question.id })),
    ...statedRequirements(state.criteria, state.profile)
  ];
  const retired = new Set(state.retiredRequirementIds ?? []);
  const unique = new Map<string, TripRequirement>();
  for (const record of records.filter(record => !retired.has(record.id))) {
    const key = record.text.trim().replace(/\s+/g, ' ');
    const existing = unique.get(key);
    const provenance = [...(existing?.provenance ?? []), ...(record.provenance ?? []), { id: record.id, source: record.source, sourceId: record.sourceId }].filter(source => !retired.has(source.id));
    unique.set(key, { ...(existing ?? record), provenance: [...new Map(provenance.map(source => [source.id, source])).values()] });
  }
  return [...unique.values()];
}
export function suitabilityFingerprint(candidate: Candidate, criteria: Criteria, requirements: TripRequirement[]) {
  const quote = (q?: Quote) => q ? { url: q.url, label: q.label, total: q.total, currency: q.currency, scope: q.scope, departureDate: q.departureDate, returnDate: q.returnDate, travellers: q.travellers, includes: q.includes, facts: q.facts } : null;
  return `suit:v1:${textKey(JSON.stringify({ criteria, requirements: requirements.map(({ id, text }) => ({ id, text })), candidate: { id: candidate.id, name: candidate.name, country: candidate.country, airport: candidate.airport, flight: quote(candidate.flight), stay: quote(candidate.stay) } }))}`;
}
export function requirementResults(candidate: Candidate, criteria: Criteria, requirements: TripRequirement[] = []) {
  const all = requirements;
  const fingerprint = suitabilityFingerprint(candidate, criteria, all);
  return all.map(requirement => {
    const check = candidate.requirementChecks?.find(item => item.requirementId === requirement.id && item.fingerprint === fingerprint && requirementCheckPayloadSchema.safeParse({ candidateId: candidate.id, ...item }).success);
    return { requirement, status: check?.status ?? 'unknown' as const, ...(check ?? {}) };
  });
}
export function candidateStatus(c: Candidate, criteria: Criteria, requirements?: TripRequirement[], profile?: Profile, confirmedCriteria?: (keyof Criteria)[]): Candidate['status'] {
  const all = requirements ?? statedRequirements(criteria, profile);
  const suitability = requirementResults(c, criteria, all);
  const total = candidateTotal(c, criteria);
  if ((confirmedCriteria === undefined || canPriceSearch({ criteria, confirmedCriteria })) && total !== null && total <= criteria.budget && (!criteria.noCar || (c.transport?.verified && c.transport.sources.length > 0)) && suitability.every(result => result.status === 'supported')) return 'checked';
  if (c.flight || c.stay || c.sources.length) return 'partial';
  return c.status === 'unavailable' ? 'unavailable' : 'researching';
}
export function withSuitability(state: TripState): TripState {
  const requirements = tripRequirements(state);
  const confirmedCriteria = state.confirmedCriteria ?? [];
  const intakeComplete = canPriceSearch({ criteria: state.criteria, confirmedCriteria });
  const candidates = state.candidates.map(candidate => ({ ...candidate, ...(!intakeComplete ? { summary: `Waiting for your trip details before checking prices in ${candidate.name}.` } : {}), requirementChecks: candidate.requirementChecks?.filter(check => intakeComplete && check.fingerprint === suitabilityFingerprint(candidate, state.criteria, requirements)), status: candidateStatus(candidate, state.criteria, requirements, state.profile, confirmedCriteria) }));
  return { ...state, confirmedCriteria, requirements, candidates, phase: state.phase === 'ready' && !candidates.some(candidate => candidate.status === 'checked') ? 'checking' : state.phase };
}
export function applyEvent(current: TripState, event: DomainEvent): TripState {
  const s = structuredClone(current); s.requirements = tripRequirements(current); const p = event.payload; s.updatedAt = event.occurredAt;
  switch (event.type) {
    case 'user_message': case 'assistant_message':
      if (!s.messages.some(m => m.id === event.id)) s.messages.push({ id: event.id, role: event.type === 'user_message' ? 'user' : 'assistant', text: String(p.text), at: event.occurredAt });
      break;
    case 'trip_patch': {
      const previousConfirmed = new Set(s.confirmedCriteria ?? []);
      const values = { ...s.criteria, ...p };
      if (typeof p.departureDate === 'string') {
        if (!previousConfirmed.has('departureStart') && p.departureStart === undefined) values.departureStart = p.departureDate;
        if (!previousConfirmed.has('departureEnd') && p.departureEnd === undefined) values.departureEnd = p.departureDate;
      }
      if (typeof p.departureStart === 'string' && !previousConfirmed.has('departureEnd') && p.departureEnd === undefined) values.departureEnd = p.departureStart;
      if (typeof p.departureEnd === 'string' && !previousConfirmed.has('departureStart') && p.departureStart === undefined) values.departureStart = p.departureEnd;
      const next = criteriaSchema.parse(values);
      const confirmed = [...new Set([...(s.confirmedCriteria ?? []), ...Object.keys(p) as (keyof Criteria)[]])];
      if (JSON.stringify(next) === JSON.stringify(s.criteria) && confirmed.length === (s.confirmedCriteria?.length ?? 0)) break;
      s.confirmedCriteria = confirmed;
      const previous = s.criteria; s.criteria = next; s.revision++;
      s.actions = s.actions.map(a => a.kind !== 'conversation' && (a.status === 'running' || a.status === 'queued' || a.status === 'error') && fingerprint(previous, a.kind) !== fingerprint(next, a.kind) ? { ...a, status: 'superseded', detail: 'Trip details changed.', finishedAt: event.occurredAt } : a);
      s.candidates = s.candidates.map(c => ({ ...c,
        flight: fingerprint(previous, 'flights') === fingerprint(next, 'flights') ? c.flight : undefined,
        stay: fingerprint(previous, 'stays') === fingerprint(next, 'stays') ? c.stay : undefined,
        alternatives: fingerprint(previous, 'stays') === fingerprint(next, 'stays') ? c.alternatives : undefined,
        transport: fingerprint(previous, 'browser') === fingerprint(next, 'browser') ? c.transport : undefined,
        summary: canPriceSearch(s) ? `Checking ${c.name} for ${dates(next).departureDate} to ${dates(next).returnDate}, ${next.travellers} ${next.travellers === 1 ? 'traveller' : 'travellers'}.` : `Waiting for your trip details before checking prices in ${c.name}.`
      }));
      if (previous.region !== next.region) s.candidates = [];
      s.phase = 'checking'; break;
    }
    case 'profile_patch': s.profile = { ...s.profile, ...p }; break;
    case 'question': {
      const q = p as unknown as Question;
      const existing = s.questions.findIndex(x => x.id === q.id);
      if (existing < 0) s.questions.push(q); else if (!s.questions[existing].answer && !s.questions[existing].skipped) s.questions[existing] = q;
      break;
    }
    case 'question_answered': s.questions = s.questions.map(q => q.id === p.id && !q.answer && !q.skipped ? { ...q, answer: String(p.answer), skipped: Boolean(p.skipped) } : q); break;
    case 'action': {
      const a = p as unknown as Action; const i = s.actions.findIndex(x => x.id === a.id);
      if (i < 0) s.actions.push(a); else if (s.actions[i].status !== 'superseded') s.actions[i] = { ...s.actions[i], ...a };
      if (a.status === 'running' && s.actions.find(x => x.id === a.id)?.status === 'running') s.phase = 'searching'; break;
    }
    case 'candidate': {
      if (event.revision !== s.revision) break;
      const c = p as unknown as Candidate; const i = s.candidates.findIndex(x => x.id === c.id);
      if (i < 0) s.candidates.push(c); else s.candidates[i] = { ...s.candidates[i], ...c }; break;
    }
    case 'quote': case 'browser_quote': {
      const browserQuote = event.type === 'browser_quote' ? browserQuotePayloadSchema.safeParse(p) : null;
      if (browserQuote && !browserQuote.success) break;
      const c = s.candidates.find(x => x.id === p.candidateId); const q = p.quote as Quote;
      const kind = p.kind === 'flights' ? 'flights' : p.kind === 'stays' ? 'stays' : null;
      const revisionMatches = event.revision === s.revision || (!browserQuote && kind && p.fingerprint === fingerprint(s.criteria, kind));
      if (c && kind && canPriceSearch(s) && revisionMatches && q.scope === (kind === 'flights' ? 'return-flights' : 'whole-stay') && quoteMatches(q, s.criteria)) {
        if (p.kind === 'flights') c.flight = q;
        else {
          if (c.stay?.url !== q.url || c.stay?.label !== q.label) c.transport = undefined;
          c.stay = q; c.alternatives = (p.alternatives as Quote[] | undefined)?.filter(x => x.scope === 'whole-stay' && quoteMatches(x, s.criteria));
        }
        if (browserQuote?.success) c.sources = [...new Map([...c.sources, ...browserQuote.data.sources].map(source => [source.url, source])).values()];
      } break;
    }
    case 'browser_evidence': {
      const c = s.candidates.find(x => x.id === p.candidateId);
      if (c && event.revision === s.revision) c.transport = { summary: String(p.summary), verified: p.noCarVerified === true, sources: p.sources as Source[] };
      break;
    }
    case 'requirement_check': {
      const parsed = requirementCheckPayloadSchema.safeParse(p); if (!parsed.success || event.revision !== s.revision || !canPriceSearch(s)) break;
      const c = s.candidates.find(candidate => candidate.id === parsed.data.candidateId);
      const requirements = tripRequirements(s);
      if (!c || !requirements.some(requirement => requirement.id === parsed.data.requirementId) || parsed.data.fingerprint !== suitabilityFingerprint(c, s.criteria, requirements)) break;
      const { candidateId: _candidateId, ...check } = parsed.data;
      c.requirementChecks = [...(c.requirementChecks ?? []).filter(item => item.requirementId !== check.requirementId), check];
      break;
    }
    case 'requirement_edit': {
      const original = s.requirements.find(requirement => requirement.id === p.id); if (!original) break;
      s.retiredRequirementIds = [...new Set([...(s.retiredRequirementIds ?? []), original.id, ...(original.provenance ?? []).map(source => source.id)])];
      s.requirements = s.requirements.filter(requirement => requirement.id !== p.id);
      if (typeof p.text === 'string' && p.text.trim()) s.requirements.push({ id: `edit:${event.id}`, text: p.text.trim(), source: 'edit', sourceId: event.id });
      s.revision++; s.phase = 'checking'; break;
    }
    case 'save_candidate': s.candidates = s.candidates.map(c => c.id === p.id ? { ...c, saved: Boolean(p.saved) } : c); break;
    case 'replace_stay': {
      const c = s.candidates.find(x => x.id === p.id);
      if (c) {
        c.stay = undefined; c.alternatives = []; c.transport = undefined; s.revision++;
        s.actions = s.actions.map(a => (a.kind === 'stays' || a.kind === 'browser') && (a.destination === c.id || a.destination === c.name) && (a.status === 'running' || a.status === 'queued' || a.status === 'error') ? { ...a, status: 'superseded', finishedAt: event.occurredAt, detail: 'Looking for a different stay.' } : a);
      } s.phase = 'checking'; break;
    }
    case 'phase': s.phase = p.phase as TripState['phase']; break;
  }
  const suitability = withSuitability(s); s.requirements = suitability.requirements; s.candidates = suitability.candidates; s.phase = suitability.phase;
  if (s.candidates.some(c => c.status === 'checked') && !s.actions.some(a => a.status === 'running' || a.status === 'queued')) s.phase = 'ready';
  return s;
}

export function slug(value: string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
export function formatMoney(value: number) { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(value); }
