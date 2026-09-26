import { createHash, timingSafeEqual } from 'node:crypto';
import { adminDb } from '@/lib/db';
export async function POST(request:Request) {
  try {
    const ip = request.headers.get('x-real-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
    const bucket = createHash('sha256').update(`${process.env.ROAMER_ACCESS_CODE}:${ip}`).digest('hex');
    const {data:allowed,error:limitError} = await adminDb().rpc('roamer_login_attempt',{p_bucket:bucket});
    if(limitError) return Response.json({error:'Sign-in is unavailable. Try again shortly.'},{status:503,headers:{'Cache-Control':'no-store'}});
    if(!allowed) return Response.json({error:'Too many sign-in attempts. Try again in ten minutes.'},{status:429,headers:{'Retry-After':'600','Cache-Control':'no-store'}});
    const {code}=await request.json();
    const expected=Buffer.from(process.env.ROAMER_ACCESS_CODE??''); const actual=Buffer.from(typeof code==='string'?code:'');
    if(!expected.length || actual.length!==expected.length || !timingSafeEqual(actual,expected)) return Response.json({error:'That access code does not match.'},{status:401});
    const {data,error}=await adminDb().auth.signInWithPassword({email:process.env.ROAMER_USER_EMAIL!,password:process.env.ROAMER_ACCESS_CODE!});
    if(error || !data.session) return Response.json({error:'Sign-in is unavailable. Try again shortly.'},{status:503});
    return Response.json({session:data.session},{headers:{'Cache-Control':'no-store'}});
  } catch { return Response.json({error:'Enter your access code.'},{status:400}); }
}
