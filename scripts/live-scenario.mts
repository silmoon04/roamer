import { chromium,expect } from '@playwright/test';
import { mkdir,writeFile } from 'node:fs/promises';
import { adminDb,type TripRow } from '../src/lib/db';

const base=process.env.E2E_BASE_URL??'http://127.0.0.1:3000';
const number=Number(process.argv[2]??'1');
const exerciseChanges=process.argv.includes('--changes');
const workspace=process.env.ROAMER_TEST_WORKSPACE??'stress-careful';
if(!['stress-careful','stress-slower','stress-friends'].includes(workspace))throw new Error('Live scenarios must use a registered tester workspace, never the personal workspace.');
const db=adminDb();
const response=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:process.env.ROAMER_ACCESS_CODE})});
if(!response.ok)throw new Error(`Sign-in returned ${response.status}.`);
const {session}=await response.json();
const headers={'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`};
const busy=await db.from('roamer_commands').select('id,roamer_trips!inner(workspace_id)').eq('owner_id',process.env.ROAMER_USER_ID!).eq('roamer_trips.workspace_id',workspace).in('status',['queued','running']);
if(busy.error||busy.data?.length)throw new Error('The tester workspace is busy or could not be checked. Do not overlap scenarios on one bot.');
const created=await fetch(base+'/api/trips',{method:'POST',headers,body:JSON.stringify({workspace})}).then(r=>r.json());
if(!created.trip)throw new Error('Trip creation failed.');
if(created.trip.workspace_id!==workspace||!created.trip.bot_id)throw new Error('The scenario did not receive its isolated tester bot.');
const id=created.trip.id;await db.from('roamer_trips').update({title:`Europe · live check ${number}`}).eq('id',id);
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const project=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
await page.addInitScript(({key,session})=>localStorage.setItem(key,JSON.stringify(session)),{key:`sb-${project}-auth-token`,session});
const errors:string[]=[];const requests:unknown[]=[];page.on('pageerror',e=>errors.push(e.message));
page.on('response',async r=>{if(r.url().endsWith('/commands'))requests.push({at:new Date().toISOString(),status:r.status(),kind:r.request().postDataJSON()?.kind});});
async function submit(action:()=>Promise<unknown>){const received=page.waitForResponse(r=>r.url().endsWith('/commands')&&r.request().method()==='POST'&&r.status()!==503,{timeout:90000});await action();const r=await received;if(!r.ok())throw new Error(`Command returned ${r.status()}: ${JSON.stringify(await r.json())}`);return r.json();}

await page.goto(`${base}/?trip=${id}`);await expect(page.locator('.app-shell')).toHaveAttribute('data-trip-id',id,{timeout:30000});
await mkdir('output/playwright',{recursive:true});await mkdir('.roamer',{recursive:true});
await writeFile('.roamer/current-live-trip.json',JSON.stringify({id,number,base}));
console.log(JSON.stringify({stage:'started',tripId:id,workspace,botId:created.trip.bot_id,number,exerciseChanges}));
const started=Date.now();const marks:Record<string,number>={};let answered=false,noCarSent=false,dateChanged=false,stayChanged=false;let lastVersion=-1;let lastLog=0;let idleSince=0;let trip:TripRow=created.trip;
const message='Two of us want five nights in Europe, leaving London between 10 and 20 October 2026. £1,000 total. We like hiking, good food and cosy places to stay. Start looking while we work out the details.';
await page.getByLabel('Message Roamer').fill(message);await submit(()=>page.getByRole('button',{name:'Send message',exact:true}).click());
try {
  while(Date.now()-started<900000) {
    const {data,error}=await db.from('roamer_trips').select('*').eq('id',id).single();if(error)throw error;trip=data;
    const s=trip.state;const elapsed=Date.now()-started;
    if(s.messages.some(m=>m.role==='assistant'))marks.firstResponse??=elapsed;
    if(s.candidates.some(c=>c.sources.length||c.flight||c.stay))marks.firstUsefulResult??=elapsed;
    if(s.candidates.some(c=>c.flight||c.stay))marks.firstPrice??=elapsed;
    if(s.candidates.length&&s.candidates.every(c=>c.status==='checked'))marks.checkedShortlist??=elapsed;
    if(Date.now()-lastLog>12000&&trip.version!==lastVersion){console.log(JSON.stringify({stage:'progress',seconds:Math.round(elapsed/1000),revision:s.revision,candidates:s.candidates.map(c=>({name:c.name,status:c.status,flight:!!c.flight,stay:!!c.stay,transport:!!c.transport?.verified})),actions:s.actions.filter(a=>a.status==='running'||a.status==='error').map(a=>({label:a.label,status:a.status,detail:a.status==='error'?a.detail:undefined}))}));lastVersion=trip.version;lastLog=Date.now();}
    const question=s.questions.find(q=>!q.answer&&!q.skipped);
    if(question&&!answered) {
      const option=question.options.find(x=>/not sure|flex|any|whole|total|food|both/i.test(x))??question.options[0];
      await submit(()=>page.getByRole('button',{name:option,exact:true}).first().click());answered=true;marks.clickedAnswer=elapsed;
    }
    if(exerciseChanges&&marks.firstUsefulResult&&!noCarSent) {
      await page.getByLabel('Message Roamer').fill('Neither of us drives. Keep this trip workable without a car.');await submit(()=>page.getByRole('button',{name:'Send message',exact:true}).click());noCarSent=true;marks.noCarSubmitted=elapsed;
    }
    if(exerciseChanges&&noCarSent&&s.criteria.noCar&&!dateChanged) {
      await page.getByRole('button',{name:'Edit trip details',exact:true}).click();await page.getByLabel('Specific departure (optional)').fill('2026-10-12');await submit(()=>page.getByRole('button',{name:'Save trip details'}).click());await expect(page.getByRole('dialog')).not.toBeVisible();dateChanged=true;marks.dateChanged=elapsed;
    }
    if(exerciseChanges&&dateChanged&&s.criteria.departureDate==='2026-10-12'&&s.candidates.some(c=>c.stay)&&!stayChanged) {
      const chosen=s.candidates.find(c=>c.stay)!;const card=page.locator('.candidate-card').filter({has:page.getByRole('heading',{name:chosen.name,exact:true})});
      const saved=await submit(()=>card.getByRole('button',{name:'Change this stay'}).click());if(saved.trip.state.candidates.find((c:{id:string})=>c.id===chosen.id)?.stay)throw new Error('Replacement did not invalidate the old stay.');stayChanged=true;marks.stayReplaced=elapsed;
    }
    const {count}=await db.from('roamer_commands').select('id',{count:'exact',head:true}).eq('trip_id',id).in('status',['queued','running']);
    if(!count&&s.messages.some(m=>m.role==='assistant')&&(!exerciseChanges||(dateChanged&&stayChanged))){idleSince||=Date.now();if(Date.now()-idleSince>12000){trip=(await db.from('roamer_trips').select('*').eq('id',id).single()).data;marks.finished=elapsed;break;}}else idleSince=0;
    if(s.actions.some(a=>a.kind==='conversation'&&a.status==='error')&&!count){marks.blocked=elapsed;break;}
    await new Promise(r=>setTimeout(r,1200));
  }
  await page.screenshot({path:`output/playwright/live-${number}-1440.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:`output/playwright/live-${number}-390-chat.png`,fullPage:true});await page.getByRole('tab',{name:'Your trip'}).click();await page.screenshot({path:`output/playwright/live-${number}-390-trip.png`,fullPage:true});
  const metrics=await page.evaluate(()=>(window as unknown as {__ROAMER_METRICS:unknown[]}).__ROAMER_METRICS??[]);
  const result={tripId:id,workspace,botId:created.trip.bot_id,number,startedAt:new Date(started).toISOString(),marks,errors,requests,metrics,state:trip.state};
  await writeFile(`.roamer/live-run-${number}.json`,JSON.stringify(result,null,2));
  console.log(JSON.stringify({stage:'finished',tripId:id,marks,errors,checked:trip.state.candidates.filter(c=>c.status==='checked').length,total:trip.state.candidates.length}));
} finally {await browser.close();}
