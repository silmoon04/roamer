import { dates, type Candidate, type Criteria } from '../lib/domain';

export function transportRequest(criteria: Criteria, candidate: Candidate) {
  const d = dates(criteria);
  const activities = criteria.interests.length ? `Also check access to places relevant to these stated interests: ${criteria.interests.join(', ')}.` : 'No activity preference is stated; do not add activity requirements.';
  return `For candidate ${candidate.id}, use official transport/source pages to verify travel without a car from ${candidate.airport} to the selected stay (${candidate.stay!.label}, ${candidate.stay!.url}) for ${d.departureDate}–${d.returnDate}. ${activities} Preserve every access limitation and AND/OR condition in the supplied requirements ledger. Give actual routes, changes, walking/access limitations and links. Mark noCarVerified true only when the requested access is supported; otherwise false with the specific gap.`;
}

export function requirementRequest(candidate: Candidate, ids: string[], fingerprint: string) {
  return `Use your browser to check the selected candidate ${candidate.id}, particularly its exact room/rate (${candidate.stay!.label}, ${candidate.stay!.url}), against these requirement IDs: ${JSON.stringify(ids)}. Echo fingerprint ${fingerprint}. Read their exact text from the supplied ledger; current criteria replace earlier dates/party/budget/origin/nights, while every other applicable AND/OR/exclusion remains. Price alone and adult capacity are insufficient. Cite source excerpts for bed layout, property type, cancellation deadline, accessibility and other factual constraints that apply. Check every requested ID; unknown is appropriate when a condition cannot be verified. Do not invent a broad fit verdict or change the selected stay.`;
}

export function transportDiscoveryQuery(criteria: Criteria, candidate: Candidate) {
  return `${candidate.name} ${candidate.country} ${candidate.airport} airport to ${candidate.stay!.label} official public transport routes timetable ${criteria.interests.join(' ')}`.trim();
}
