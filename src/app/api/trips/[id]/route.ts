import { authenticatedUser,apiError } from '@/lib/auth';
import { getTrip,getWorkerHealth } from '@/lib/db';
import { z } from 'zod';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
  try {const u=await authenticatedUser(request);const {id}=await params;z.uuid().parse(id);const trip=await getTrip(id,u.id);
    const worker=await getWorkerHealth(u.id,trip.bot_id);
    return Response.json({trip,worker},{headers:{'Cache-Control':'no-store'}});
  }catch(e){return apiError(e);}
}
