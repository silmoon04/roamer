import { authenticatedUser,apiError } from '@/lib/auth';
import { adminDb,createTrip } from '@/lib/db';
import { workspaceIdSchema } from '@/lib/workspaces';
import { criteriaPatchSchema, criteriaSchema, visibleCriteria } from '@/lib/domain';
import { z } from 'zod';
export async function GET(request:Request) {
  try { const u=await authenticatedUser(request);
    const workspace=workspaceIdSchema.parse(new URL(request.url).searchParams.get('workspace')??'personal');
    const {data,error}=await adminDb().from('roamer_trips').select('id,title,is_replay,workspace_id,bot_id,browser_bot_id,criteria:state->criteria,confirmedCriteria:state->confirmedCriteria').eq('owner_id',u.id).eq('workspace_id',workspace).eq('archived',false).order('created_at',{ascending:false}).limit(20);
    if(error)throw error; return Response.json({trips:data?.map(({criteria,confirmedCriteria,...summary})=>{
      const confirmed=z.array(criteriaPatchSchema.keyof()).parse(confirmedCriteria??[]);
      return {...summary,state:{criteria:visibleCriteria({criteria:criteriaSchema.parse(criteria),confirmedCriteria:confirmed}),confirmedCriteria:confirmed}};
    })},{headers:{'Cache-Control':'no-store'}});
  } catch(e){return apiError(e);}
}
export async function POST(request:Request) {
  try { const u=await authenticatedUser(request); const body=await request.text();const input=z.object({workspace:workspaceIdSchema.optional()}).strict().parse(body?JSON.parse(body):{});return Response.json({trip:await createTrip(u.id,input.workspace)}); }
  catch(e){return apiError(e);}
}
