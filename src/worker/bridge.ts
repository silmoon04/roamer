import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseModelBundles } from '../lib/domain';
import type { Bot } from './bots';
import { CliGate } from './polling';
const execute = promisify(execFile);
const executable = resolve('node_modules/grok-bot-cli/dist/bin/gbot.mjs');
export const botName = 'Travel Agent';
let permittedBots: Bot[] = [];
export function setBotAllowlist(bots: Bot[]) { permittedBots = bots.map(bot => ({ ...bot })); }
const cliGate = new CliGate(4);
export type TranscriptEntry = { id: string; kind?: string; role?: string; content?: string; message?: { type?: string; content?: string }; timestampMs?: number; requestId?: string; seq?: number };
export function stableId(value: string) {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4'; hex[16] = '8'; const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export async function gbot(args: string[], timeout = 30000, beforeExecute?: () => boolean, readPriority: 0 | 1 = 0): Promise<Record<string, unknown>> {
  if (['thread', 'send'].includes(args[0]) && !permittedBots.some(bot => bot.id === args[1])) throw new Error('The Grok target is outside the registered workspace bot allowlist.');
  const attempts = args[0] === 'thread' ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const release = await cliGate.acquire(args[0] === 'send' ? 2 : readPriority);
      try {
        if (beforeExecute && !beforeExecute()) return { skipped: true };
        const { stdout } = await execute(process.execPath, [executable, ...args, '--json', '--no-history'], { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        return JSON.parse(stdout);
      } finally { release(); }
    } catch {
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  // CLI errors can contain gateway details. Never put raw stderr in a UI or log.
  throw new Error('The local Grok bridge did not respond. Check that Grok is running and signed in.');
}
export function assistantText(entry: TranscriptEntry) {
  if (entry.kind === 'send-message' && entry.message?.type === 'text') return entry.message.content ?? '';
  if (entry.kind === 'message' && entry.role === 'assistant') return entry.content ?? '';
  return '';
}
export function bundlesFromEntry(entry: TranscriptEntry) {
  const text = assistantText(entry);
  return text.includes('<roamer>') ? parseModelBundles(text) : [];
}
export async function transcript(after: string | undefined, bot: Bot, priority: 0 | 1 = 0): Promise<TranscriptEntry[]> {
  const response = await gbot(['thread', bot.id, '--limit', '200', ...(after ? ['--after', after] : [])], 12000, undefined, priority);
  const transcript = response.transcript as { entries?: TranscriptEntry[] } | undefined;
  if (!Array.isArray(transcript?.entries)) throw new Error('Grok returned an unfamiliar transcript format.');
  return transcript.entries;
}

export { protocol, browserProtocol } from './protocol';
