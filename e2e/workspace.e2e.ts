import { test,expect,type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dates,initialState,type TripState,type Quote } from '../src/lib/domain';
import { commitEvents,event } from '../src/lib/db';

const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false}});
const created:string[]=[];const timings:{name:string;ms:number}[]=[];
const allowQueueTests=process.env.ROAMER_ALLOW_QUEUE_TESTS==='1';
let authSession:unknown;
test.beforeAll(async({request})=>{
  test.setTimeout(90000);
  for(let attempt=0;attempt<3;attempt++){
    const response=await request.post('/api/login',{data:{code:process.env.ROAMER_ACCESS_CODE},timeout:25000});
    if([502,503,504].includes(response.status())&&attempt<2){await new Promise(resolve=>setTimeout(resolve,500));continue;}
    expect(response.status(),'Private demo login should succeed').toBe(200);authSession=(await response.json()).session;return;
  }
});
async function fixture(state:TripState=initialState()){
  if(state.candidates.length)state.confirmedCriteria=Object.keys(state.criteria) as (keyof typeof state.criteria)[];
  const {data:workspace,error:workspaceError}=await db.from('roamer_workspaces').select('bot_id,browser_bot_id').eq('owner_id',process.env.ROAMER_USER_ID!).eq('id','stress-slower').single();if(workspaceError)throw workspaceError;
  const id=randomUUID();const {error}=await db.from('roamer_trips').insert({id,owner_id:process.env.ROAMER_USER_ID,workspace_id:'stress-slower',...workspace,title:'Browser test fixture',state});if(error)throw error;created.push(id);return id;
}
async function signIn(page:Page,id:string){
  const project=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
  await page.addInitScript(({key,session})=>localStorage.setItem(key,JSON.stringify(session)),{key:`sb-${project}-auth-token`,session:authSession});
  const started=Date.now();let loaded=false;
  try{await page.goto(`/?trip=${id}`);await expect(page.locator('.app-shell')).toHaveAttribute('data-trip-id',id,{timeout:45000});loaded=true;}
  finally{timings.push({name:loaded?'initial trip load':'initial trip load (timed out)',ms:Date.now()-started});}
}
test.afterAll(async()=>{
  if(created.length){const {error}=await db.from('roamer_trips').delete().in('id',created).eq('owner_id',process.env.ROAMER_USER_ID!);if(error)throw error;}
  mkdirSync('output/playwright',{recursive:true});
  let earlier:unknown[]=[];try{earlier=JSON.parse(readFileSync('output/playwright/timings.json','utf8'));}catch{}
  writeFileSync('output/playwright/timings.json',JSON.stringify([...earlier,...timings.map(t=>({...t,recordedAt:new Date().toISOString()}))],null,2));
});
for(const width of [390,768,1280,1440])test(`workspace layout at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:width<1000?844:1000});const id=await fixture();await signIn(page,id);
  await expect(page.getByLabel('Message Roamer')).toBeVisible();
  await page.locator('.welcome-photos img').first().waitFor();await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(Array.from(document.images).filter(i=>i.loading!=='lazy').map(i=>i.decode().catch(()=>{})));});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  mkdirSync('output/playwright',{recursive:true});await page.screenshot({path:`output/playwright/empty-${width}.png`,fullPage:true});
  await expect(page.locator('.workspace')).toHaveClass(/chat-only/);await expect(page.getByRole('tab',{name:'Your trip'})).not.toBeVisible();await expect(page.locator('#trip-panel')).not.toBeVisible();
  await page.getByLabel('Message Roamer').fill('A long draft that should survive opening the trip details and changing tabs.');
  await page.getByRole('button',{name:'Edit trip details',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).not.toBeVisible();await expect(page.getByLabel('Message Roamer')).toHaveValue(/long draft/);
});

test('conversation, questions, realtime updates and criteria invalidation',async({page})=>{
  test.skip(!allowQueueTests,'Queues live worker jobs; run only in a controlled worker pause.');
  await page.setViewportSize({width:1440,height:1000});const id=await fixture();await signIn(page,id);
  const message='Two people from London, five nights in Europe, £1,000 total, hiking and good food.';
  await page.getByLabel('Message Roamer').fill(message);await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.getByText(message,{exact:true})).toBeVisible();
  await expect.poll(async()=>{const {data}=await db.from('roamer_commands').select('status').eq('trip_id',id);return data?.length;}).toBe(1);
  const start=Date.now();
  await commitEvents(id,t=>[
    event(id,t.state.revision,'assistant_message',{text:'I’ll check flights and stays while we narrow down the dates.'}),
    event(id,t.state.revision,'question',{id:'dates',prompt:'Which departure works for you?',options:['10 October','12 October','Any day in the window']})
  ]);
  await expect(page.getByRole('heading',{name:'Which departure works for you?'}).first()).toBeVisible();timings.push({name:'database update to visible question, including commit request',ms:Date.now()-start});
  await page.getByRole('button',{name:'10 October',exact:true}).first().click();await expect(page.locator('.answered-question').getByText('10 October',{exact:true})).toBeVisible();
  await expect.poll(async()=>{const {data}=await db.from('roamer_trips').select('state').eq('id',id).single();return data?.state.questions[0].answer;}).toBe('10 October');
  await page.reload();await expect(page.locator('.answered-question').getByText('10 October',{exact:true})).toBeVisible();
  await commitEvents(id,t=>[event(id,t.state.revision,'candidate',{id:'krakow',name:'Kraków',country:'Poland',airport:'KRK',image:'/images/krakow.jpg',summary:'A walkable old town with day trips to the hills.',highlights:['Old town','Day hikes'],sources:[],status:'researching'})]);
  await expect(page.getByRole('heading',{name:'Kraków',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Edit trip details',exact:true}).click();await page.getByLabel('Specific departure (optional)').fill('2026-10-12');await page.getByLabel('We’ll be travelling without a car').check();await page.getByRole('button',{name:'Save trip details'}).click();await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByText('Getting around without a car',{exact:true})).toBeVisible();
  const {data:row}=await db.from('roamer_trips').select('state').eq('id',id).single();expect(row?.state.criteria.departureDate).toBe('2026-10-12');expect(row?.state.revision).toBeGreaterThan(0);
  await page.screenshot({path:'output/playwright/conversation-1440.png',fullPage:true});
  const metrics=await page.evaluate(()=>(window as unknown as {__ROAMER_METRICS: {type:string;ms:number;committedAt?:string;receivedAt?:string}[]}).__ROAMER_METRICS??[]);
  for(const m of metrics){
    timings.push({name:m.type,ms:m.ms});
    if(m.committedAt&&m.receivedAt)timings.push({name:'database updated_at to browser receipt (wall clock)',ms:Date.parse(m.receivedAt)-Date.parse(m.committedAt)});
  }
});

test('errors, keyboard focus and private API boundary',async({page,request})=>{
  const denied=await request.get('/api/trips');expect(denied.status()).toBe(401);
  const id=await fixture();await signIn(page,id);await page.getByLabel('Message Roamer').focus();await expect(page.getByLabel('Message Roamer')).toBeFocused();
  await page.route('**/api/trips/*/commands',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'The search service is unavailable. Try again.'})}));
  await page.getByLabel('Message Roamer').fill('Keep this message if sending fails.');await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.locator('.error-banner')).toContainText('Try again');await expect(page.getByLabel('Message Roamer')).toHaveValue('Keep this message if sending fails.');
  await page.getByRole('button',{name:'Voice in Grok',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('This website doesn’t use your microphone.');await page.keyboard.press('Escape');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});

test('Change this stay retries a transient failure with one command and keeps the flight',async({page})=>{
  test.skip(!allowQueueTests,'Queues live worker jobs; run only in a controlled worker pause.');
  await page.setViewportSize({width:1440,height:1000});
  const state=initialState();
  const quote:Quote={total:180,currency:'GBP',travellers:2,...dates(state.criteria),checkedAt:new Date().toISOString(),url:'https://example.com/test-flight',label:'Fixture return flight',scope:'return-flights',includes:'Two travellers',provider:'Test fixture'};
  state.candidates=[{id:'test-krakow',name:'Kraków',country:'Poland',airport:'KRK',image:'/images/krakow.jpg',summary:'Test candidate for replacement',highlights:[],sources:[],flight:quote,stay:{...quote,total:400,label:'Fixture previous stay',url:'https://example.com/test-stay',scope:'whole-stay'},transport:{summary:'Fixture transport evidence',verified:true,sources:[{title:'Fixture route',url:'https://example.com/transit',checkedAt:new Date().toISOString()}]},status:'checked'}];
  const id=await fixture(state);await signIn(page,id);
  const requests:string[]=[];
  await page.route(`**/api/trips/${id}/commands`,async route=>{
    const body=route.request().postDataJSON();
    if(body.kind!=='replace_stay'){await route.continue();return;}
    requests.push(body.id);
    if(requests.length===1){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Sign-in verification is temporarily unavailable. Try again.'})});return;}
    await route.continue();
  });
  await page.getByRole('button',{name:'Change this stay',exact:true}).click();
  await expect(page.getByRole('button',{name:'Finding another stay…',exact:true})).toBeDisabled();
  await expect(page.getByRole('link',{name:'See stay in Kraków'})).not.toBeVisible({timeout:20000});
  await expect(page.getByRole('link',{name:'See flight to Kraków'})).toBeVisible();
  await expect.poll(()=>requests.length).toBe(2);expect(new Set(requests).size).toBe(1);
  const [{data:trip},{data:commands}]=await Promise.all([db.from('roamer_trips').select('state').eq('id',id).single(),db.from('roamer_commands').select('payload').eq('trip_id',id)]);
  expect(trip?.state.candidates[0].stay).toBeUndefined();expect(trip?.state.candidates[0].transport).toBeUndefined();expect(trip?.state.candidates[0].flight.label).toBe('Fixture return flight');
  expect(commands).toHaveLength(1);expect(commands?.[0].payload).toMatchObject({candidateId:'test-krakow',excludeStay:'Fixture previous stay'});
  await page.reload();await expect(page.getByRole('link',{name:'See flight to Kraków'})).toBeVisible();await expect(page.getByText('Fixture previous stay',{exact:true})).not.toBeVisible();
});

test('saving an open criteria form preserves a newer conversation update',async({page})=>{
  test.skip(!allowQueueTests,'Queues live worker jobs; run only in a controlled worker pause.');
  const state=initialState();state.confirmedCriteria=Object.keys(state.criteria) as (keyof typeof state.criteria)[];state.messages=[{id:randomUUID(),role:'user',text:'I am leaving London.',at:new Date().toISOString()}];
  await page.setViewportSize({width:1440,height:1000});const id=await fixture(state);await signIn(page,id);
  await page.getByRole('button',{name:'Edit trip details',exact:true}).click();
  await page.getByLabel('Specific departure (optional)').fill('2026-10-12');
  await commitEvents(id,t=>[event(id,t.state.revision,'trip_patch',{noCar:true,interests:['hiking','good food']})]);
  await expect(page.getByText('Getting around without a car',{exact:true})).toBeVisible();
  const outgoing:Record<string,unknown>[]=[];
  page.on('request',request=>{if(request.url().endsWith(`/api/trips/${id}/commands`))outgoing.push(request.postDataJSON());});
  await page.getByRole('button',{name:'Save trip details',exact:true}).click();await expect(page.getByRole('dialog')).not.toBeVisible({timeout:20000});
  expect(outgoing).toHaveLength(1);expect(outgoing[0].patch).toEqual({departureDate:'2026-10-12'});
  const {data:trip}=await db.from('roamer_trips').select('state').eq('id',id).single();
  expect(trip?.state.criteria).toMatchObject({departureDate:'2026-10-12',noCar:true,interests:['hiking','good food']});
  expect(trip?.state.revision).toBe(2);
});

test('offline and online transitions preserve the trip and unsent draft',async({page,context})=>{
  const state=initialState();state.confirmedCriteria=['origin'];state.messages=[{id:randomUUID(),role:'user',text:'I am leaving London.',at:new Date().toISOString()},{id:randomUUID(),role:'assistant',text:'Your saved trip is still here.',at:new Date().toISOString()}];
  const id=await fixture(state);await signIn(page,id);
  const draft='Keep this draft while the connection is down.';await page.getByLabel('Message Roamer').fill(draft);
  await context.setOffline(true);
  await expect(page.getByText('Your saved trip is still here.',{exact:true})).toBeVisible();await expect(page.getByLabel('Message Roamer')).toHaveValue(draft);
  await commitEvents(id,t=>[event(id,t.state.revision,'trip_patch',{noCar:true})]);
  await context.setOffline(false);
  await expect(page.getByText('Getting around without a car',{exact:true})).toBeVisible({timeout:25000});await expect(page.getByLabel('Message Roamer')).toHaveValue(draft);
  await page.reload();await expect(page.getByText('Your saved trip is still here.',{exact:true})).toBeVisible();await expect(page.getByText('Getting around without a car',{exact:true})).toBeVisible();
});
