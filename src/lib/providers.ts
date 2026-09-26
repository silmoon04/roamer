import { mkdir, writeFile } from 'node:fs/promises';
import { dates, type Criteria, type Quote, type QuoteFacts, type Source } from './domain';
import { pause, WorkPool } from './providers/pool';

type Row = Record<string, unknown>;
const record = (v: unknown): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown) => typeof v === 'string' ? v : '';
const number = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;
const safeUrl = (v: unknown) => /^https?:\/\//.test(str(v)) ? str(v) : '';
const round = (v: number) => Math.round(v * 100) / 100;
export type Destination = { name: string; country: string; airport: string; reason?: string };
export type ProviderContext = { id: string; criteria: Criteria; destination: Destination; signal?: AbortSignal; datesKnown?: boolean; stayRequirements?: string[]; excludedStays?: string[] };
export type StayFacts = QuoteFacts;
const stayName = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
export function stayIsExcluded(name: string, exclusions: string[]) { return exclusions.some(excluded => stayName(excluded) === stayName(name)); }
export function requiresPrivateBathroom(requirements: string[]) {
  let required = false;
  for (const text of requirements) {
    const plain = text.toLowerCase();
    if (/\b(?:don.t|do not|no longer)\s+(?:need|require|want)\s+(?:a\s+)?private bathroom\b/.test(plain)) { required = false; continue; }
    if (/\bor\b/.test(plain)) continue;
    if (/(?:^|[,;]\s*)private bathroom\b|\b(?:need|require|want|must have|with)\s+(?:a\s+)?private bathroom\b/.test(plain)) required = true;
  }
  return required;
}
export function contradictsStayRequirements(facts: StayFacts, style: string, requirements: string[] = []) {
  return contradictsStayStyle(facts, style) || (requiresPrivateBathroom([style, ...requirements]) && /\bshared\s+(?:bathroom|toilet)\b/i.test(`${facts.roomName ?? ''} ${facts.bathroom ?? ''}`));
}

