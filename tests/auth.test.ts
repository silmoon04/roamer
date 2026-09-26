import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { authenticatedUser, apiError } from '../src/lib/auth';
import { HttpError } from '../src/lib/errors';
const mock = vi.hoisted(() => ({ getClaims: vi.fn() }));
vi.mock('../src/lib/db', () => ({ adminDb: () => ({ auth: { getClaims: mock.getClaims } }) }));
const claims = () => ({ sub: 'private-owner', iss: 'https://private-demo.supabase.co/auth/v1', aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 });
const request = () => new Request('http://local', { headers: { authorization: 'Bearer valid-token' } });
beforeEach(() => { vi.clearAllMocks(); process.env.ROAMER_USER_ID = 'private-owner'; process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://private-demo.supabase.co'; });
describe('private API authentication', () => {
  it('rejects missing bearer tokens before contacting auth', async () => { await expect(authenticatedUser(new Request('http://local'))).rejects.toMatchObject({ status: 401 }); expect(mock.getClaims).not.toHaveBeenCalled(); });
  it('rejects non-Bearer credentials', async () => { await expect(authenticatedUser(new Request('http://local', { headers: { authorization: 'Basic secret' } }))).rejects.toMatchObject({ status: 401 }); });
  it('rejects valid users outside the private demo owner', async () => { mock.getClaims.mockResolvedValue({ data: { claims: { ...claims(), sub: 'other-owner' } } }); await expect(authenticatedUser(request())).rejects.toMatchObject({ status: 401 }); });
  it('accepts the configured private owner only from verified claims', async () => { mock.getClaims.mockResolvedValue({ data: { claims: claims() } }); expect((await authenticatedUser(request())).id).toBe('private-owner'); expect(mock.getClaims).toHaveBeenCalledWith('valid-token'); });
  it('fails closed if the private owner configuration is missing', async () => { delete process.env.ROAMER_USER_ID; await expect(authenticatedUser(request())).rejects.toMatchObject({ status: 503 }); expect(mock.getClaims).not.toHaveBeenCalled(); });
  it.each([
    { name: 'AuthRetryableFetchError', status: 0 }, { name: 'AuthRetryableFetchError', status: 503 },
    { name: 'AuthApiError', status: 429 }, { name: 'AuthUnknownError' }
  ])('treats verification outages as retryable rather than invalid sessions: %j', async error => { mock.getClaims.mockResolvedValue({ data: null, error }); await expect(authenticatedUser(request())).rejects.toMatchObject({ status: 503, message: 'Sign-in verification is temporarily unavailable. Try again.' }); });
  it('allows the same valid token after a transient verification failure', async () => { mock.getClaims.mockResolvedValueOnce({ data: null, error: { name: 'AuthRetryableFetchError', status: 0 } }).mockResolvedValueOnce({ data: { claims: claims() } }); await expect(authenticatedUser(request())).rejects.toMatchObject({ status: 503 }); expect((await authenticatedUser(request())).id).toBe('private-owner'); });
  it('treats thrown network failures as retryable', async () => { mock.getClaims.mockRejectedValueOnce(new TypeError('fetch failed')); await expect(authenticatedUser(request())).rejects.toMatchObject({ status: 503 }); });
  it('still rejects invalid signatures rather than retrying them', async () => { mock.getClaims.mockResolvedValueOnce({ data: null, error: { name: 'AuthInvalidJwtError', status: 400 } }); await expect(authenticatedUser(request())).rejects.toMatchObject({ status: 401 }); });
  it.each([{ exp: 1 }, { iss: 'https://another.supabase.co/auth/v1' }, { aud: 'service_role' }, { role: 'service_role' }, { nbf: 9999999999 }])('enforces verified claim boundaries: %j', async patch => { mock.getClaims.mockResolvedValue({ data: { claims: { ...claims(), ...patch } } }); await expect(authenticatedUser(request())).rejects.toMatchObject({ status: 401 }); });
  it('returns deliberate errors with their status and disables caching', async () => { const response = apiError(new HttpError(409, 'Already answered.')); expect(response.status).toBe(409); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.json()).toEqual({ error: 'Already answered.' }); });
  it('never returns raw provider or credential error text', async () => { const log = vi.spyOn(console, 'error').mockImplementation(() => {}); const response = apiError(new Error('request failed secret-key-123')); expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain('secret-key'); expect(JSON.stringify(log.mock.calls)).not.toContain('secret-key'); log.mockRestore(); });
  it('reports invalid fields without reflecting input', async () => { const parsed = z.object({ count: z.number() }).safeParse({ count: 'secret-input' }); if (parsed.success) throw Error('Expected rejection'); const response = apiError(parsed.error); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'Check the trip details and try again.', fields: ['count'] }); });
});
