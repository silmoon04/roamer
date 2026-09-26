import { canPriceSearch, quoteMatches, withSuitability, type TripState } from './domain';

export function recordedReplay(input: TripState, recordedAt: string) {
  if (!Number.isFinite(Date.parse(recordedAt))) throw new Error('The saved run needs a valid recording time.');
  if (input.actions.some(action => action.status === 'queued' || action.status === 'running')) throw new Error('Wait for the live run to finish before recording it.');
  if (!canPriceSearch(input)) throw new Error('Confirm the trip details before recording a priced demo.');
  const state = withSuitability(structuredClone(input));
  const evidenced = state.candidates.some(candidate => [candidate.flight, candidate.stay].some(quote => quote && quoteMatches(quote, state.criteria) && Boolean(quote.rawId || candidate.sources.some(source => source.url === quote.url))));
  if (!evidenced || !state.messages.some(message => message.role === 'assistant')) throw new Error('A replay needs a real dated quote and a recorded conversation.');
  state.replay = true;
  state.replayRecordedAt = recordedAt;
  return state;
}
