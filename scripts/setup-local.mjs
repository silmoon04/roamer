import fs from 'node:fs';
import { parseEnv } from 'node:util';
import { createClient } from '@supabase/supabase-js';
const local = parseEnv(fs.readFileSync('.env.local','utf8'));
Object.assign(process.env,parseEnv(fs.readFileSync('.env','utf8')),local);
const db=createClient(local.NEXT_PUBLIC_SUPABASE_URL,local.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const additions={};
if(!local.ROAMER_USER_ID) {
  const email='demo@roamer.invalid';
  const {data,error}=await db.auth.admin.createUser({email,password:local.ROAMER_ACCESS_CODE,email_confirm:true});
  if(error)throw error;
  additions.ROAMER_USER_ID=data.user.id;additions.ROAMER_USER_EMAIL=email;
}
if(!local.APIFY_TOKEN) {
  const misc=parseEnv(fs.readFileSync('../misc/.env','utf8'));
  if(!misc.APIFY_KEY_1)throw new Error('Primary Apify key missing.');
  additions.APIFY_TOKEN=misc.APIFY_KEY_1;
}
if(Object.keys(additions).length)fs.appendFileSync('.env.local','\n'+Object.entries(additions).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
console.log('Private demo user and worker configuration ready. No credentials printed.');
