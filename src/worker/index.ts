import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { applyEvent, canPriceSearch, dates, fingerprint, missingSearchDetails, requirementResults, slug, suitabilityFingerprint, tripRequirements, visibleCriteria, type Action, type Candidate, type Criteria, type DomainEvent } from '../lib/domain';
import { adminDb, commitEvents, event, getTrip, queueCommand, type CommandRow, type TripRow } from '../lib/db';
import { contradictsStayRequirements, discover, searchFlights, searchStays, stayIsExcluded, type Destination } from '../lib/providers';
import { browserProtocol, bundlesFromEntry, gbot, protocol, setBotAllowlist, stableId, transcript, type TranscriptEntry } from './bridge';
import { backoffDelay, retryConnection } from './resilience';
import { acceptsBrowserQuote, browserScope, browserTaskIsCurrent } from './browser-scope';
import { allowedBotEvent, commandBot, legacyCoordinatorId, receiptMatches, registeredBots, transcriptKey, type Bot, type BotBinding, type WorkspaceBot } from './bots';
import { destinationPhoto } from '../lib/destination-photo';
import { requirementRequest, transportDiscoveryQuery, transportRequest } from './research-prompts';
import { priceUpdate } from './progress';
import { requestScopedStop } from './deadline';
import { excludedStayNames } from './stay-constraints';

const db = adminDb();
const ownerId = process.env.ROAMER_USER_ID;
if (!ownerId) throw new Error('ROAMER_USER_ID is not configured.');
const workerId = 'laptop';
const lockPath = '.roamer/worker-v2.lock';
let stopping = false;
let queueDisconnected = false;
let maintaining = false;
type BotLane = { bot: Bot; cursor?: string; polling: boolean; lastSuccessfulPoll: number; failures: number; recentAt: number; timer?: ReturnType<typeof setTimeout>; waiter?: { command: CommandRow; resolve: (status: 'done' | 'superseded') => void; reject: (error: Error) => void } };
const lanes: BotLane[] = [];
let bots: Bot[] = [];
let startLanePolling: ((lane: BotLane) => void) | undefined;
const laneFor = (bot: Bot) => lanes.find(lane => lane.bot.id === bot.id)!;
function clearWaiter(lane: BotLane, commandId: string) { if (lane.waiter?.command.id === commandId) lane.waiter = undefined; lane.recentAt = Date.now(); }
const active = new Map<string, { command: CommandRow; abort: AbortController; bot?: Bot }>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const safeError = (error: unknown) => error instanceof Error ? error.message.slice(0, 350) : 'The task could not finish.';
const candidateId = (destination: Destination) => `${slug(destination.name)}-${destination.airport.toLowerCase()}`;
const imageFor = (name: string) => ({ krakow: '/images/krakow.jpg', ljubljana: '/images/ljubljana.jpg', porto: '/images/porto.jpg' }[slug(name)] ?? '');
class RejectedBundleError extends Error {}

async function refreshRegistry() {
  const { data, error } = await db.from('roamer_workspaces').select('id,bot_id,browser_bot_id,bot_name,owner_id').eq('owner_id', ownerId);
  if (error) throw error;
  bots = registeredBots((data ?? []) as WorkspaceBot[], ownerId!);
  setBotAllowlist(bots);
  for (const bot of bots) {
    const existing = lanes.find(lane => lane.bot.id === bot.id);
    if (existing) { existing.bot = bot; continue; }
    const id = bot.id === legacyCoordinatorId ? workerId : `${workerId}:${bot.id}`;
    const { data: saved, error: cursorError } = await db.from('roamer_workers').select('cursor').eq('id', id).eq('owner_id', ownerId).maybeSingle();
    if (cursorError) throw cursorError;
    const lane: BotLane = { bot, cursor: saved?.cursor ?? undefined, polling: false, lastSuccessfulPoll: Date.now(), failures: 0, recentAt: Date.now() };
    lanes.push(lane); startLanePolling?.(lane);
  }
}

