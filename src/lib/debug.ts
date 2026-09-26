import type { TripRow } from './db';
import { browserMetricSchema } from './browser-metrics';
import { visibleCriteria } from './domain';

const criteriaKeys = ['origin','originCode','travellers','nights','departureStart','departureEnd','departureDate','budget','currency','interests','noCar','stayStyle','region'];
const quoteKeys = ['total','currency','travellers','departureDate','returnDate','checkedAt','url','label','scope','includes','image','provider','rawId','facts'];
const sourceKeys = ['title','url','checkedAt','excerpt'];
const actionKeys = ['id','kind','label','provider','status','queuedAt','startedAt','finishedAt','detail','retryable','destination'];

export function redactDebugText(value: string) {
  let text = value.slice(0, 5000);
  for (const [key, secret] of Object.entries(process.env)) {
    if (/ACCESS_CODE|PASSWORD|SECRET|TOKEN|API_KEY|SERVICE_ROLE_KEY/.test(key) && secret && secret.length >= 6) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]')
    .replace(/\b(?:sk[-_][A-Za-z0-9_-]{12,}|tvly-[A-Za-z0-9_-]+|apify_api_[A-Za-z0-9_-]+|sb_secret_[A-Za-z0-9_-]+)\b/g, '[redacted key]')
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1=[redacted]');
}
function safe(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[omitted]';
  if (typeof value === 'string') return redactDebugText(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.slice(0, 12).map(item => safe(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|secret|password|credential|authorization|api.?key|raw|log/i.test(key)).slice(0, 30).map(([key, item]) => [key, safe(item, depth + 1)]));
  return undefined;
}
function pick(payload: unknown, keys: string[]) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  return Object.fromEntries(keys.filter(key => record[key] !== undefined).map(key => [key, safe(record[key])]));
}
function sources(value: unknown) { return Array.isArray(value) ? value.slice(0, 5).map(source => pick(source, sourceKeys)) : []; }

export function debugEventPayload(type: string, payload: unknown): Record<string, unknown> {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  if (type === 'user_message' || type === 'assistant_message') return pick(p, ['text']);
  if (type === 'trip_patch') return pick(p, criteriaKeys);
  if (type === 'profile_patch') return pick(p, ['interests','noCar','stayStyle','notes']);
  if (type === 'question') return pick(p, ['id','prompt','options']);
  if (type === 'question_answered') return pick(p, ['id','answer','skipped']);
  if (type === 'action') return pick(p, actionKeys);
  if (type === 'candidate') return { ...pick(p, ['id','name','country','airport','summary','highlights','status','image','imageCredit']), sources: sources(p.sources) };
  if (type === 'quote' || type === 'browser_quote') return { ...pick(p, ['candidateId','kind']), quote: pick(p.quote, quoteKeys), ...(p.sources ? { sources: sources(p.sources) } : {}) };
  if (type === 'browser_evidence') return { ...pick(p, ['candidateId','summary','noCarVerified']), sources: sources(p.sources) };
  if (type === 'requirement_check') return { ...pick(p, ['candidateId','requirementId','status','summary','fingerprint','checkedAt']), sources: sources(p.sources) };
  if (type === 'requirement_edit') return pick(p, ['id','text']);
  if (type === 'search_request') return { destinations: Array.isArray(p.destinations) ? p.destinations.slice(0, 3).map(d => pick(d, ['name','country','airport','reason'])) : [] };
  if (type === 'grok_bundle') return pick(p, ['entryId','botId','botName','commandId','resultingRevision','observedAt','sentAt']);
  if (type === 'debug_note') return { ...pick(p, ['note','clientAt','observedVersion']), ...(Array.isArray(p.browserMetrics) ? { browserMetrics: p.browserMetrics.slice(0,30).flatMap(metric => { const parsed = browserMetricSchema.safeParse(metric); return parsed.success ? [parsed.data] : []; }) } : {}) };
  if (type === 'save_candidate' || type === 'replace_stay' || type === 'retry_requested') return pick(p, ['id','saved','actionId']);
  if (type === 'phase') return pick(p, ['phase']);
  return { omitted: true };
}
export function debugCommandPayload(payload: unknown) {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  return { ...pick(p, ['text','internal','candidateId','excludeStay','kind','purpose','priceKind','operation','expectedRevision']), ...(p.destination ? { destination: pick(p.destination, ['name','country','airport','reason']) } : {}), ...(Array.isArray(p.destinations) ? { destinations: p.destinations.slice(0, 3).map(destination => pick(destination, ['name','country','airport','reason'])) } : {}), ...(p.criteria ? { criteria: pick(p.criteria, criteriaKeys) } : {}) };
}
export function debugTripState(trip: TripRow) { return { criteria: pick(visibleCriteria(trip.state), criteriaKeys), confirmedCriteria: (trip.state.confirmedCriteria ?? []).filter(key => criteriaKeys.includes(key)), profile: pick(trip.state.profile, ['interests','noCar','stayStyle','notes']), requirements: (trip.state.requirements ?? []).slice(-30).map(requirement => pick(requirement, ['id','text','source','sourceId'])), requirementCount: trip.state.requirements?.length ?? 0 }; }
export function debugCommandTiming(command: { id: string; kind: string; status: string; created_at: string; updated_at: string; attempts?: number }, trip: TripRow, now: number) {
  const action = trip.state.actions.find(a => a.id === command.id);
  const startedAt = action && action.status !== 'queued' && (command.attempts ?? 0) > 0 ? action.startedAt : null;
  const endedAt = action?.finishedAt ?? (['done','error','superseded'].includes(command.status) ? command.updated_at : null);
  return { startedAt, queueMs: Math.max(0, (startedAt ? Date.parse(startedAt) : endedAt ? Date.parse(endedAt) : now) - Date.parse(command.created_at)), runtimeMs: startedAt ? Math.max(0, (endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt)) : null };
}
