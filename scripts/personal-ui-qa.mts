import { chromium,expect } from '@playwright/test';
import { mkdir,writeFile } from 'node:fs/promises';
import { adminDb } from '../src/lib/db';

const base=process.env.E2E_BASE_URL??'http://127.0.0.1:3000';
const personalId='917b1e2b-2581-42db-8180-b08de53f9dad';
const output='output/personal';await mkdir(output,{recursive:true});
const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:process.env.ROAMER_ACCESS_CODE})});
if(!login.ok)throw new Error(`Sign-in returned ${login.status}`);
const {session}=await login.json();
const headers={'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`};
async function api(path:string,body?:unknown){const r=await fetch(base+path,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});if(!r.ok)throw new Error(`API ${path}: ${r.status}`);return r.json();}
const original=await api(`/api/trips/${personalId}`);const history=await api('/api/trips');
const report:any={base,checkedAt:new Date().toISOString(),personalTripId:personalId,workspace:original.trip.workspace_id,personalVersionBefore:original.trip.version,personalProfile:original.trip.state.profile,history:(history.trips??[]).map((t:any)=>({id:t.id,title:t.title,workspace:t.workspace_id})),checks:[],errors:[]};
if(report.history.some((t:any)=>t.workspace!=='personal'||/stress/i.test(t.title)))throw new Error('Personal history contains a test workspace');
const browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});
const project=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
await context.addInitScript(({key,session})=>localStorage.setItem(key,JSON.stringify(session)),{key:`sb-${project}-auth-token`,session});
const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
let fixtureId:string|undefined;
async function settlePhotos(){await page.locator('img').evaluateAll(async imgs=>{await Promise.all(imgs.filter(i=>i.getBoundingClientRect().width&&i.getBoundingClientRect().height).map(i=>Promise.race([(i as HTMLImageElement).decode().catch(()=>{}),new Promise(r=>setTimeout(r,5000))])));});}
async function shot(name:string){await settlePhotos();await page.screenshot({path:`${output}/${name}.png`,fullPage:true});}
async function dimensions(name:string){report.checks.push({name,...await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,panelOverflow:[...document.querySelectorAll('.debug-panel,.trip-scroll,.conversation')].map(el=>({class:el.className,width:el.clientWidth,scrollWidth:el.scrollWidth})),photos:[...document.querySelectorAll('img')].filter(i=>i.getBoundingClientRect().width).map(i=>({loaded:i.complete&&i.naturalWidth>0,alt:i.alt,width:i.getBoundingClientRect().width}))}))});}
try {
  await page.goto(`${base}/?trip=${personalId}&debug=1`);await expect(page.locator('.app-shell')).toHaveAttribute('data-trip-id',personalId,{timeout:60000});
  await expect(page.locator('.debug-bot')).toHaveText('Roamer Personal',{timeout:60000});
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:width===390?844:1000});
    for(const [label,file]of [['Timing & tasks','timing'],['Inputs & outputs','events'],['Your feedback','feedback']]){
      await page.getByRole('button',{name:label,exact:true}).click();await expect(page.getByRole('button',{name:label,exact:true})).toHaveAttribute('aria-pressed','true');await shot(`personal-${width}-debug-${file}`);await dimensions(`${width}-${file}`);
    }
    await page.getByRole('button',{name:'Close debug view',exact:true}).click();
    await page.getByRole('button',{name:'Voice in Grok',exact:true}).click();
    await expect(page.getByRole('dialog')).toContainText('Roamer Personal');await expect(page.getByRole('dialog')).toContainText('Voice sync is awaiting a spoken test.');
    await shot(`personal-${width}-voice`);await page.getByRole('button',{name:'Back to my trip',exact:true}).click();
    await shot(`personal-${width}-chat`);await dimensions(`${width}-chat`);
    if(width===390){await page.getByRole('tab',{name:'Your trip',exact:true}).click();await shot('personal-390-trip');await dimensions('390-trip');await page.getByRole('tab',{name:'Chat',exact:true}).click();}
    await page.getByRole('button',{name:'Your trips',exact:true}).click();await expect(page.locator('.history-menu')).not.toContainText('Stress');await shot(`personal-${width}-history`);await page.getByRole('button',{name:'Close trip list',exact:true}).click();
    await page.getByRole('button',{name:'Debug view',exact:true}).click();
  }
  const fresh=await api(`/api/trips/${personalId}/debug`);report.debug={botName:fresh.trip.botName,workspace:fresh.trip.workspaceId,commands:fresh.commands.length,events:fresh.events.length,worker:fresh.worker?.status};
  if(!process.argv.includes('--read-only')){
  const created=await api('/api/trips',{workspace:'stress-slower'});fixtureId=created.trip.id;
  report.feedbackFixture={id:fixtureId,workspace:created.trip.workspace_id};
  await page.goto(`${base}/?trip=${fixtureId}&debug=1`);await expect(page.locator('.app-shell')).toHaveAttribute('data-trip-id',fixtureId!,{timeout:60000});
  await page.getByRole('button',{name:'Your feedback',exact:true}).click();
  await page.getByLabel('What felt wrong, slow or unclear?').fill('UI acceptance feedback fixture; no Grok task should be created.');
  const response=page.waitForResponse(r=>r.url().endsWith(`/api/trips/${fixtureId}/debug`)&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Save testing note',exact:true}).click();const saved=await response;report.feedbackFixture.saveStatus=saved.status();
  await expect(page.getByText('Saved with this trip and its current timings.',{exact:true})).toBeVisible({timeout:30000});await shot('fixture-feedback-saved-390');
  const debug=await api(`/api/trips/${fixtureId}/debug`);report.feedbackFixture.commands=debug.commands.length;report.feedbackFixture.noteEvents=debug.events.filter((e:any)=>e.type==='debug_note').length;
  expect(report.feedbackFixture.commands).toBe(0);expect(report.feedbackFixture.noteEvents).toBe(1);
  }
  const after=await api(`/api/trips/${personalId}`);report.personalVersionAfter=after.trip.version;expect(after.trip.version).toBe(original.trip.version);
  expect(report.checks.every((c:any)=>c.documentWidth<=c.width)).toBe(true);
}catch(e){report.failure=(e as Error).message;process.exitCode=1;}finally{
  if(fixtureId){const deleted=await adminDb().from('roamer_trips').delete().eq('id',fixtureId).eq('workspace_id','stress-slower').eq('owner_id',session.user.id).select('id');report.fixtureDeleted=!deleted.error&&deleted.data?.length===1;if(deleted.error)report.cleanupError=deleted.error.message;}
  await browser.close();await writeFile(`${output}/${process.argv.includes('--read-only')?'ui-readonly-report':'ui-report'}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({failure:report.failure,debug:report.debug,checkCount:report.checks.length,feedback:report.feedbackFixture,fixtureDeleted:report.fixtureDeleted,personalUnchanged:report.personalVersionBefore===report.personalVersionAfter,errors:report.errors}));
}
