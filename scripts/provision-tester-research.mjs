import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const execute=promisify(execFile), cli='node_modules/grok-bot-cli/dist/bin/gbot.mjs';
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
let receipts=[];
try {receipts=JSON.parse(await readFile('.roamer/tester-research-bots.json','utf8'));} catch(error) {if(error.code!=='ENOENT')throw error;}
for(const [workspace,name] of [['stress-careful','Roamer Careful Research'],['stress-slower','Roamer Slower Research'],['stress-friends','Roamer Friends Research']]) {
  let bot=receipts.find(row=>row.workspace===workspace);
  if(!bot) {
    const description=`Public travel source research only for Roamer ${workspace}. Use only your own screen and browser tabs. Follow the scoped task, trip and candidate in each request. Return partial evidence promptly within the requested time budget; stop when asked. Never book, purchase, send external messages, sign into personal accounts, or change another bot's tabs. Preserve exact requirements and report uncertainty.`;
    const {stdout}=await execute(process.execPath,[cli,'bots','create','--name',name,'--description',description,'--json'],{timeout:60000,maxBuffer:1024*1024,windowsHide:true});
    const result=JSON.parse(stdout);const created=result.bot??result.agent??result;
    if(!created.id)throw new Error('Research bot creation did not return an ID; check Grok before retrying.');
    bot={workspace,name,id:created.id};receipts.push(bot);
    await writeFile('.roamer/tester-research-bots.json',JSON.stringify(receipts,null,2));
  }
  const updated=await db.from('roamer_workspaces').update({browser_bot_id:bot.id}).eq('id',workspace).eq('owner_id',process.env.ROAMER_USER_ID).select('id').single();
  if(updated.error)throw new Error(`Could not register ${workspace} research bot`);
  console.log(JSON.stringify(bot));
}
