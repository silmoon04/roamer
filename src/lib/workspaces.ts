import { z } from 'zod';
import { initialState, type Profile } from './domain';
import { HttpError } from './errors';

export const workspaceIdSchema = z.enum(['personal', 'stress-careful', 'stress-slower', 'stress-friends']);
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;
export type WorkspaceRow = { id: WorkspaceId | 'legacy'; owner_id: string; bot_id: string | null; bot_name: string; browser_bot_id: string | null; profile: Profile };
export const workspaceProfileSchema = z.object({
  interests: z.array(z.string().max(50)).max(12).default([]), noCar: z.boolean().nullable().default(null),
  stayStyle: z.string().max(120).default(''), notes: z.array(z.string().max(250)).max(12).default([])
}).strict();

export function newTripForWorkspace(ownerId: string, workspace: WorkspaceRow) {
  if (workspace.owner_id !== ownerId) throw new HttpError(404, 'Workspace not found.');
  if (workspace.id === 'legacy') throw new HttpError(409, 'Start a fresh trip to use your private Grok bot.');
  if (!workspace.bot_id || !workspace.bot_name) throw new HttpError(503, 'Your private Grok bot is being set up. Try again shortly.');
  return { owner_id: ownerId, workspace_id: workspace.id, bot_id: workspace.bot_id, browser_bot_id: workspace.browser_bot_id, state: initialState(workspaceProfileSchema.parse(workspace.profile)) };
}