export function stayFacts(row: Row, room: Row, option: Row): StayFacts {
  const rawBeds = list(room.bedTypes).flatMap(group => list(record(group).beds).map(str)).filter(Boolean);
  const beds = rawBeds.map(text => /^(\d+)\s+(.+?)\s*$/.exec(text)).filter((match): match is RegExpExecArray => Boolean(match));
  // Alternative layouts must not be added together as if both were supplied.
  const certainBeds = rawBeds.length > 0 && beds.length === rawBeds.length && beds.every(match => Number(match[1]) > 0 && Number(match[1]) <= 30 && match[2].length <= 150) && beds.length <= 20 && !rawBeds.some(text => /\bor\b|\//i.test(text));
  const cancellation = list(option.yourChoices).map(str).filter(text => /cancel|refund/i.test(text)).join(' · ').slice(0, 600);
  const access = list(room.facilities).map(str).filter(text => /wheelchair|accessible|ground floor|lift|elevator|stairs|step.free/i.test(text)).join(' · ').slice(0, 600);
  const bathroom = list(room.facilities).map(str).filter(text => /private bathroom|shared (?:bathroom|toilet)|en.suite/i.test(text)).join(' · ').slice(0, 600);
  return { ...(str(row.type) ? { propertyType: str(row.type).slice(0, 120) } : {}), ...(str(room.roomType) ? { roomName: str(room.roomType).slice(0, 200) } : {}), ...(certainBeds ? { beds: beds.map(match => ({ type: match[2], count: Number(match[1]) })) } : {}), ...(cancellation ? { cancellation } : {}), ...(access ? { accessibility: access } : {}), ...(bathroom ? { bathroom } : {}) };
}

export function contradictsStayStyle(facts: StayFacts, style: string) {
  // This only excludes explicit contradictions. Accessibility and compound logic require a source check.
  const plain = style.trim().toLowerCase();
  if (/^(?:(?:a|small|quiet|cosy|private|boutique)\s+)*hotel(?:\s+rooms?)?(?:\s+only|\s*[,;]|$)/.test(plain) && !/\bor\b|aparthotel|not.*hotel|no.*hotel/.test(plain) && facts.propertyType && facts.propertyType.toLowerCase() !== 'hotel') return true;
  if (/^(?:an? )?apartment(?:\s+only|\s*[,;]|$)/.test(plain) && !/\bor\b|not.*apartment|no.*apartment/.test(plain) && facts.propertyType && !['apartment', 'aparthotel'].includes(facts.propertyType.toLowerCase())) return true;
  const needBeds = /\b(one|two|three|four|five|six|[1-6])\s+(?:(?:real|separate|single|twin)\s+)*beds?\b/.exec(plain);
  const counts: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  if (needBeds && facts.beds && !/\bor\b|(?:don.t|do not|no) need/.test(plain)) {
    const required = counts[needBeds[1]] ?? Number(needBeds[1]);
    const realBeds = facts.beds.filter(bed => !/sofa|fold|futon|rollaway/i.test(bed.type)).reduce((sum, bed) => sum + bed.count, 0);
    if (realBeds < required) return true;
  }
  if (facts.beds?.some(bed => /sofa/i.test(bed.type)) && /\b(?:no|without|not a|not any)\s+sofa(?:\s+beds?)?\b/.test(plain)) return true;
  if (facts.cancellation && /\b(?:free|flexible) cancellation\b/.test(plain) && /non.refundable/i.test(facts.cancellation) && !/free cancellation/i.test(facts.cancellation)) return true;
  return false;
}

export function stayTaxDescription(option: Row) {
  const taxes = number(option.excludedTaxesPrice), displayed = number(option.displayedPrice), total = number(option.price);
  if (taxes > 0 && displayed > 0 && Math.abs(total - displayed - taxes) < 0.015) return `The listed £${round(total).toFixed(2)} includes the source's £${round(taxes).toFixed(2)} tax/charge breakdown. Other charges need checking.`;
  return taxes > 0 ? `The source also lists £${round(taxes).toFixed(2)} taxes/charges; their treatment in this price is unconfirmed.` : 'Tax and local-charge treatment is unconfirmed.';
}

export function normalizeFlights(rows: unknown[], context: ProviderContext, checkedAt: string, rawId: string): Quote[] {
  const d = dates(context.criteria);
  return rows.flatMap(value => {
    const row = record(value);
    if (row.currency !== 'GBP' || row.tripType !== 'round-trip' || row.departureDate !== d.departureDate || row.returnDate !== d.returnDate || row.destination !== context.destination.airport || number(row.price) <= 0) return [];
    const outbound = record(row.outbound), inbound = record(row.return);
    if (!list(outbound.segments).length || !list(inbound.segments).length) return [];
    const links = list(record(row.bookingDetails).bookingLinks).map(v => safeUrl(record(v).url)).filter(v => v && !v.includes('...'));
    const flightQuery = `${context.criteria.travellers} adults round trip ${str(row.origin) || context.criteria.originCode} to ${context.destination.airport} ${d.departureDate} return ${d.returnDate}`;
    const url = links[0] || `https://www.google.com/travel/flights?hl=en&curr=GBP&q=${encodeURIComponent(flightQuery)}`;
    const airline = list(row.airlines).map(str).filter(Boolean).join(', ') || 'Return flight';
    return [{ total: round(number(row.price)), currency: 'GBP' as const, travellers: context.criteria.travellers, ...d, checkedAt, url,
      label: `${airline} · ${str(row.origin)}–${context.destination.airport}`, scope: 'return-flights' as const,
      includes: `Return flights for ${context.criteria.travellers} adults. Baggage and optional extras require checking at booking.`, provider: 'Google Flights via Apify', rawId }];
  }).sort((a, b) => a.total - b.total);
}

export function normalizeStays(rows: unknown[], context: ProviderContext, checkedAt: string, rawId: string, exclude = ''): Quote[] {
  const d = dates(context.criteria);
  return rows.flatMap(value => {
    const row = record(value); const name = str(row.name);
    if (!name || stayIsExcluded(name, [...context.excludedStays ?? [], ...(exclude ? [exclude] : [])]) || row.checkInDate !== d.departureDate || row.checkOutDate !== d.returnDate || !['GBP', '£'].includes(str(row.currency))) return [];
    const url = safeUrl(row.url); if (!url) return [];
    const params = new URL(url).searchParams;
    if (Number(params.get('group_adults')) !== context.criteria.travellers) return [];
    const options = list(row.rooms).flatMap(v => {
      const room = record(v); if (room.available !== true) return [];
      return list(room.options).map(v => ({ room, option: record(v) }));
    }).filter(({ room, option }) => number(option.price) > 0 && ['GBP', '£'].includes(str(option.currency)) && number(option.persons) === context.criteria.travellers && option.hasGeniusDiscount !== true && !contradictsStayRequirements(stayFacts(row, room, option), context.criteria.stayStyle, context.stayRequirements))
      .sort((a, b) => number(a.option.price) - number(b.option.price));
    if (!options.length) return [];
    const { room, option } = options[0];
    const choices = list(option.yourChoices).map(str).filter(Boolean).slice(0, 3).join(' · ');
    const facts = stayFacts(row, room, option);
    return [{ total: round(number(option.price)), currency: 'GBP' as const, travellers: context.criteria.travellers, ...d, checkedAt, url,
      label: name, scope: 'whole-stay' as const,
      includes: `${context.criteria.nights} nights · ${str(room.roomType)} · ${context.criteria.travellers} adults. ${choices} · ${stayTaxDescription(option)}`,
      facts, image: safeUrl(row.image) || undefined, provider: 'Booking.com via Apify', rawId }];
  }).sort((a, b) => a.total - b.total);
}

const actors = new WorkPool(2);
async function apify(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
  const token = process.env.APIFY_TOKEN; if (!token) throw new Error('Apify is not configured.');
  const attempts = method === 'GET' ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(15000);
      const response = await fetch(`https://api.apify.com/v2/${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) {
        if (attempt + 1 < attempts && (response.status === 429 || response.status >= 500)) { await pause(300 * (attempt + 1), signal); continue; }
        throw new Error(`Apify returned HTTP ${response.status}.`);
      }
      return await response.json();
    } catch (error) {
      if (signal?.aborted || attempt + 1 >= attempts || (error instanceof Error && /^Apify returned HTTP 4(?!29)/.test(error.message))) throw error;
      await pause(300 * (attempt + 1), signal);
    }
  }
  throw new Error('Apify could not be reached.');
}
async function runActor(actor: string, input: Row, context: ProviderContext) {
  const budget = AbortSignal.timeout(200000);
  const signal = context.signal ? AbortSignal.any([context.signal, budget]) : budget;
  return actors.run(async () => {
    let run: Row = {}; let runId = ''; let phase = 'launch';
    try {
      signal.throwIfAborted();
      const response = record(await apify(`acts/${actor}/runs?timeout=150&maxTotalChargeUsd=0.25&waitForFinish=1`, 'POST', input, signal));
      run = record(response.data); runId = str(run.id);
      if (!runId) throw new Error('The search provider did not confirm a run ID. Check its run history before trying again.');
      phase = 'status';
      while (['READY', 'RUNNING', 'TIMING-OUT', 'ABORTING'].includes(str(run.status))) {
        signal.throwIfAborted();
        await pause(1500, signal);
        run = record(record(await apify(`actor-runs/${runId}`, 'GET', undefined, signal)).data);
      }
      if (run.status !== 'SUCCEEDED') throw new Error(run.status === 'TIMED-OUT' ? 'The provider could not finish within its time limit.' : 'The provider search failed before it returned usable prices.');
      phase = 'results';
      const rows = list(await apify(`datasets/${str(run.defaultDatasetId)}/items?clean=true&limit=12`, 'GET', undefined, signal));
      await mkdir('.roamer/evidence', { recursive: true });
      await writeFile(`.roamer/evidence/${context.id}.json`, JSON.stringify({ actor, input, run, rows }));
      return { rows, rawId: runId, checkedAt: str(run.finishedAt) || new Date().toISOString() };
    } catch (error) {
      if (runId && ['READY', 'RUNNING', 'TIMING-OUT'].includes(str(run.status))) await apify(`actor-runs/${runId}/abort`, 'POST').catch(() => undefined);
      await mkdir('.roamer/evidence', { recursive: true });
      await writeFile(`.roamer/evidence/${context.id}-failed.json`, JSON.stringify({ actor, input, run, phase, ...(phase === 'launch' && !runId ? { deliveryUnknown: true } : {}), failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : 'Search failed' }));
      throw error;
    }
  }, signal);
}

export async function searchFlights(context: ProviderContext) {
  const d = dates(context.criteria);
  // This exact input returned complete round trips in the live gate. normalizeFlights sorts prices locally.
  const input = { searches: [{ origin: context.criteria.originCode === 'LON' ? ['LHR', 'LGW', 'LTN', 'STN'] : context.criteria.originCode, destination: context.destination.airport, ...d }], adults: context.criteria.travellers, currency: 'GBP', country: 'GB', language: 'en-GB', maxResults: 5, includeBookingDetails: true, maxBookingDetails: 2, sortBy: 'best' };
  const result = await runActor('kaix~google-flights-scraper', input, context);
  return normalizeFlights(result.rows, context, result.checkedAt, result.rawId);
}
export async function searchStays(context: ProviderContext, exclude = '') {
  const d = dates(context.criteria);
  const input = { search: `${context.destination.name}, ${context.destination.country}`, checkIn: d.departureDate, checkOut: d.returnDate, adults: context.criteria.travellers, rooms: 1, children: 0, currency: 'GBP', language: 'en-gb', maxItems: exclude || context.excludedStays?.length ? 6 : 4, sortBy: 'review_score_and_price', extractAdditionalHotelData: false };
  const result = await runActor('voyager~booking-scraper', input, context);
  return normalizeStays(result.rows, context, result.checkedAt, result.rawId, exclude);
}
export async function discover(context: ProviderContext, queryOverride?: string): Promise<Source[]> {
  const key = process.env.TAVILY_API_KEY; if (!key) throw new Error('Tavily is not configured.');
  const interests = context.criteria.interests.join(', ');
  const month = context.datesKnown === false ? '' : new Date(`${dates(context.criteria).departureDate}T12:00:00Z`).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' });
  const query = queryOverride ?? `${context.destination.name} ${context.destination.country} official tourism ${interests} ${month} ${context.criteria.noCar ? 'public transport without a car' : ''}`.trim();
  let body: Row = {};
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, search_depth: 'basic', max_results: 4, include_answer: false }), signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Tavily returned HTTP ${response.status}.`);
      body = record(await response.json()); break;
    } catch (error) { if (context.signal?.aborted || attempt === 1 || (error instanceof Error && /^Tavily returned HTTP 4(?!29)/.test(error.message))) throw error; await pause(500, context.signal); }
  }
  const checkedAt = new Date().toISOString();
  await mkdir('.roamer/evidence', { recursive: true });
  await writeFile(`.roamer/evidence/${context.id}.json`, JSON.stringify({ query, checkedAt, results: body.results }));
  return list(body.results).map(record).filter(row => safeUrl(row.url)).map(row => ({ title: str(row.title).slice(0, 160), url: safeUrl(row.url), checkedAt, excerpt: str(row.content).slice(0, 600) }));
}
