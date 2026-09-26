import { adminDb } from './db';
import { z } from 'zod';
import { HttpError } from './errors';
export async function authenticatedUser(request: Request) {
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if(!token || token.length > 8192)throw new HttpError(401, 'Sign in to open your trips.');
  const unavailable = () => new HttpError(503, 'Sign-in verification is temporarily unavailable. Try again.');
  const owner = process.env.ROAMER_USER_ID;
  if (!owner) throw unavailable();
  let result: Awaited<ReturnType<ReturnType<typeof adminDb>['auth']['getClaims']>>;
  try {
    // getClaims verifies signatures and expiry; its JWKS cache avoids a user lookup on every command.
    result = await adminDb().auth.getClaims(token);
  } catch (error) {
    if (error instanceof SyntaxError) throw new HttpError(401, 'Sign in to open your trips.');
    throw unavailable();
  }
  if (result.error) {
    const { status, name } = result.error;
    if (name === 'AuthRetryableFetchError' || status === undefined || status === 0 || status === 429 || status >= 500) throw unavailable();
    throw new HttpError(401, 'Sign in to open your trips.');
  }
  const claims = result.data?.claims;
  const issuer = `${process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '')}/auth/v1`;
  const now = Math.floor(Date.now() / 1000);
  const audienceMatches = claims?.aud === 'authenticated' || (Array.isArray(claims?.aud) && claims.aud.includes('authenticated'));
  if (!claims || typeof claims.sub !== 'string' || claims.sub !== owner || claims.iss !== issuer || !audienceMatches || claims.role !== 'authenticated' || typeof claims.exp !== 'number' || claims.exp <= now || (typeof claims.nbf === 'number' && claims.nbf > now)) throw new HttpError(401, 'Sign in to open your trips.');
  return { id: claims.sub };
}
export function apiError(error: unknown) {
  const headers = { 'Cache-Control': 'no-store' };
  if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status, headers });
  if (error instanceof z.ZodError) return Response.json({ error: 'Check the trip details and try again.', fields: [...new Set(error.issues.map(i => i.path.join('.')))] }, { status: 400, headers });
  if (error instanceof SyntaxError) return Response.json({ error: 'The request could not be read.' }, { status: 400, headers });
  // Database and provider errors can contain request details. Do not return or log their raw messages.
  console.error('Roamer request failed', { type: error instanceof Error ? error.name : 'service-error' });
  return Response.json({ error: 'That update could not be saved. Try again shortly.' }, { status: 503, headers });
}
