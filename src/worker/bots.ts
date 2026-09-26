import type { CommandRow } from '../lib/db';

export type Bot = { id: string; name: string; conversation: boolean; alwaysPoll?: boolean };
export type BotBinding = { bot_id?: string | null; browser_bot_id?: string | null };
export type WorkspaceBot = BotBinding & { id?: string; bot_name: string; owner_id: string };
export const legacyCoordinatorId = 'eaef29aa-d867-415e-aa91-44e884de5f6c';

export function registeredBots(workspaces: WorkspaceBot[], ownerId: string): Bot[] {
  const found = new Map<string, Bot>();
  for (const workspace of workspaces.filter(row => row.owner_id === ownerId && row.id !== 'legacy')) {
    if (workspace.bot_id) found.set(workspace.bot_id, { id: workspace.bot_id, name: workspace.bot_name, conversation: true, alwaysPoll: workspace.id === 'personal' });
    if (workspace.browser_bot_id && !found.has(workspace.browser_bot_id)) found.set(workspace.browser_bot_id, { id: workspace.browser_bot_id, name: `${workspace.bot_name} research`, conversation: false });
  }
  return [...found.values()];
}

export function commandBot(command: Pick<CommandRow, 'kind'>, trip: BotBinding, registry: Bot[]): Bot | undefined {
  if (command.kind === 'research') return undefined;
  if (command.kind !== 'conversation' && command.kind !== 'browser') throw new Error('This task type has no permitted Roamer bot.');
  const id = command.kind === 'browser' ? trip.browser_bot_id ?? trip.bot_id : trip.bot_id;
  const bot = registry.find(bot => bot.id === id);
  if (!bot) throw new Error('This trip’s Grok bot is not registered for this worker.');
  return bot;
}

export function receiptMatches(bot: Bot, expectedBot: Bot | undefined, command: CommandRow | undefined, tripId: string, commandId: string | undefined) {
  return Boolean(command && commandId && command.id === commandId && command.trip_id === tripId && command.delivery && command.status !== 'queued' && expectedBot?.id === bot.id);
}

export function allowedBotEvent(command: CommandRow | undefined, type: string, payload: Record<string, unknown>) {
  if (command?.kind !== 'browser') return !['browser_quote', 'browser_evidence', 'requirement_check'].includes(type);
  if (type === 'assistant_message') return true;
  if (payload.candidateId !== command.payload.candidateId) return false;
  if (type === 'requirement_check') return command.payload.purpose === 'requirements' && Array.isArray(command.payload.requirementIds) && command.payload.requirementIds.includes(payload.requirementId) && payload.fingerprint === command.payload.suitabilityFingerprint;
  if (type === 'browser_evidence') return command.payload.purpose === 'transport' || (command.payload.purpose === 'requirements' && command.payload.checkTransport === true);
  return type === 'browser_quote' && command.payload.purpose === 'price' && payload.kind === command.payload.priceKind;
}

export function transcriptKey(bot: Bot, entryId: string, bundleIndex: number, suffix: string | number) {
  return `grok:${bot.id}:${entryId}:${bundleIndex}:${suffix}`;
}
