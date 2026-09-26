import {createClient} from '@supabase/supabase-js';
import {readFile} from 'node:fs/promises';
const bots=JSON.parse(await readFile('.roamer/isolated-bots.json','utf8'));
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const rows=bots.filter(b=>b.workspace!=='personal-research').map(b=>({id:b.workspace,owner_id:process.env.ROAMER_USER_ID,bot_id:b.id,bot_name:b.name,browser_bot_id:b.workspace==='personal'?bots.find(x=>x.workspace==='personal-research').id:null}));
const result=await db.from('roamer_workspaces').upsert(rows,{onConflict:'id'}).select('id,bot_name,bot_id,browser_bot_id');
if(result.error)throw new Error('Workspace registration failed: '+result.error.code);
console.log(JSON.stringify({registered:result.data}));