async function setCommand(command: CommandRow, status: string, detail?: string, delivery?: string) {
  const { error } = await db.from('roamer_commands').update({ status, updated_at: now(), lease_until: null, error: detail ?? null, ...(delivery ? { delivery } : {}) }).eq('id', command.id);
  if (error) throw error;
}
async function action(command: CommandRow, status: Action['status'], detail?: string) {
  await commitEvents(command.trip_id, trip => {
    const previous = trip.state.actions.find(a => a.id === command.id);
    if (previous?.status === 'superseded' && status !== 'superseded') return null;
    const kind = (command.kind === 'conversation' || command.kind === 'browser' ? command.kind : command.payload.operation === 'expand' ? 'discovery' : command.payload.kind) as Action['kind'];
    const destination = command.payload.destination as Destination | undefined;
    const label = command.payload.operation === 'expand' ? 'Starting destination checks' : kind === 'conversation' ? 'Listening to your plans' : kind === 'browser' ? command.payload.purpose === 'requirements' ? `Checking your requirements in ${destination?.name ?? 'your destination'}` : command.payload.purpose === 'price' ? `Checking ${command.payload.priceKind === 'flights' ? 'flight' : 'stay'} prices for ${destination?.name ?? 'your destination'} in the browser` : `Checking travel without a car in ${destination?.name ?? 'your destination'}` : kind === 'flights' ? `Checking flights to ${destination?.name}` : kind === 'stays' ? `Checking stays in ${destination?.name}` : `Looking into ${destination?.name}`;
    const payload: Action = { id: command.id, label, provider: kind === 'conversation' || kind === 'browser' ? 'Grok' : kind === 'discovery' ? 'Tavily' : 'Apify', status, startedAt: previous?.status === 'queued' && status === 'running' ? now() : previous?.startedAt ?? now(), ...(previous?.queuedAt ? { queuedAt: previous.queuedAt } : {}), ...(status === 'done' || status === 'error' || status === 'superseded' ? { finishedAt: now() } : {}), ...(status === 'error' && command.delivery === 'unknown' ? { retryable: false } : {}), kind, destination: destination?.name, detail };
    return [event(trip.id, trip.state.revision, 'action', payload as unknown as Record<string, unknown>)];
  });
}
async function stayExclusions(tripId: string, id: string, extra = '') {
  const { data, error } = await db.from('roamer_commands').select('payload').eq('owner_id', ownerId).eq('trip_id', tripId).eq('kind', 'conversation').eq('payload->>candidateId', id).order('created_at');
  if (error) throw error;
  return excludedStayNames(data ?? [], extra);
}
async function enqueueSearches(tripId: string, destinations: Destination[], excludeStay = '', onlyCandidate?: string) {
  for (const destination of destinations.slice(0, 3)) {
    let trip = await getTrip(tripId, ownerId); const id = candidateId(destination);
    if (onlyCandidate && id !== onlyCandidate) continue;
    if (!trip.state.candidates.some(c => c.id === id)) trip = await commitEvents(tripId, t => [event(t.id, t.state.revision, 'candidate', {
      id, name: destination.name, country: destination.country, airport: destination.airport, image: imageFor(destination.name), summary: destination.reason ?? 'Checking how this fits your trip.', highlights: [], sources: [], status: 'researching', generation: t.state.revision
    }, stableId(`${tripId}:candidate:${id}:${t.state.revision}`))]);
    const candidate = trip.state.candidates.find(c => c.id === id)!;
    const excludedStays = await stayExclusions(tripId, id, excludeStay);
    const stayRequirements = tripRequirements(trip.state).map(requirement => requirement.text);
    const generation = (candidate as Candidate & { generation?: number }).generation ?? 0;
    for (const kind of ['discovery', 'flights', 'stays'] as const) {
      if (onlyCandidate && kind !== 'stays') continue;
      if (kind !== 'discovery' && !canPriceSearch(trip.state)) continue;
      const dataExists = kind === 'flights' ? candidate.flight : kind === 'stays' ? candidate.stay : candidate.sources.length;
      const stayContradicted = kind === 'stays' && candidate.stay && (stayIsExcluded(candidate.stay.label, excludedStays) || contradictsStayRequirements(candidate.stay.facts ?? {}, trip.state.criteria.stayStyle, stayRequirements));
      if (kind !== 'discovery' && dataExists && !(excludeStay && kind === 'stays') && !stayContradicted) continue;
      const fp = fingerprint(trip.state.criteria, kind);
      const commandId = stableId(`${tripId}:${id}:${generation}:${kind}:${fp}:${kind === 'stays' ? JSON.stringify({ excludedStays, stayRequirements }) : ''}`);
      await queueCommand(trip, 'research', { kind, destination, candidateId: id, criteria: trip.state.criteria, datesKnown: visibleCriteria(trip.state).departureDate !== null || (visibleCriteria(trip.state).departureStart !== null && visibleCriteria(trip.state).departureEnd !== null), fingerprint: fp, excludeStay, ...(kind === 'stays' ? { excludedStays, stayRequirements } : {}) }, commandId);
    }
  }
}
async function finishReceipt(lane: BotLane, command: CommandRow | undefined, status: 'done' | 'superseded') {
  if (!command) return;
  if (lane.waiter?.command.id === command.id) { lane.waiter.resolve(status); return; }
  if (command.status === 'done' || command.status === 'superseded') return;
  if (status === 'done' && command.kind === 'browser' && command.payload.purpose === 'price' && !(await finishBrowserPrice(command))) return;
  if (status === 'done' && command.kind === 'browser' && command.payload.purpose === 'requirements' && !(await finishRequirements(command))) return;
  await action(command, status, status === 'done' ? 'Grok’s delayed reply arrived and updated the trip.' : 'Grok’s delayed reply arrived after the trip details changed.');
  await setCommand(command, status, undefined, 'confirmed');
  await maybeFollowUp(command.trip_id);
}
async function ingest(lane: BotLane, entry: TranscriptEntry) {
  let bundles: ReturnType<typeof bundlesFromEntry>;
  try { bundles = bundlesFromEntry(entry); } catch (error) { throw new RejectedBundleError(safeError(error)); }
  for (let bundleIndex = 0; bundleIndex < bundles.length; bundleIndex++) {
    const bundle = bundles[bundleIndex];
    if (!bundle.commandId && !lane.bot.conversation) throw new RejectedBundleError('A research bot reply has no requested task.');
    const marker = stableId(transcriptKey(lane.bot, entry.id, bundleIndex, 'applied'));
    const markers = lane.bot.id === legacyCoordinatorId ? [marker, stableId(`grok:${entry.id}:${bundleIndex}:applied`)] : [marker];
    const reads = await Promise.allSettled([
      bundle.commandId ? db.from('roamer_commands').select('*').eq('id', bundle.commandId).eq('owner_id', ownerId).maybeSingle() : Promise.resolve({ data: null, error: null }),
      db.from('roamer_trips').select('*').eq('id', bundle.tripId).eq('owner_id', ownerId).maybeSingle(),
      db.from('roamer_events').select('id,payload').eq('owner_id', ownerId).in('id', markers)
    ]);
    const responses = reads.map(read => { if (read.status === 'rejected') throw read.reason; if (read.value.error) throw read.value.error; return read.value; });
    const receipt = responses[0].data as CommandRow | undefined;
    const found = responses[1].data;
    if (!found) continue;
    let trip = found as TripRow & BotBinding;
    if (trip.is_replay) continue;
    if (bundle.commandId) {
      const expectedBot = receipt ? commandBot(receipt, trip, bots) : undefined;
      if (!receiptMatches(lane.bot, expectedBot, receipt, trip.id, bundle.commandId)) throw new RejectedBundleError('The reply did not match a sent task for this bot and trip.');
    } else if (trip.bot_id !== lane.bot.id) throw new RejectedBundleError('A voice update belongs to another trip’s bot.');
    const already = responses[2].data?.[0];
    if (already && already.payload.resultingRevision !== trip.state.revision) { await finishReceipt(lane, receipt, 'superseded'); continue; }
    if (!already && trip.state.revision !== bundle.revision) {
      await finishReceipt(lane, receipt, 'superseded');
      continue;
    }
    if (!already) for (const modelEvent of bundle.events) {
      if (!allowedBotEvent(receipt, modelEvent.type, modelEvent.payload)) throw new RejectedBundleError('The update is outside this bot’s requested responsibility.');
      if (modelEvent.type === 'browser_quote' && !acceptsBrowserQuote(receipt, bundle.commandId, modelEvent.payload.candidateId, modelEvent.payload.kind)) throw new RejectedBundleError('A browser price update did not match its requested task.');
      if (modelEvent.type === 'browser_quote' && modelEvent.payload.kind === 'stays') {
        const quote = modelEvent.payload.quote;
        const exclusions = Array.isArray(receipt?.payload.excludedStays) ? receipt.payload.excludedStays.filter((name): name is string => typeof name === 'string') : [];
        if (stayIsExcluded(quote.label, exclusions) || contradictsStayRequirements(quote.facts ?? {}, trip.state.criteria.stayStyle, tripRequirements(trip.state).map(requirement => requirement.text))) throw new RejectedBundleError('The website quote conflicts with a requested stay exclusion or room requirement.');
      }
      if (modelEvent.type === 'browser_quote' || modelEvent.type === 'browser_evidence' || modelEvent.type === 'requirement_check') {
        if (!receipt || !browserTaskIsCurrent(receipt, trip.state.criteria, trip.state.candidates, tripRequirements(trip.state))) { await finishReceipt(lane, receipt, 'superseded'); return; }
      }
    }
    let applied = Boolean(already);
    let resultingRevision = trip.state.revision;
    const destinations = bundle.events.flatMap(e => e.type === 'search_request' ? e.payload.destinations : []).filter((d, i, all) => all.findIndex(other => other.airport === d.airport) === i).slice(0, 3);
    if (!already) trip = await commitEvents(trip.id, current => {
      applied = false;
      if (current.state.revision !== bundle.revision || (receipt?.kind === 'browser' && !browserTaskIsCurrent(receipt, current.state.criteria, current.state.candidates, tripRequirements(current.state)))) return null;
      applied = true;
      let state = current.state; const events: DomainEvent[] = [];
      for (let i = 0; i < bundle.events.length; i++) {
        const modelEvent = bundle.events[i];
        const next = event(trip.id, state.revision, modelEvent.type, modelEvent.payload, stableId(transcriptKey(lane.bot, entry.id, bundleIndex, i)));
        state = applyEvent(state, next); events.push(next);
      }
      events.push(event(trip.id, state.revision, 'grok_bundle', { entryId: entry.id, botId: lane.bot.id, botName: lane.bot.name, commandId: bundle.commandId ?? null, resultingRevision: state.revision, observedAt: now(), sentAt: entry.timestampMs ? new Date(entry.timestampMs).toISOString() : null }, marker));
      resultingRevision = state.revision;
      return events;
    }, () => destinations.length ? { id: stableId(`${marker}:expand`), kind: 'research', payload: { operation: 'expand', destinations, expectedRevision: resultingRevision } } : null, undefined, trip);
    if (!applied) {
      await finishReceipt(lane, receipt, 'superseded');
      continue;
    }
    // Candidate expansion is an atomic outbox job; reading the next Grok reply never waits for provider queue writes.
    await finishReceipt(lane, receipt, 'done');
  }
}
async function poll(lane: BotLane) {
  if (lane.polling || stopping) return; lane.polling = true;
  try {
    const entries = await transcript(lane.cursor, lane.bot);
    lane.failures = 0; lane.lastSuccessfulPoll = Date.now();
    for (const entry of entries) {
      try { await ingest(lane, entry); }
      catch (error) {
        if (!(error instanceof RejectedBundleError)) throw error;
        if (lane.waiter && bundlesFromEntrySafelyContains(entry, lane.waiter.command.id)) lane.waiter.reject(new Error('Grok returned an invalid structured update. Retry this conversation after checking the trip.'));
        console.warn(`[bridge:${lane.bot.name}] An update was rejected: ${safeError(error)}`);
      }
      lane.cursor = entry.id;
    }
    await heartbeat();
  } catch (error) { lane.failures++; console.warn(`[bridge:${lane.bot.name}] ${safeError(error)}`); }
  finally { lane.polling = false; }
}
function bundlesFromEntrySafelyContains(entry: TranscriptEntry, id: string) { return (entry.message?.content ?? entry.content ?? '').includes(id) && entry.kind !== 'message'; }
async function heartbeat() {
  const relevant = lanes.filter(lane => lane.bot.alwaysPoll || lane.waiter);
  const degraded = queueDisconnected || relevant.some(lane => lane.failures >= 3 || Date.now() - lane.lastSuccessfulPoll > 30000);
  const { error } = await db.from('roamer_workers').upsert([
    { id: workerId, owner_id: ownerId, heartbeat: now(), status: stopping ? 'offline' : degraded ? 'degraded' : 'online', detail: queueDisconnected ? 'Reconnecting to the trip service' : degraded ? 'Reconnecting to Grok' : active.size ? `${active.size} active tasks` : 'Ready', ...(lanes.find(lane => lane.bot.id === legacyCoordinatorId)?.cursor ? { cursor: lanes.find(lane => lane.bot.id === legacyCoordinatorId)!.cursor } : {}) },
    ...lanes.filter(lane => lane.bot.id !== legacyCoordinatorId).map(lane => {
      const reconnecting = queueDisconnected || lane.failures >= 3 || ((lane.bot.alwaysPoll || Boolean(lane.waiter)) && Date.now() - lane.lastSuccessfulPoll > 30000);
      return { id: `${workerId}:${lane.bot.id}`, owner_id: ownerId, heartbeat: now(), status: stopping ? 'offline' : reconnecting ? 'degraded' : 'online', detail: queueDisconnected ? 'Reconnecting to the trip service' : reconnecting ? 'Reconnecting to Grok' : lane.waiter ? 'Processing your request' : 'Ready', cursor: lane.cursor };
    })
  ]);
  if (error) throw error;
}
async function finishBrowserPrice(command: CommandRow) {
  const checked = await getTrip(command.trip_id, ownerId);
  const candidate = checked.state.candidates.find(c => c.id === command.payload.candidateId);
  const quote = command.payload.priceKind === 'flights' ? candidate?.flight : candidate?.stay;
  if (!quote) {
    command.delivery = 'confirmed';
    await action(command, 'error', 'A current price could not be confirmed on the website.');
    await setCommand(command, 'error', 'A current price could not be confirmed on the website.', 'confirmed');
    return false;
  }
  if (typeof command.payload.parentCommandId === 'string') {
    const parentId = command.payload.parentCommandId;
    await commitEvents(command.trip_id, current => {
      const original = current.state.actions.find(a => a.id === parentId);
      return original ? [event(current.id, current.state.revision, 'action', { ...original, status: 'superseded', finishedAt: original.finishedAt ?? now(), detail: `${original.detail ?? 'The structured search failed.'} A current price was supplied by ${quote.provider} at ${now()}.` }, stableId(`${command.id}:recovered`))] : null;
    });
    const { error } = await db.from('roamer_commands').update({ status: 'superseded', updated_at: now() }).eq('id', parentId).eq('trip_id', command.trip_id).eq('status', 'error');
    if (error) throw error;
  }
  return true;
}
async function finishRequirements(command: CommandRow) {
  const trip = await getTrip(command.trip_id, ownerId);
  const candidate = trip.state.candidates.find(c => c.id === command.payload.candidateId);
  const requested = command.payload.requirementIds as string[];
  const completed = candidate?.requirementChecks?.filter(check => check.fingerprint === command.payload.suitabilityFingerprint).map(check => check.requirementId) ?? [];
  if (requested.every(id => completed.includes(id))) return true;
  command.delivery = 'confirmed';
  await action(command, 'error', 'Some requirements could not be checked. Their status is still unknown.');
  await setCommand(command, 'error', 'Some requirements could not be checked.', 'confirmed');
  return false;
}
async function browserDeadline(lane: BotLane, command: CommandRow) {
  const isCurrent = () => lane.waiter?.command.id === command.id;
  if (!isCurrent()) return;
  const detail = 'This website check reached its response limit. Partial findings remain available.';
  await action(command, 'error', detail).catch(() => undefined);
  if (!isCurrent()) return;
  await requestScopedStop(command, {
    isCurrent,
    record: async fields => {
      const payload = { ...command.payload, ...fields };
      const { error } = await db.from('roamer_commands').update({ payload }).eq('id', command.id).eq('owner_id', ownerId);
      if (error) throw error;
      command.payload = payload;
    },
    send: (requestId, text, guard) => gbot(['send', lane.bot.id, text, '--request-id', requestId, '--correlation-id', requestId], 15000, guard)
  }).catch(error => console.warn(`[stop] ${safeError(error)}`));
  if (isCurrent()) lane.waiter!.reject(new Error(`${detail} A stop was requested; its completion is not confirmed.`));
}
async function runConversation(command: CommandRow) {
  const trip = await getTrip(command.trip_id, ownerId);
  const bot = commandBot(command, trip as TripRow & BotBinding, bots);
  if (!bot) throw new Error('This task has no permitted Grok bot.');
  const lane = laneFor(bot); lane.recentAt = Date.now();
  if (lane.waiter) throw new Error('This bot already has a task in progress.');
  const isBrowser = command.kind === 'browser';
  if (isBrowser) {
    if (!canPriceSearch(trip.state)) { await action(command, 'superseded', 'Trip details still need confirming before this dated check.'); await setCommand(command, 'superseded'); return; }
    let current = browserTaskIsCurrent(command, trip.state.criteria, trip.state.candidates, tripRequirements(trip.state));
    if (current && command.payload.priceKind === 'stays' && trip.state.revision !== command.revision) {
      const { count, error } = await db.from('roamer_events').select('id', { count: 'exact', head: true }).eq('trip_id', trip.id).eq('type', 'replace_stay').eq('payload->>id', command.payload.candidateId).gt('occurred_at', command.created_at);
      if (error) throw error;
      if (count) current = false;
    }
    if (!current) { await action(command, 'superseded', 'The trip or selected stay changed before this check started.'); await setCommand(command, 'superseded'); return; }
  }
  const request = { tripId: trip.id, commandId: command.id, revision: trip.state.revision, today: now().slice(0, 10), criteria: visibleCriteria(trip.state), missingSearchDetails: missingSearchDetails(trip.state), profile: trip.state.profile, requirements: tripRequirements(trip.state), questions: trip.state.questions, candidates: trip.state.candidates.filter(c => !isBrowser || c.id === command.payload.candidateId).map(c => ({ id: c.id, name: c.name, country: c.country, airport: c.airport, summary: c.summary, flight: canPriceSearch(trip.state) ? c.flight : undefined, stay: canPriceSearch(trip.state) ? c.stay : undefined, sources: c.sources.map(({ title, url }) => ({ title, url })), transport: c.transport, requirementChecks: c.requirementChecks })), request: command.payload.text };
  const prompt = `${isBrowser ? browserProtocol(String(command.payload.purpose)) : protocol}\n${JSON.stringify(request)}`;
  const response = new Promise<'done' | 'superseded'>((resolve, reject) => { lane.waiter = { command, resolve, reject }; });
  void response.catch(() => undefined);
  // Mark before sending: a worker crash can never automatically repeat an ambiguous message.
  const { error: deliveryError } = await db.from('roamer_commands').update({ delivery: 'unknown' }).eq('id', command.id);
  if (deliveryError) throw deliveryError;
  command.delivery = 'unknown';
  const timeout = setTimeout(() => {
    if (isBrowser) void browserDeadline(lane, command);
    else if (lane.waiter?.command.id === command.id) lane.waiter.reject(new Error('Grok has not returned a structured update yet. The message may still be processing; check Grok before sending again.'));
  }, isBrowser ? 90000 : 100000);
  try {
    // A valid reply proves delivery even when the send acknowledgement stalls.
    try { await Promise.race([gbot(['send', bot.id, prompt, '--request-id', command.id, '--correlation-id', command.id], 45000), response]); }
    catch (error) {
      if (!isBrowser) throw error;
      await action(command, 'error', 'Browser-task delivery is unconfirmed. Waiting briefly for a reply; other results remain available.');
    }
    const result = await response;
    if (result === 'done' && isBrowser && command.payload.purpose === 'price') {
      if (!(await finishBrowserPrice(command))) return;
    }
    if (result === 'done' && isBrowser && command.payload.purpose === 'requirements' && !(await finishRequirements(command))) return;
    await action(command, result === 'done' ? 'done' : 'superseded', result === 'done' ? isBrowser ? 'Source checks updated.' : 'Trip updated.' : 'Trip details changed while Grok was replying.');
    await setCommand(command, result, undefined, 'confirmed');
    if (!isBrowser && command.payload.candidateId) {
      const current = await getTrip(trip.id, ownerId); const c = current.state.candidates.find(c => c.id === command.payload.candidateId);
      if (c) await enqueueSearches(trip.id, [{ name: c.name, country: c.country, airport: c.airport }], String(command.payload.excludeStay ?? ''), c.id);
    }
  } finally { clearTimeout(timeout); clearWaiter(lane, command.id); }
}
async function runResearch(command: CommandRow, signal: AbortSignal) {
  if (command.payload.operation === 'expand') {
    const trip = await getTrip(command.trip_id, ownerId);
    if (trip.state.revision !== command.payload.expectedRevision) { await action(command, 'superseded', 'Trip details changed.'); await setCommand(command, 'superseded'); return; }
    await enqueueSearches(command.trip_id, command.payload.destinations as Destination[]);
    await action(command, 'done', 'Destination checks started.');
    await setCommand(command, 'done'); return;
  }
  if (command.payload.operation === 'transport-sources') {
    const trip = await getTrip(command.trip_id, ownerId);
    const candidate = trip.state.candidates.find(c => c.id === command.payload.candidateId);
    if (!candidate || !canPriceSearch(trip.state) || !browserTaskIsCurrent(command, trip.state.criteria, trip.state.candidates, tripRequirements(trip.state))) { await action(command, 'superseded', 'The transport details changed.'); await setCommand(command, 'superseded'); return; }
    const sources = await discover({ id: command.id, criteria: trip.state.criteria, destination: { name: candidate.name, country: candidate.country, airport: candidate.airport }, signal, datesKnown: true }, transportDiscoveryQuery(trip.state.criteria, candidate));
    await commitEvents(trip.id, current => {
      if (!browserTaskIsCurrent(command, current.state.criteria, current.state.candidates, tripRequirements(current.state))) return null;
      const c = current.state.candidates.find(c => c.id === candidate.id)!;
      return [event(current.id, current.state.revision, 'candidate', { ...c, sources: [...new Map([...c.sources, ...sources].map(source => [source.url, source])).values()] }, stableId(`${command.id}:sources`))];
    });
    await action(command, 'done', `${sources.length} transport source leads found; routes still need checking.`);
    await setCommand(command, 'done'); return;
  }
  const { kind, destination, candidateId: id, criteria, fingerprint: fp, excludeStay } = command.payload as { kind: 'discovery' | 'flights' | 'stays'; destination: Destination; candidateId: string; criteria: Criteria; fingerprint: string; excludeStay?: string };
  const current = await getTrip(command.trip_id, ownerId);
  if (kind !== 'discovery' && !canPriceSearch(current.state)) { await action(command, 'superseded', 'Trip details still need confirming before prices can be checked.'); await setCommand(command, 'superseded'); return; }
  if (kind === 'stays' && command.revision !== current.state.revision) {
    const { count, error } = await db.from('roamer_events').select('id', { count: 'exact', head: true }).eq('trip_id', command.trip_id).eq('type', 'replace_stay').eq('payload->>id', id).gt('occurred_at', command.created_at);
    if (error) throw error;
    if (count) { await action(command, 'superseded', 'A different stay was requested.'); await setCommand(command, 'superseded'); return; }
  }
  if (fingerprint(current.state.criteria, kind) !== fp) { await action(command, 'superseded', 'Trip details changed.'); await setCommand(command, 'superseded'); return; }
  const excludedStays = kind === 'stays' ? await stayExclusions(command.trip_id, id, excludeStay) : [];
  const context = { id: command.id, criteria, destination, signal, datesKnown: command.payload.datesKnown === true, excludedStays, stayRequirements: tripRequirements(current.state).map(requirement => requirement.text) };
  const [result, photo] = kind === 'discovery' ? await Promise.all([discover(context), destinationPhoto(destination.name, destination.country).catch(() => null)]) : [kind === 'flights' ? await searchFlights(context) : await searchStays(context, excludeStay), null];
  if (!result.length) throw new Error(kind === 'discovery' ? 'No useful sources were returned.' : kind === 'stays' ? 'No stay price could be confirmed for the current dates, party and room requirements.' : 'No return fare could be confirmed for the current dates and party.');
  let accepted = false;
  await commitEvents(command.trip_id, trip => {
    if (fingerprint(trip.state.criteria, kind) !== fp || trip.state.actions.find(a => a.id === command.id)?.status === 'superseded') return null;
    if (kind === 'stays' && contradictsStayRequirements((result[0] as import('../lib/domain').Quote).facts ?? {}, trip.state.criteria.stayStyle, tripRequirements(trip.state).map(requirement => requirement.text))) return null;
    accepted = true;
    if (kind === 'discovery') {
      const c = trip.state.candidates.find(c => c.id === id); if (!c) return null;
      return [event(trip.id, trip.state.revision, 'candidate', { ...c, ...(photo?.image ? photo : {}), sources: result }, stableId(`${command.id}:result`)), event(trip.id, trip.state.revision, 'assistant_message', { text: `Travel sources for ${destination.name} are ready. Dated prices and suitability are separate checks.` }, stableId(`${trip.id}:discovery-update:${trip.state.revision}`))];
    }
    return [event(trip.id, trip.state.revision, 'quote', { candidateId: id, kind, quote: result[0], alternatives: kind === 'stays' ? result.slice(1, 4) : undefined, fingerprint: fp }, stableId(`${command.id}:result`)), event(trip.id, trip.state.revision, 'assistant_message', { text: priceUpdate(destination.name, kind, result[0] as import('../lib/domain').Quote) }, stableId(`${command.id}:price-update`))];
  });
  await action(command, accepted ? 'done' : 'superseded', accepted ? kind === 'discovery' ? `${result.length} sources found.` : `${result.length} dated ${kind === 'flights' ? 'flight' : 'stay'} options checked.` : 'Trip details changed.');
  await setCommand(command, accepted ? 'done' : 'superseded');
}
async function maybeFollowUp(tripId: string) {
  const trip = await getTrip(tripId, ownerId);
  if (!trip.state.candidates.length || !canPriceSearch(trip.state)) return;
  const requirements = tripRequirements(trip.state);
  for (const c of trip.state.candidates.filter(c => c.stay)) {
    const checkTransport = trip.state.criteria.noCar === true && !c.transport?.verified;
    if (checkTransport) {
      const scope = browserScope(trip.state.criteria, c, 'transport', undefined, requirements);
      const sourcesId = stableId(`${tripId}:transport-sources:${scope}`);
      await queueCommand(trip, 'research', { operation: 'transport-sources', kind: 'discovery', purpose: 'transport', candidateId: c.id, browserScope: scope, destination: { name: c.name, country: c.country, airport: c.airport } }, sourcesId);
      const { data: sourceTask, error } = await db.from('roamer_commands').select('status').eq('id', sourcesId).maybeSingle();
      if (error) throw error;
      if (!sourceTask || ['queued', 'running'].includes(sourceTask.status)) continue;
      if (!requirements.length) await queueCommand(trip, 'browser', { purpose: 'transport', candidateId: c.id, browserScope: scope, destination: { name: c.name, country: c.country, airport: c.airport }, text: transportRequest(trip.state.criteria, c) }, stableId(`${tripId}:browser:${scope}`));
    }
    const fingerprint = suitabilityFingerprint(c, trip.state.criteria, requirements);
    const unchecked = requirementResults(c, trip.state.criteria, requirements).filter(result => !result.checkedAt).map(result => result.requirement.id);
    for (let offset = 0; offset < unchecked.length; offset += 12) {
      const requirementIds = unchecked.slice(offset, offset + 12);
      const scope = browserScope(trip.state.criteria, c, 'requirements', undefined, requirements);
      await queueCommand(trip, 'browser', { purpose: 'requirements', candidateId: c.id, requirementIds, checkTransport, suitabilityFingerprint: fingerprint, browserScope: scope, destination: { name: c.name, country: c.country, airport: c.airport }, text: requirementRequest(c, requirementIds, fingerprint) + (checkTransport ? `\nAlso check no-car access in this same visit: ${transportRequest(trip.state.criteria, c)}` : '') }, stableId(`${tripId}:requirements:${scope}:${requirementIds.join('|')}`));
    }
  }
}
async function settleTrip(tripId: string) {
  const { count, error } = await db.from('roamer_commands').select('id', { count: 'exact', head: true }).eq('trip_id', tripId).in('status', ['running', 'queued']);
  if (error) throw error;
  if (count) return;
  await commitEvents(tripId, trip => {
    const phase = trip.state.candidates.some(c => c.status === 'checked') ? 'ready' : trip.state.candidates.length ? 'blocked' : 'gathering';
    return phase === trip.state.phase ? null : [event(trip.id, trip.state.revision, 'phase', { phase })];
  });
}
async function enqueuePriceFallback(command: CommandRow) {
  const kind = command.payload.kind;
  if (command.kind !== 'research' || (kind !== 'flights' && kind !== 'stays')) return false;
  const trip = await getTrip(command.trip_id, ownerId);
  if (!canPriceSearch(trip.state)) return false;
  if (fingerprint(trip.state.criteria, kind) !== command.payload.fingerprint) return false;
  const candidate = trip.state.candidates.find(c => c.id === command.payload.candidateId);
  if (!candidate) return false;
  const d = dates(trip.state.criteria);
  const destination = { name: candidate.name, country: candidate.country, airport: candidate.airport };
  const excludedStays = kind === 'stays' ? await stayExclusions(trip.id, candidate.id, String(command.payload.excludeStay ?? '')) : [];
  const task = kind === 'flights' ? `return flights from ${trip.state.criteria.origin} (${trip.state.criteria.originCode}) to ${candidate.name} (${candidate.airport})` : `one stay in ${candidate.name}, ${candidate.country}${excludedStays.length ? `, excluding these previously rejected properties: ${JSON.stringify(excludedStays)}` : ''}`;
  const text = `The structured search could not confirm a price for candidate ${candidate.id}. Check ${task} in your actual browser for ${trip.state.criteria.travellers} adults, ${d.departureDate}–${d.returnDate}, GBP. Return browser_quote kind=${kind} only after verifying the current entire-party return/whole-stay price. Preserve the exact requirements ledger; record selected-room facts and cancellation where relevant. State included and unresolved charges. Never substitute per-person/per-night amounts, assume suitability from occupancy, or reuse a failed/old price. Explain blocked access without a quote.`;
  await queueCommand(trip, 'browser', { purpose: 'price', priceKind: kind, parentCommandId: command.id, candidateId: candidate.id, browserScope: browserScope(trip.state.criteria, candidate, 'price', kind), excludedStays, destination, text }, stableId(`${command.id}:browser-price`));
  return true;
}
async function processCommand(command: CommandRow, abort: AbortController) {
  try {
    if (command.owner_id !== ownerId) throw new Error('This worker cannot process another owner’s trip.');
    if (command.kind === 'conversation' && command.payload.internal) {
      await action(command, 'superseded', 'Findings are shown as they arrive; no queued summary is needed.');
      await setCommand(command, 'superseded'); return;
    }
    await action(command, 'running');
    if (command.kind === 'conversation' || command.kind === 'browser') await runConversation(command);
    else if (command.kind === 'research') await runResearch(command, abort.signal);
    else throw new Error('This task type is not supported.');
  } catch (error) {
    const detail = safeError(error);
    const fallback = !abort.signal.aborted && await enqueuePriceFallback(command).catch(() => false);
    await action(command, abort.signal.aborted ? 'superseded' : 'error', fallback ? `${detail} Checking the website directly.` : detail).catch(() => undefined);
    await setCommand(command, abort.signal.aborted ? 'superseded' : 'error', detail).catch(() => undefined);
    if (fallback) await commitEvents(command.trip_id, trip => fingerprint(trip.state.criteria, command.payload.kind as Action['kind']) === command.payload.fingerprint ? [event(trip.id, trip.state.revision, 'assistant_message', { text: `No dated ${command.payload.kind === 'flights' ? 'flight' : 'stay'} price is confirmed for ${(command.payload.destination as Destination).name} yet. A short website check is queued; other findings remain available.` }, stableId(`${command.id}:fallback-update`))] : null).catch(() => undefined);
    console.warn(`[task] ${command.kind} ${command.id}: ${detail}`);
  } finally {
    for (const lane of lanes) if (lane.waiter?.command.id === command.id) { lane.waiter = undefined; lane.recentAt = Date.now(); }
    active.delete(command.id);
    await maybeFollowUp(command.trip_id).catch(error => console.warn(`[follow-up] ${safeError(error)}`));
    await settleTrip(command.trip_id).catch(error => console.warn(`[status] ${safeError(error)}`));
  }
}
async function recoverLeases() {
  const { data, error } = await db.from('roamer_commands').select('*,roamer_trips!inner(workspace_id)').eq('owner_id', ownerId).neq('roamer_trips.workspace_id', 'legacy').eq('status', 'running').lt('lease_until', now());
  if (error) throw error;
  for (const command of (data ?? []) as CommandRow[]) {
    if (active.has(command.id)) continue;
    if (command.kind === 'conversation' || command.kind === 'browser') {
      if (!command.delivery) await setCommand(command, 'queued');
      else {
        await setCommand(command, 'error', 'The worker restarted before reply confirmation. Check Grok before sending again.', 'unknown');
        await action(command, 'error', 'The worker restarted before reply confirmation.');
      }
    } else { await setCommand(command, 'error', 'The worker stopped during this search. Retry to check current prices.'); await action(command, 'error', 'The worker stopped during this search.'); }
  }
}
async function maintenance() {
  if (maintaining) return;
  maintaining = true;
  try {
  await refreshRegistry();
  if (active.size) await db.from('roamer_commands').update({ lease_until: new Date(Date.now() + 90000).toISOString(), updated_at: now() }).in('id', [...active.keys()]);
  for (const { command, abort } of active.values()) {
    if (command.kind !== 'research' || command.payload.operation === 'expand') continue;
    const trip = await getTrip(command.trip_id, ownerId);
    if (command.payload.operation === 'transport-sources') {
      if (!canPriceSearch(trip.state) || !browserTaskIsCurrent(command, trip.state.criteria, trip.state.candidates, tripRequirements(trip.state))) abort.abort(new Error('Trip details changed.'));
      continue;
    }
    if (fingerprint(trip.state.criteria, command.payload.kind as Action['kind']) !== command.payload.fingerprint || trip.state.actions.find(a => a.id === command.id)?.status === 'superseded') abort.abort(new Error('Trip details changed.'));
  }
  await heartbeat(); await recoverLeases();
  } finally { maintaining = false; }
}
async function main() {
  await mkdir('.roamer', { recursive: true });
  try { const oldPid = Number(await readFile(lockPath, 'utf8')); if (oldPid) { try { process.kill(oldPid, 0); throw new Error('Another isolated Roamer worker is already running.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } } await unlink(lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const lock = await open(lockPath, 'wx'); await lock.writeFile(String(process.pid)); await lock.close();
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  const pollAgain = async (lane: BotLane) => {
    const startedAt = Date.now();
    if (bots.some(bot => bot.id === lane.bot.id) && (lane.bot.alwaysPoll || lane.waiter || Date.now() - lane.recentAt < 600000)) await poll(lane);
    if (!stopping) lane.timer = setTimeout(() => void pollAgain(lane), Math.max(0, 2000 - (Date.now() - startedAt)));
  };
  const stop = () => { stopping = true; for (const lane of lanes) lane.waiter?.reject(new Error('The worker is stopping.')); for (const job of active.values()) job.abort.abort(new Error('The worker is stopping.')); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    await retryConnection(async () => {
      await refreshRegistry();
      const { data: uncertain, error: uncertainError } = await db.from('roamer_commands').select('*,roamer_trips!inner(workspace_id)').eq('owner_id', ownerId).neq('roamer_trips.workspace_id', 'legacy').eq('delivery', 'unknown').in('status', ['running', 'error']).gte('updated_at', new Date(Date.now() - 3600000).toISOString());
      if (uncertainError) throw uncertainError;
      for (const command of (uncertain ?? []) as CommandRow[]) {
        const trip = await getTrip(command.trip_id, ownerId);
        try { const bot = commandBot(command, trip as TripRow & BotBinding, bots); if (bot) laneFor(bot).recentAt = Date.now(); } catch { /* Unconfigured legacy trips cannot route into a personal bot. */ }
      }
      await recoverLeases(); await heartbeat();
    }, { stopped: () => stopping, wait: sleep, failed: (error, retryInMs) => console.warn(`[startup] The trip service is unavailable; retrying in ${retryInMs} ms. ${safeError(error)}`) });
    if (stopping) return;
    console.log(`Roamer worker online: ${bots.length} registered bots have independent task lanes. Grok credentials stay on this laptop.`);
    maintenanceTimer = setInterval(() => void maintenance().catch(error => console.warn(`[worker] ${safeError(error)}`)), 15000);
    startLanePolling = lane => { void pollAgain(lane); };
    for (const lane of lanes) startLanePolling(lane);
    let claimFailures = 0;
    while (!stopping) {
      try {
        // Each existing bot owns one screen; provider searches have a separate three-job budget.
        const busyBots = [legacyCoordinatorId, ...active.values()].flatMap(x => typeof x === 'string' ? [x] : x.bot ? [x.bot.id] : []);
        if (active.size < Math.min(8, 3 + bots.length)) {
          const researchCount = [...active.values()].filter(x => x.command.kind === 'research').length;
          const { data, error } = await db.rpc('roamer_claim_parallel', { p_owner: ownerId, p_busy_bots: busyBots, p_allow_research: researchCount < 3 });
          if (error) throw error;
          const command = data?.[0] as CommandRow | undefined;
          if (command) {
            const trip = await getTrip(command.trip_id, ownerId);
            const bot = commandBot(command, trip as TripRow & BotBinding, bots);
            if (bot && busyBots.includes(bot.id)) { await setCommand(command, 'queued'); }
            else { const abort = new AbortController(); active.set(command.id, { command, abort, bot }); void processCommand(command, abort); }
          }
        }
        claimFailures = 0;
        queueDisconnected = false;
        await sleep(500);
      } catch (error) {
        queueDisconnected = true;
        const delay = backoffDelay(++claimFailures);
        console.warn(`[queue] The trip service is unavailable; retrying in ${delay} ms. ${safeError(error)}`);
        await sleep(delay);
      }
    }
  } finally { stop(); for (const lane of lanes) clearTimeout(lane.timer); clearInterval(maintenanceTimer); while (active.size || lanes.some(lane => lane.polling)) await sleep(200); await heartbeat().catch(() => undefined); await unlink(lockPath).catch(() => undefined); }
}
main().catch(error => { console.error(`[worker] ${safeError(error)}`); process.exitCode = 1; });
