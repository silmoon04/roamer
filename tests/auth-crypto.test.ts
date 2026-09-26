import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { authenticatedUser } from '../src/lib/auth';

const fixture = vi.hoisted(() => ({ client: undefined as SupabaseClient | undefined }));
vi.mock('../src/lib/db', () => ({ adminDb: () => fixture.client }));
const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'ES256', use: 'sig' };
let jwksReads = 0;
let issuer = '';
let freshClient: () => SupabaseClient;
function token(patch: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'test-key', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ sub: 'private-owner', iss: issuer, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600, ...patch })).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${header}.${body}`), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${header}.${body}.${signature}`;
}
function request(jwt: string) { return new Request('http://local', { headers: { authorization: `Bearer ${jwt}` } }); }
beforeEach(() => {
  const url = `https://${randomUUID()}.supabase.co`; issuer = `${url}/auth/v1`; jwksReads = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL = url; process.env.ROAMER_USER_ID = 'private-owner';
  freshClient = () => createClient(url, 'fixture-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async input => {
    if (!String(input).endsWith('/.well-known/jwks.json')) throw new Error('Unexpected external request in cryptographic test');
    jwksReads++; return Response.json({ keys: [jwk] });
  } } });
  fixture.client = freshClient();
});
describe('real SDK signature verification', () => {
  it('cryptographically verifies a signed JWT and shares the SDK JWKS cache across request clients', async () => { const jwt = token(); expect((await authenticatedUser(request(jwt))).id).toBe('private-owner'); fixture.client = freshClient(); expect((await authenticatedUser(request(jwt))).id).toBe('private-owner'); expect(jwksReads).toBe(1); });
  it('rejects a modified JWT payload even with an otherwise valid owner and claims', async () => { const parts = token().split('.'); const body = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); body.exp += 3600; parts[1] = Buffer.from(JSON.stringify(body)).toString('base64url'); await expect(authenticatedUser(request(parts.join('.')))).rejects.toMatchObject({ status: 401 }); });
  it('rejects an expired signed JWT', async () => { await expect(authenticatedUser(request(token({ exp: 1 })))).rejects.toMatchObject({ status: 401 }); });
  it('rejects a correctly signed JWT for another owner', async () => { await expect(authenticatedUser(request(token({ sub: 'someone-else' })))).rejects.toMatchObject({ status: 401 }); });
  it('rejects a correctly signed JWT with the wrong issuer', async () => { await expect(authenticatedUser(request(token({ iss: 'https://another.supabase.co/auth/v1' })))).rejects.toMatchObject({ status: 401 }); });
});
