import type { CommandRow } from '../lib/db';
import { stableId } from './bridge';

export async function requestScopedStop(command: CommandRow, options: {
  isCurrent: () => boolean;
  record: (fields: Record<string, string>) => Promise<void>;
  send: (requestId: string, text: string, isCurrent: () => boolean) => Promise<Record<string, unknown>>;
}) {
  if (!options.isCurrent() || command.payload.stopRequestId) return;
  const requestId = stableId(`${command.id}:browser-deadline-stop:v1`);
  await options.record({ stopRequestId: requestId, stopDelivery: 'unknown', stopRequestedAt: new Date().toISOString() });
  if (!options.isCurrent()) { await options.record({ stopDelivery: 'not_sent' }); return; }
  try {
    const result = await options.send(requestId, `Stop now only the browser task for trip ${command.trip_id}, command ${command.id}. Its time budget has ended. Do not continue browsing or start a replacement task. Return any already checked evidence or unknown results for that original command using its existing Roamer identifiers. Do not stop other bots or work.`, options.isCurrent);
    await options.record({ stopDelivery: result.skipped ? 'not_sent' : result.accepted === true ? 'accepted' : 'unknown' });
  } catch {
    // An uncertain stop is recorded once. It must not be repeated automatically.
    await options.record({ stopDelivery: 'unknown' });
  }
}
