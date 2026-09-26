import { describe, expect, it } from 'vitest';
import { newTripForWorkspace, workspaceIdSchema, type WorkspaceRow } from '../src/lib/workspaces';

const workspace = (patch: Partial<WorkspaceRow> = {}): WorkspaceRow => ({ id: 'personal', owner_id: 'owner', bot_id: 'personal-bot', bot_name: 'My Grok', browser_bot_id: 'personal-research', profile: { interests: [], noCar: null, stayStyle: '', notes: [] }, ...patch });
describe('workspace boundaries', () => {
  it('creates a personal trip with its registered conversation and research bots', () => {
    expect(newTripForWorkspace('owner', workspace())).toMatchObject({ owner_id: 'owner', workspace_id: 'personal', bot_id: 'personal-bot', browser_bot_id: 'personal-research' });
  });
  it('does not inherit another workspace’s preferences', () => {
    const tester = newTripForWorkspace('owner', workspace({ id: 'stress-careful', bot_id: 'tester-bot', browser_bot_id: null, profile: { interests: ['hiking'], noCar: true, stayStyle: 'Quiet room', notes: ['Vegetarian'] } }));
    const personal = newTripForWorkspace('owner', workspace());
    expect(tester.state.profile.noCar).toBe(true); expect(personal.state.profile).toEqual({ interests: [], noCar: null, stayStyle: '', notes: [] });
    expect(personal.state.criteria.interests).toEqual([]); expect(personal.state.criteria.noCar).toBeNull();
  });
  it('copies a workspace profile without sharing mutable state', () => {
    const registry = workspace({ profile: { interests: ['food'], noCar: true, stayStyle: 'Private room', notes: ['Quiet'] } });
    const trip = newTripForWorkspace('owner', registry); trip.state.profile.notes.push('Trip only'); trip.state.criteria.interests.push('hiking');
    expect(registry.profile.notes).toEqual(['Quiet']); expect(registry.profile.interests).toEqual(['food']); expect(trip.state.profile.interests).toEqual(['food']);
  });
  it('rejects a registry row belonging to another owner', () => { expect(() => newTripForWorkspace('someone-else', workspace())).toThrowError(expect.objectContaining({ status: 404 })); });
  it('rejects creation on the earlier shared bot', () => { expect(() => newTripForWorkspace('owner', workspace({ id: 'legacy' }))).toThrowError(expect.objectContaining({ status: 409 })); });
  it('does not silently fall back to the earlier bot when setup is missing', () => { expect(() => newTripForWorkspace('owner', workspace({ bot_id: null }))).toThrowError(expect.objectContaining({ status: 503 })); });
  it.each(['legacy', 'other-workspace', 'bot-uuid'])('rejects a client workspace outside the configured choices: %s', id => { expect(workspaceIdSchema.safeParse(id).success).toBe(false); });
  it('rejects malformed saved preferences before creating a trip', () => { expect(() => newTripForWorkspace('owner', workspace({ profile: { interests: ['food'], noCar: null, stayStyle: 'x'.repeat(121), notes: [] } }))).toThrow(); });
});
