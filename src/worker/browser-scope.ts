import { fingerprint, suitabilityFingerprint, type Candidate, type Criteria, type TripRequirement } from '../lib/domain';
import type { CommandRow } from '../lib/db';

export function browserScope(criteria: Criteria, candidate: Candidate, purpose: 'price' | 'transport' | 'requirements', kind?: 'flights' | 'stays', requirements: TripRequirement[] = []) {
  return JSON.stringify({ candidateId: candidate.id, purpose, kind, fingerprint: purpose === 'requirements' ? suitabilityFingerprint(candidate, criteria, requirements) : fingerprint(criteria, purpose === 'price' ? kind! : 'browser'), ...(purpose === 'transport' ? { stay: candidate.stay ? `${candidate.stay.url}|${candidate.stay.label}` : null, ...(requirements.length ? { requirements } : {}) } : {}) });
}
export function browserTaskIsCurrent(command: CommandRow, criteria: Criteria, candidates: Candidate[], requirements: TripRequirement[] = []) {
  const candidate = candidates.find(c => c.id === command.payload.candidateId);
  if (!candidate) return false;
  if (command.payload.purpose === 'transport') return criteria.noCar === true && Boolean(candidate.stay) && command.payload.browserScope === browserScope(criteria, candidate, 'transport', undefined, requirements);
  if (command.payload.purpose === 'requirements') return Boolean(candidate.stay) && command.payload.browserScope === browserScope(criteria, candidate, 'requirements', undefined, requirements);
  if (command.payload.purpose !== 'price' || !['flights', 'stays'].includes(String(command.payload.priceKind))) return false;
  return command.payload.browserScope === browserScope(criteria, candidate, 'price', command.payload.priceKind as 'flights' | 'stays');
}
export function acceptsBrowserQuote(active: CommandRow | undefined, commandId: string | undefined, candidateId: string, kind: 'flights' | 'stays') {
  return Boolean(active && active.kind === 'browser' && active.payload.purpose === 'price' && active.id === commandId && active.payload.candidateId === candidateId && active.payload.priceKind === kind);
}
