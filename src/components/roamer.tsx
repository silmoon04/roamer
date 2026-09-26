'use client';

import { useCallback,useEffect,useRef,useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { ArrowUp,ArrowUpRight,ArrowRight,AudioLines,Bookmark,CalendarDays,Check,CheckCheck,ChevronDown,ChevronRight,Clock3,Compass,ExternalLink,Footprints,History,House,ImageOff,Leaf,LoaderCircle,LockKeyhole,Landmark,Palette,MapPin,MessageCircle,Monitor,Mountain,Plane,Plus,RefreshCw,Search,Settings2,SlidersHorizontal,TrainFront,Users,Utensils,X } from 'lucide-react';
import { browserDb } from '@/lib/browser-db';
import DebugPanel from './debug-panel';
import CandidateRequirements from './candidate-requirements';
import RequirementEditor from './requirement-editor';
import TripCriteriaCard from './trip-criteria-card';
import TripEssentials from './trip-essentials';
import CriteriaForm from './criteria-editor';
import { candidateTotal,canPriceSearch,formatMoney,initialState,quoteMatches,visibleCriteria,type Action,type Candidate,type Criteria,type Profile,type Question,type TripState,type TripRequirement } from '@/lib/domain';
import type { TripRow } from '@/lib/db';

type Worker={heartbeat:string;status:string;detail?:string};
type TripSummary=Pick<TripRow,'id'|'title'|'is_replay'>&{state:{criteria:ReturnType<typeof visibleCriteria>}};
const ideas=[
  {id:'krakow',name:'Kraków',country:'Poland',hint:'Old town & mountain days',image:'/images/krakow.jpg'},
  {id:'ljubljana',name:'Ljubljana',country:'Slovenia',hint:'Riverside cafés & forest walks',image:'/images/ljubljana.jpg'},
  {id:'porto',name:'Porto',country:'Portugal',hint:'Good food & the Atlantic',image:'/images/porto.jpg'}
];
const scenario='Help me find a short break with good food and places to walk. Let’s work out the destination, dates and budget together.';
function dateRange(c:Criteria){if(c.departureDate)return dateLabel(c.departureDate);const first=new Date(c.departureStart+'T12:00:00Z');const last=new Date(c.departureEnd+'T12:00:00Z');return first.getUTCMonth()===last.getUTCMonth()?`${first.getUTCDate()}–${dateLabel(c.departureEnd)}`:`${dateLabel(c.departureStart)}–${dateLabel(c.departureEnd)}`;}
function dateLabel(value:string|null|undefined){return value?new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z')):'Dates not set';}
function people(n:number){return `${n} ${n===1?'person':'people'}`;}
function elapsed(value:string){const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(value))/1000));return seconds<60?`${seconds}s`:`${Math.floor(seconds/60)}m ${seconds%60}s`;}
function interestIcon(value:string){return /food|eat|dining/i.test(value)?Utensils:/art|museum/i.test(value)?Palette:/architect|history|city/i.test(value)?Landmark:/hik|walk|outdoor|coast/i.test(value)?Mountain:Compass;}
function relative(value:string){const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(value))/60000));return minutes<1?'just now':minutes===1?'1 min ago':`${minutes} min ago`;}
function Logo({small=false}:{small?:boolean}){return <span className={`brand-mark ${small?'small':''}`} aria-hidden="true"><Compass size={small?19:25} strokeWidth={1.7}/></span>;}
function Photo({src,alt,className='',eager=false}:{src:string;alt:string;className?:string;eager?:boolean}){
  const [failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[src]);
  return failed||!src?<div className={`photo-fallback ${className}`}><ImageOff size={25}/><span>Photo unavailable</span></div>:<img className={className} src={src} alt={alt} width={800} height={500} loading={eager?'eager':'lazy'} decoding="async" onError={()=>setFailed(true)}/>;
}
function IconButton({label,children,onClick,className='',disabled=false}:{label:string;children:React.ReactNode;onClick:()=>void;className?:string;disabled?:boolean}){return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>{children}</button>;}

export default function Roamer(){
  const [session,setSession]=useState<Session|null>(null);const [loading,setLoading]=useState(true);const [access,setAccess]=useState('');
  const [trip,setTrip]=useState<TripRow|null>(null);const [trips,setTrips]=useState<TripSummary[]>([]);const [worker,setWorker]=useState<Worker|null>(null);
  const [draft,setDraft]=useState('');const [sending,setSending]=useState(false);const [error,setError]=useState('');const [tab,setTab]=useState<'chat'|'trip'>('chat');
  const [unseen,setUnseen]=useState(false);const [history,setHistory]=useState(false);const [modal,setModal]=useState<'criteria'|'profile'|'voice'|'credits'|'delivery'|'requirements'|null>(null);
  const [tick,setTick]=useState(0);const chatScroll=useRef<HTMLDivElement>(null);const follow=useRef(true);const textarea=useRef<HTMLTextAreaElement>(null);
  const state=trip?.state??initialState();const readOnly=state.replay||trip?.workspace_id==='legacy';const latest=useRef(trip);latest.current=trip;
  const workerPresent=!!worker&&Date.now()-Date.parse(worker.heartbeat)<30000&&worker.status!=='offline';
  const online=workerPresent&&worker?.status==='online';
  const reconnecting=workerPresent&&worker?.status==='degraded';
  const active=state.actions.filter(a=>a.status==='running'||a.status==='queued');
  const failed=state.actions.filter(a=>a.status==='error');
  const interests=(visibleCriteria(state).interests??[]).filter(i=>!/cosy|cozy|stay|hotel|accommodation/i.test(i));
  const pendingQuestion=state.questions.find(q=>!q.answer&&!q.skipped);
  const visible=visibleCriteria(state);
  const hasUserMessage=state.messages.some(message=>message.role==='user'&&!message.pending);
  const showTripPanel=state.candidates.length>0||(hasUserMessage&&Boolean(visible.origin||visible.region||visible.travellers||visible.budget||visible.departureDate||visible.departureStart));

  const api=useCallback(async(path:string,body?:unknown)=>{
    const safeToRetry=!body||(typeof body==='object'&&body!==null&&'id' in body);
    for(let attempt=0;attempt<2;attempt++){
      const {data}=await browserDb().auth.getSession();
      let response:Response;
      try{response=await fetch(path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(data.session?{Authorization:`Bearer ${data.session.access_token}`}:{})},body:body?JSON.stringify(body):undefined});}
      catch{if(safeToRetry&&attempt===0){await new Promise(r=>setTimeout(r,500));continue;}throw new Error('Connection interrupted. Your trip is saved; try the update again.');}
      if(safeToRetry&&attempt===0&&[502,503,504].includes(response.status)){await new Promise(r=>setTimeout(r,500));continue;}
      const result=await response.json().catch(()=>({error:'This update could not be saved. Try again shortly.'}));
      if(!response.ok)throw new Error(result.error??'This update could not be saved.');return result;
    }
    throw new Error('This update could not be saved. Try again shortly.');
  },[]);
  const selectTrip=useCallback(async(id:string)=>{
    const result=await api(`/api/trips/${id}`);setTrip(result.trip);setWorker(result.worker);setHistory(false);setUnseen(false);follow.current=true;
    const url=new URL(location.href);url.searchParams.set('trip',id);historyReplace(url);
  },[api]);
  const listTrips=useCallback(async()=>{const result=await api('/api/trips');setTrips(result.trips);return result.trips as TripSummary[];},[api]);
  const newTrip=useCallback(async()=>{
    setError('');try{const result=await api('/api/trips',{});setTrip(result.trip);setTrips(prev=>[result.trip,...prev]);setHistory(false);setTab('chat');setDraft('');follow.current=true;const url=new URL(location.href);url.searchParams.set('trip',result.trip.id);historyReplace(url);}catch(e){setError((e as Error).message);}
  },[api]);
  async function login(code=access){
    setSending(true);setError('');try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});const j=await r.json();if(!r.ok)throw new Error(j.error);await browserDb().auth.setSession(j.session);setSession(j.session);setAccess('');}catch(e){setError((e as Error).message);}finally{setSending(false);}
  }
  useEffect(()=>{
    const db=browserDb();db.auth.getSession().then(({data})=>{setSession(data.session);setLoading(false);});
    const {data}=db.auth.onAuthStateChange((_e,s)=>setSession(s));
    const hash=new URLSearchParams(location.hash.slice(1));const code=hash.get('access');if(code){window.history.replaceState({},'',location.pathname+location.search);void login(code);}
    setTab(new URLSearchParams(location.search).get('view')==='trip'?'trip':'chat');
    const timer=setInterval(()=>setTick(t=>t+1),1000);return()=>{data.subscription.unsubscribe();clearInterval(timer);};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  useEffect(()=>{
    if(!session)return;let disposed=false;
    const selected=new URLSearchParams(location.search).get('trip');
    if(selected){void selectTrip(selected).catch(e=>{if(!disposed)setError(e.message);});void listTrips().catch(()=>undefined);}
    else void listTrips().then(async rows=>{if(disposed)return;const found=rows.find(t=>!t.is_replay);if(found)await selectTrip(found.id);else await newTrip();}).catch(e=>{if(!disposed)setError(e.message);});
    return()=>{disposed=true;};
  },[session?.user.id,listTrips,selectTrip,newTrip]);
  useEffect(()=>{
    if(!trip||!session)return;const id=trip.id;const db=browserDb();
    const channel=db.channel(`trip:${id}`).on('postgres_changes',{event:'UPDATE',schema:'public',table:'roamer_trips',filter:`id=eq.${id}`},payload=>{
      const next=payload.new as TripRow;if(latest.current?.id!==id||next.version<=latest.current.version)return;setTrip(previous=>previous?.id===id&&next.version>previous.version?next:previous);setUnseen(true);
      const received=performance.now();const receivedAt=new Date().toISOString();const visibilityState=document.visibilityState;requestAnimationFrame(()=>{const w=window as unknown as {__ROAMER_METRICS?:unknown[]};(w.__ROAMER_METRICS??=[]).push({type:payload.commit_timestamp?'realtime-render':'realtime-render-rowtime',tripId:id,ms:performance.now()-received,committedAt:payload.commit_timestamp||next.updated_at,receivedAt,renderedAt:new Date().toISOString(),visibilityState,renderVisibilityState:document.visibilityState,version:next.version});});
    }).on('postgres_changes',{event:'*',schema:'public',table:'roamer_workers',filter:`id=eq.laptop:${trip.bot_id}`},payload=>setWorker(payload.new as Worker)).subscribe();
    const refresh=async()=>{try{const result=await api(`/api/trips/${id}`);if(latest.current?.id===id&&result.trip.version>latest.current.version){const received=performance.now();const receivedAt=new Date().toISOString();const visibilityState=document.visibilityState;setTrip(previous=>previous?.id===id&&result.trip.version>previous.version?result.trip:previous);setUnseen(true);requestAnimationFrame(()=>{const w=window as unknown as {__ROAMER_METRICS?:unknown[]};(w.__ROAMER_METRICS??=[]).push({type:'poll-render',tripId:id,ms:performance.now()-received,committedAt:result.trip.updated_at,receivedAt,renderedAt:new Date().toISOString(),visibilityState,renderVisibilityState:document.visibilityState,version:result.trip.version});});}setWorker(result.worker);}catch{ /* The next poll retries without discarding the current trip. */ }};
    const timer=setInterval(refresh,10000);const onVisible=()=>{if(document.visibilityState==='visible')void refresh();};document.addEventListener('visibilitychange',onVisible);
    return()=>{void db.removeChannel(channel);clearInterval(timer);document.removeEventListener('visibilitychange',onVisible);};
  },[trip?.id,session?.user.id,api]);
  useEffect(()=>{if(follow.current&&chatScroll.current)chatScroll.current.scrollTop=chatScroll.current.scrollHeight;},[state.messages.length,state.questions.length,sending]);
  useEffect(()=>{if(tab==='trip')setUnseen(false);},[tab,trip?.version]);
  useEffect(()=>{if(!showTripPanel&&tab==='trip')setTab('chat');},[showTripPanel,tab]);
  void tick;

  function changeTab(next:'chat'|'trip'){setTab(next);const url=new URL(location.href);url.searchParams.set('view',next);historyReplace(url);}
  async function command(body:Record<string,unknown>){
    if(!trip)return;setError('');const start=performance.now();const id=crypto.randomUUID();
    if(body.kind==='message')setTrip(t=>t?{...t,state:{...t.state,messages:[...t.state.messages,{id,role:'user',text:String(body.text),at:new Date().toISOString(),pending:true}]}}:t);
    if(body.kind==='answer')setTrip(t=>t?{...t,state:{...t.state,questions:t.state.questions.map(q=>q.id===body.questionId?{...q,answer:String(body.answer),skipped:Boolean(body.skipped)}:q)}}:t);
    requestAnimationFrame(()=>{const w=window as unknown as {__ROAMER_METRICS?:unknown[]};(w.__ROAMER_METRICS??=[]).push({type:'interaction',tripId:trip.id,commandId:id,at:new Date().toISOString(),ms:performance.now()-start});});
    try{const result=await api(`/api/trips/${trip.id}/commands`,{id,...body});setTrip(t=>t&&t.id===result.trip.id&&t.version<=result.trip.version?result.trip:t);return true;}
    catch(e){setError((e as Error).message);const restored=await api(`/api/trips/${trip.id}`).catch(()=>null);if(restored)setTrip(t=>t?.id===restored.trip.id?restored.trip:t);return false;}
  }
  async function send(text=draft){if(!trip||!text.trim()||sending||readOnly)return;setDraft('');setSending(true);follow.current=true;const ok=await command({kind:'message',text:text.trim()});if(!ok)setDraft(text);setSending(false);textarea.current?.focus();}
  async function answer(q:Question,value:string,skipped=false){await command({kind:'answer',questionId:q.id,answer:value,skipped});}

  if(loading)return <main className="loading-page"><Logo/><LoaderCircle className="spin"/><span>Opening your trips…</span></main>;
  if(!session)return <main className="login-page"><div className="login-photo"><Photo src="/images/ljubljana.jpg" alt="Riverside buildings in Ljubljana" eager/><div className="login-photo-caption"><MapPin size={16}/>Ljubljana, Slovenia</div></div><section className="login-content"><a className="wordmark" href="/"><Logo/>roamer<span className="brand-dot">.</span></a><div><span className="quiet-label"><LockKeyhole size={14}/>Your private travel space</span><h1>A few days away<br/>starts here.</h1><p>Talk through the idea. Watch the trip take shape.</p><form onSubmit={e=>{e.preventDefault();void login();}}><label htmlFor="access-code">Access code</label><input id="access-code" type="password" name="password" autoComplete="current-password" value={access} onChange={e=>setAccess(e.target.value)} placeholder="Enter your private code…" required/><button className="button primary" disabled={sending}>{sending?<LoaderCircle className="spin" size={18}/>:<>Open Roamer<ArrowRight size={18}/></>}</button>{error&&<p role="alert" className="error-text">{error}</p>}</form></div><span className="login-foot">Built for the places you haven’t been yet.</span></section></main>;

  return <div className="app-shell" data-trip-id={trip?.id}>
    <a className="skip-link" href="#conversation" onClick={e=>{e.preventDefault();changeTab('chat');requestAnimationFrame(()=>document.getElementById('conversation')?.focus());}}>Skip to conversation</a>
    <header className="app-header"><a href="/" className="wordmark"><Logo/>roamer<span className="brand-dot">.</span></a><span className="header-note">A few days away.</span><nav aria-label="Workspace"><button className="text-button history-trigger" onClick={()=>setHistory(!history)}><History size={16}/>Your trips<ChevronDown size={14}/></button><button className="avatar" aria-label="Edit traveller profile" onClick={()=>setModal('profile')}>S</button></nav>
      {history&&<div className="history-menu"><div className="menu-title">Your trips<IconButton label="Close trip list" onClick={()=>setHistory(false)}><X size={16}/></IconButton></div><button className="new-trip-row" onClick={()=>void newTrip()}><Plus size={17}/>Start a new trip</button>{trips.map(t=><button key={t.id} className={trip?.id===t.id?'selected':''} onClick={()=>void selectTrip(t.id)}>{t.is_replay?<History size={16}/>:<Compass size={16}/>}<span>{t.title}<small>{t.is_replay?'Saved live run':dateLabel(t.state.criteria.departureDate??t.state.criteria.departureStart)}</small></span>{trip?.id===t.id&&<Check size={15}/>}</button>)}</div>}
    </header>
    {showTripPanel&&<div className="mobile-tabs" role="tablist" aria-label="Workspace view" onKeyDown={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?'chat':e.key==='End'?'trip':tab==='chat'?'trip':'chat';changeTab(next);document.getElementById(`${next}-view-tab`)?.focus();}}}><button id="chat-view-tab" role="tab" aria-controls="chat-panel" tabIndex={tab==='chat'?0:-1} aria-selected={tab==='chat'} onClick={()=>changeTab('chat')}><MessageCircle size={17}/>Chat</button><button id="trip-view-tab" role="tab" aria-controls="trip-panel" tabIndex={tab==='trip'?0:-1} aria-selected={tab==='trip'} onClick={()=>changeTab('trip')}><Compass size={17}/>Your trip{unseen&&<span className="update-dot" aria-label="New trip updates"/>}</button></div>}
    {error&&<div className="error-banner" role="alert"><span>{error}</span><IconButton label="Dismiss error" onClick={()=>setError('')}><X size={17}/></IconButton></div>}
    {readOnly&&<div className="replay-banner"><History size={16}/><span>{state.replay?`Saved live run · ${state.replayRecordedAt?new Date(state.replayRecordedAt).toLocaleString('en-GB'):''}. Prices are from that run.`:'Earlier shared-bot test · Read only'}</span><button onClick={()=>void newTrip()}>Start a fresh trip<ArrowUpRight size={15}/></button></div>}
    <main className={`workspace ${showTripPanel?'':'chat-only'}`}>
      <section id="chat-panel" role={showTripPanel?'tabpanel':undefined} aria-labelledby={showTripPanel?'chat-view-tab':undefined} className={`chat-panel panel ${tab==='chat'||!showTripPanel?'mobile-active':''}`} aria-label="Conversation">
        <div className="panel-header"><div><h1>{state.messages.length?'Your next trip':'Let’s get away.'}</h1><span className="privacy"><LockKeyhole size={11}/>Only you</span></div><div className="header-actions"><IconButton label="Start a new trip" onClick={()=>void newTrip()}><Plus size={19}/></IconButton><IconButton label="Edit traveller profile" onClick={()=>setModal('profile')}><SlidersHorizontal size={18}/></IconButton></div></div>
        <div id="conversation" tabIndex={-1} className={`conversation ${state.messages.length?'has-messages':''}`} ref={chatScroll} onScroll={()=>{const el=chatScroll.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<90;}}>
          {!state.messages.length?<div className="welcome"><span className="welcome-stamp"><Logo small/><span>Your next trip</span></span><h2>Where do you<br/>feel like going?</h2><p>A place, a budget, or a half-formed idea.<br/>Start with what you know.</p><div className="welcome-photos"><button className="welcome-main-photo" onClick={()=>void send('Help me plan a few days in Ljubljana with walks, good food and a cosy place to stay.')}><Photo src="/images/ljubljana.jpg" alt="Ljubljana’s riverside cafés and old town" eager/><span>Ljubljana, Slovenia<ArrowUpRight size={20}/></span></button><button className="welcome-side-photo" onClick={()=>void send('I’m thinking about Porto. Help me compare a few days there with other places in Europe.')}><Photo src="/images/porto.jpg" alt="The Dom Luís I bridge and waterfront in Porto" eager/><span>Porto, Portugal<ArrowUpRight size={18}/></span></button></div><button className="starter-prompt" disabled={!trip||sending} onClick={()=>void send(scenario)}><span className="mini-tile mint"><Footprints size={18}/></span><span>Good food and a few days away<small>Work out the dates, place and budget together</small></span><ArrowUpRight size={19}/></button></div>:<div className="message-list">{state.messages.map(m=><div className={`message ${m.role}`} key={m.id}>{m.role==='assistant'&&<Logo small/>}<div className="message-body"><div className="message-text">{m.text}</div>{m.pending&&<small className="sending-label" role="status">Saving…</small>}</div>{m.role==='user'&&<span className="message-avatar">S</span>}</div>)}
            {active.length>0&&<div className="inline-activities" aria-live="polite">{active.slice(0,3).map(action=><div className="inline-activity" key={action.id}><ActionToolIcon action={action}/><span><strong>{action.label}</strong><small>{action.provider} · {action.status==='queued'?'Queued · ':''}{elapsed(action.queuedAt??action.startedAt)}</small></span>{showTripPanel&&<button onClick={()=>changeTab('trip')} aria-label="View search activity"><ArrowUpRight size={15}/></button>}</div>)}{active.length>3&&<small>{active.length-3} more tasks in the trip panel</small>}</div>}
            {hasUserMessage&&state.messages.some(message=>message.role==='assistant')&&<TripEssentials state={state} disabled={readOnly} onSend={text=>command({kind:'message',text})}/>}
            {state.questions.filter(q=>!q.answer&&!q.skipped).slice(0,1).map(q=><QuestionCard key={q.id} question={q} disabled={readOnly} onAnswer={answer}/>)}
            {state.questions.filter(q=>q.answer||q.skipped).slice(-2).map(q=><div className="answered-question" key={q.id}><History size={14} aria-hidden="true"/><span>{q.skipped?'Earlier question skipped':<>Earlier answer: <strong>{q.answer}</strong></>}</span><small>{q.prompt}</small></div>)}
          </div>}
        </div>
        <div className="composer-area">
          {failed.length>0&&<div className="chat-task-error" role="status"><span>{failed.some(a=>a.kind==='conversation')?'A message needs attention.':`${failed.length} ${failed.length===1?'check needs':'checks need'} attention.`}</span><button type="button" onClick={()=>{changeTab('trip');requestAnimationFrame(()=>document.querySelector('.activity-row.error')?.scrollIntoView({block:'center'}));}}>View details<ArrowUpRight size={14}/></button></div>}
          {!online&&!readOnly&&<div className="connection-note"><span className="status-dot offline"/>{reconnecting?'Reconnecting to Grok. Started searches continue.':'Laptop worker is offline. Messages will wait here.'}</div>}
          <form className="composer" aria-busy={sending} onSubmit={e=>{e.preventDefault();void send();}}>
            {(visible.origin||visible.region)&&<div className="composer-context"><Compass size={13}/>{[visible.origin,visible.region].filter(Boolean).join(' to ')}{visible.nights&&<><span>·</span>{visible.nights} nights</>}</div>}
            <textarea ref={textarea} aria-label="Message Roamer" placeholder={readOnly?'This is a saved run. Start a fresh trip to chat.':'Five nights somewhere with good food…'} value={draft} disabled={readOnly} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}} rows={2}/>
            <div className="composer-toolbar"><div><IconButton label="Edit trip details" onClick={()=>setModal('criteria')} disabled={readOnly}><Plus size={21}/></IconButton><span className="grok-label"><span className={`status-dot ${online?'':'offline'}`}/>Grok<ChevronDown size={12}/></span></div><div><button type="button" className="voice-button" onClick={()=>setModal('voice')} aria-label="Voice in Grok"><AudioLines size={20}/><span>Voice in Grok</span></button><button type="submit" className="send-button" aria-label="Send message" disabled={sending||!trip||!draft.trim()||readOnly}>{sending?<LoaderCircle size={21} className="spin"/>:<ArrowUp size={22}/>}</button></div></div>
          </form><div className="composer-foot"><span>Your trip details are saved as you go.</span><span>↵ to send</span></div>
        </div>
      </section>
      {showTripPanel&&<section id="trip-panel" role="tabpanel" aria-labelledby="trip-view-tab" className={`trip-panel panel ${tab==='trip'?'mobile-active':''}`} aria-label="Your trip">
        <div className="panel-header"><div><span className="trip-heading-icon"><Compass size={18}/></span><h2>Your trip</h2></div><span className={`live-label ${online?'connected':''}`}><span className="status-dot"/>{readOnly?'Saved run':online?'Live updates':reconnecting?'Reconnecting':'Worker offline'}</span></div>
        <div className="trip-scroll">
          <Activity actions={state.actions} compact={state.candidates.length>0} onRetry={id=>void command({kind:'retry',actionId:id})} onCheck={()=>setModal('delivery')}/>
          {state.candidates.length>0&&<div className="candidate-list"><div className="section-heading"><h3>On the shortlist</h3><span>{state.candidates.length} {state.candidates.length===1?'place':'places'}</span></div>{state.candidates.map(c=><CandidateCard key={c.id} candidate={c} criteria={state.criteria} pricesConfirmed={canPriceSearch(state)} requirements={state.requirements??[]} checking={state.actions.some(a=>a.destination===c.name&&(a.status==='running'||a.status==='queued'))} replay={readOnly} onSave={()=>void command({kind:'save',candidateId:c.id,saved:!c.saved})} onReplace={()=>command({kind:'replace_stay',candidateId:c.id})}/>)}</div>}
          <TripCriteriaCard state={state} disabled={readOnly} onEdit={()=>setModal('criteria')}/>
          {!state.candidates.length&&<div className="interest-row">{[{Icon:interestIcon(interests[0]??''),label:interests[0]||'Add an interest',color:'mint'},{Icon:interestIcon(interests[1]??''),label:interests[1]||'What else you enjoy',color:'peach'},{Icon:House,label:visible.stayStyle||'Your kind of stay',color:'lilac'}].map(({Icon,label,color})=><button key={color} className={`interest-tile ${color}`} onClick={()=>setModal('criteria')} disabled={readOnly}><Icon size={26} strokeWidth={1.4}/><span>{label}</span></button>)}</div>}
          {visible.noCar&&<div className="no-car"><TrainFront size={15}/>Getting around without a car</div>}
          {pendingQuestion&&<div className="mobile-trip-question"><QuestionCard question={pendingQuestion} onAnswer={answer} disabled={readOnly} compact/></div>}
          {!!state.requirements?.length&&<details className="requirements-note"><summary>Your requirements · {state.requirements.length}<ChevronDown size={15}/></summary><p>Your original requests are kept here. Each option shows which details have been checked.</p><ul>{state.requirements.map(requirement=><li key={requirement.id}>{requirement.text}</li>)}</ul><button type="button" className="text-button" onClick={()=>setModal('requirements')} disabled={readOnly}>Edit requirements<Settings2 size={14}/></button></details>}
          {!state.candidates.length&&<div className="ideas"><div className="section-heading"><h3>A little inspiration</h3><span>No dates checked yet</span></div>{ideas.map((idea,i)=><button className="idea-card" key={idea.id} onClick={()=>void send(`Can you look at ${idea.name} for our trip? Check flights, a cosy stay and things to do.`)} disabled={sending||!trip||readOnly}><Photo src={idea.image} alt={`${idea.name}, ${idea.country}`} eager={i===0}/><div><small>{idea.country}</small><strong>{idea.name}</strong><span>{idea.hint}</span></div><span className="idea-arrow"><ArrowUpRight size={18}/></span></button>)}</div>}
          <button className="credits-link" onClick={()=>setModal('credits')}>Photography & sources<ArrowUpRight size={12}/></button>
        </div>
      </section>}
    </main>
    <DebugPanel tripId={trip?.id} api={api}/>
    {modal&&<Modal title={modal==='criteria'?'Your trip details':modal==='profile'?'The way you like to travel':modal==='voice'?'Keep talking in Grok':modal==='delivery'?'Check the message in Grok':modal==='requirements'?'Your trip requirements':'Photography & sources'} close={()=>setModal(null)}>
      {modal==='criteria'&&<CriteriaForm state={state} disabled={readOnly} onSave={async patch=>{if(await command({kind:'criteria',patch}))setModal(null);}}/>}
      {modal==='profile'&&<ProfileForm profile={state.profile} disabled={readOnly} onSave={async patch=>{if(await command({kind:'profile',patch}))setModal(null);}}/>}
      {modal==='requirements'&&<RequirementEditor requirements={state.requirements??[]} onSave={async(requirementId,text)=>{const saved=await command({kind:'requirement',requirementId,text});if(saved)setModal(null);return saved;}}/>}
      {modal==='voice'&&<div className="voice-instructions"><span className="voice-orb"><AudioLines size={32}/></span><p>Open <strong>{trip?.workspace_id==='personal'?'Roamer Personal':trip?.workspace_id?.startsWith('stress-')?`Roamer Test ${trip.workspace_id.slice(7).replace(/^./,c=>c.toUpperCase())}`:'Travel Agent'}</strong> in the Grok desktop app and start a voice call. Keep this page beside it.</p><p>The page updates when Grok posts a structured message. You can also answer questions by clicking here.</p><p className="note">Voice sync is awaiting a spoken test.</p><div className="note"><LockKeyhole size={17}/>Audio stays in the Grok app. This website doesn’t use your microphone.</div><button className="button primary" onClick={()=>setModal(null)}>Back to my trip</button></div>}
      {modal==='delivery'&&<div className="voice-instructions"><p>Open <strong>{trip?.workspace_id==='personal'?'Roamer Personal':trip?.workspace_id?.startsWith('stress-')?`Roamer Test ${trip.workspace_id.slice(7).replace(/^./,c=>c.toUpperCase())}`:'Travel Agent'}</strong> in the Grok desktop app and check whether your message arrived.</p><p>The connection ended before Roamer could confirm delivery. It may still be processing. A later reply will update this trip.</p><p>Check the conversation before sending the same request again.</p><button className="button primary" onClick={()=>setModal(null)}>Back to my trip</button></div>}
      {modal==='credits'&&<Credits candidates={state.candidates}/>}
    </Modal>}
  </div>;
}
function historyReplace(url:URL){window.history.replaceState({},'',url.pathname+url.search);}
function QuestionCard({question:q,onAnswer,disabled,compact=false}:{question:Question;onAnswer:(q:Question,a:string,skip?:boolean)=>Promise<void>;disabled:boolean;compact?:boolean}){
  const [other,setOther]=useState('');const [showOther,setShowOther]=useState(false);const [busy,setBusy]=useState(false);
  async function answer(value:string,skip=false){if(busy)return;setBusy(true);await onAnswer(q,value,skip);setBusy(false);}
  return <div className={`question-card ${compact?'compact':''}`}><div className="question-title"><span className="question-icon"><SlidersHorizontal size={17}/></span><h3>{q.prompt}</h3></div><div className="question-options">{q.options.map(option=><button key={option} disabled={disabled||busy} onClick={()=>void answer(option)}><span className="radio-circle"/>{option}<ArrowUpRight size={15}/></button>)}</div>{showOther&&<form className="other-answer" onSubmit={e=>{e.preventDefault();if(other.trim())void answer(other.trim());}}><input aria-label="Your answer" placeholder="Tell me what works…" value={other} onChange={e=>setOther(e.target.value)}/><button aria-label="Send your answer" disabled={!other.trim()||busy||disabled}><ArrowUp size={18}/></button></form>}<div className="question-footer"><button onClick={()=>setShowOther(!showOther)} disabled={disabled}>Something else</button><button onClick={()=>void answer('',true)} disabled={disabled||busy}>Skip for now</button></div></div>;
}
function ActionToolIcon({action}:{action:Action}){const Icon=action.kind==='conversation'?MessageCircle:action.kind==='discovery'?Search:action.kind==='flights'?Plane:action.kind==='stays'?House:Monitor;return <span className={`tool-provider-icon ${action.kind}`} aria-hidden="true"><Icon size={17}/>{action.status==='running'&&<LoaderCircle size={10} className="tool-running spin"/>}{action.status==='error'&&<X size={10} className="tool-failed"/>}</span>;}
function Activity({actions,onRetry,onCheck,compact=false}:{actions:Action[];onRetry:(id:string)=>void;onCheck:()=>void;compact?:boolean}){
  const current=actions.filter(a=>['running','queued','error'].includes(a.status));const done=actions.filter(a=>a.status==='done'||a.status==='superseded');
  if(!actions.length)return null;
  return <section className={`activity-section ${compact?'compact':''}`} aria-label="Live search activity"><div className="section-heading"><h3>{current.some(a=>a.status==='running')?'Happening now':'Search activity'}</h3>{current.some(a=>a.status==='running')&&<span className="working-pulse"/>}</div><div className="activity-list" aria-live="polite">{current.map(a=><div className={`activity-row ${a.status}`} key={a.id}><ActionToolIcon action={a}/><div><strong>{a.label}</strong><small>{a.status==='error'?a.detail:`${a.provider} · ${a.status==='queued'?`Queued · ${elapsed(a.queuedAt??a.startedAt)}`:elapsed(a.startedAt)}`}</small></div>{a.status==='error'&&<button className="retry-button" onClick={()=>a.retryable===false||(a.retryable===undefined&&a.kind==='conversation')?onCheck():onRetry(a.id)}>{a.retryable===false||(a.retryable===undefined&&a.kind==='conversation')?'Check Grok':'Retry'}</button>}</div>)}</div>{done.length>0&&<details className="activity-history"><summary><CheckCheck size={16}/>{done.filter(a=>a.status==='done').length} tasks completed<ChevronDown size={14}/></summary>{done.map(a=><div className="completed-row" key={a.id}>{a.status==='superseded'?<RefreshCw size={13}/>:<Check size={13}/>}<span>{a.label}<small>{a.detail??a.provider}</small></span>{a.status==='superseded'&&<small>Superseded</small>}</div>)}</details>}</section>;
}
function CandidateCard({candidate:c,criteria,requirements,pricesConfirmed,checking,replay,onSave,onReplace}:{candidate:Candidate;criteria:Criteria;requirements:TripRequirement[];pricesConfirmed:boolean;checking:boolean;replay:boolean;onSave:()=>void;onReplace:()=>Promise<boolean|undefined>}){
  const [replacing,setReplacing]=useState(false);
  const total=pricesConfirmed?candidateTotal(c,criteria):null;
  const flight=pricesConfirmed&&c.flight&&c.flight.scope==='return-flights'&&quoteMatches(c.flight,criteria)?c.flight:undefined;
  const stay=pricesConfirmed&&c.stay&&c.stay.scope==='whole-stay'&&quoteMatches(c.stay,criteria)?c.stay:undefined;
  const stale=pricesConfirmed&&!!((c.flight&&!flight)||(c.stay&&!stay));
  const priceLabel=total!==null?'Prices checked':c.status==='unavailable'?'No matching rates':checking?'Checking prices':'Prices incomplete';
  const pricePreview=(flight||stay)&&<div className="candidate-price-preview"><strong>{formatMoney(total??flight?.total??stay!.total)}</strong><small>{total!==null?'Flights + stay':flight?'Return flights':'Whole stay'} · {people(criteria.travellers)}</small></div>;
  return <article className="candidate-card"><div className="candidate-photo"><Photo src={c.image} alt={`${c.name}, ${c.country}`}/><span className={`candidate-status ${total!==null?'checked':''}`}>{total!==null?<Check size={12}/>:<Clock3 size={12}/>} {priceLabel}</span><IconButton label={`${c.saved?'Unsave':'Save'} ${c.name}`} onClick={onSave} className={c.saved?'saved':''} disabled={replay}><Bookmark size={18} fill={c.saved?'currentColor':'none'}/></IconButton><div className="photo-title"><small>{c.country}</small><h4>{c.name}</h4></div>{pricePreview}</div><div className="candidate-content"><p className="candidate-summary">{c.summary}</p>{c.highlights.length>0&&<div className="highlight-chips">{c.highlights.slice(0,3).map(h=><span key={h}><Leaf size={12}/>{h}</span>)}</div>}
    {stale&&<p className="quote-stale" role="status"><RefreshCw size={15} aria-hidden="true"/>Previous prices don’t match your current dates or travellers. New rates still need checking.</p>}
    <div className="quote-line"><span className="quote-icon lilac"><Plane size={17}/></span><div><strong>{flight?.label??'Return flights'}</strong><small>{flight?`${dateLabel(flight.departureDate)}–${dateLabel(flight.returnDate)} · ${people(flight.travellers)}`:checking?'Checking return fares':'Fare not checked'}</small></div>{flight?<a href={flight.url} target="_blank" rel="noreferrer" aria-label={`See flight to ${c.name}`}>{formatMoney(flight.total)}<ArrowUpRight size={14}/></a>:<span className="price-pending">—</span>}</div>
    <div className="quote-line stay-line">{stay?.image?<Photo src={stay.image} alt={stay.label} className="stay-thumb"/>:<span className="quote-icon mint"><House size={17}/></span>}<div><strong>{stay?.label??'A place to stay'}</strong><small>{stay?`${dateLabel(stay.departureDate)}–${dateLabel(stay.returnDate)} · ${people(stay.travellers)} · ${stay.includes}`:checking?'Checking rooms for your dates':'Stay not checked'}</small></div>{stay?<a href={stay.url} target="_blank" rel="noreferrer" aria-label={`See stay in ${c.name}`}>{formatMoney(stay.total)}<ArrowUpRight size={14}/></a>:<span className="price-pending">—</span>}</div>
    {criteria.noCar&&<div className={`transport-note ${c.transport?.verified?'verified':''}`}><TrainFront size={15}/><span>{c.transport?.summary??'Transport checks still needed.'}</span></div>}
    {total!==null&&<div className="cost-summary"><div><small>Flights + stay, for {criteria.travellers}</small><strong>{formatMoney(total)}</strong></div><span className={total>criteria.budget?'over-budget':''}>{total<=criteria.budget?`${formatMoney(criteria.budget-total)} left`:`${formatMoney(total-criteria.budget)} over budget`}<small>{total<=criteria.budget?'for food & getting around':'before food & transport'}</small></span></div>}
    <CandidateRequirements candidate={c} criteria={criteria} requirements={requirements}/>
    {stay&&<button type="button" className="replace-stay" onClick={async()=>{setReplacing(true);try{await onReplace();}finally{setReplacing(false);}}} disabled={replay||replacing}><RefreshCw size={13} className={replacing?'spin':''}/>{replacing?'Finding another stay…':'Change this stay'}</button>}
    <details className="source-details"><summary><CheckCheck size={13}/>{flight||stay?'Price details & sources':'Research sources'}<ChevronDown size={13}/></summary>{flight&&<p>Flight: {flight.includes}. Checked {relative(flight.checkedAt)}. {flight.provider}.</p>}{stay&&<p>Stay: {stay.includes}. Checked {relative(stay.checkedAt)}. {stay.provider}.</p>}<p>Food, local transport and optional extras are outside the flights + stay total. Rates can change before booking.</p>{[...c.sources,...(c.transport?.sources??[])].map((s,i)=><a key={s.url+i} href={s.url} target="_blank" rel="noreferrer">{s.title}<ExternalLink size={12}/></a>)}</details>
  </div></article>;
}
function Modal({title,close,children}:{title:string;close:()=>void;children:React.ReactNode}){
  const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{const opener=document.activeElement as HTMLElement|null;const dialog=ref.current;dialog?.showModal();return()=>{dialog?.close();opener?.focus();};},[]);
  return <dialog className="modal" aria-labelledby="modal-title" ref={ref} onCancel={e=>{e.preventDefault();close();}} onClick={e=>{if(e.target===ref.current)close();}}><div className="modal-header"><h2 id="modal-title">{title}</h2><IconButton label="Close dialog" onClick={close}><X size={19}/></IconButton></div>{children}</dialog>;
}
function ProfileForm({profile,disabled,onSave}:{profile:Profile;disabled:boolean;onSave:(p:Profile)=>Promise<void>}){
  const [p,set]=useState(profile);return <form className="edit-form" onSubmit={e=>{e.preventDefault();void onSave(p);}}><p>These preferences carry over to new trips. Only details you’ve told Roamer are saved.</p><label>Interests<input value={p.interests.join(', ')} onChange={e=>set({...p,interests:e.target.value.split(',').map(x=>x.trim()).filter(Boolean)})} placeholder="Hiking, good food…"/></label><label>Places you like to stay<input value={p.stayStyle} onChange={e=>set({...p,stayStyle:e.target.value})}/></label><label>Other preferences<textarea value={p.notes.join('\n')} onChange={e=>set({...p,notes:e.target.value.split('\n').filter(Boolean)})} rows={3}/></label><label className="checkbox-label"><input type="checkbox" checked={p.noCar===true} onChange={e=>set({...p,noCar:e.target.checked})}/>Prefer trips without a car</label><button className="button primary" disabled={disabled}>Save preferences<Check size={17}/></button></form>;
}
function Credits({candidates}:{candidates:Candidate[]}){const [credits,setCredits]=useState<{city:string;source:string;author:string;license:string;licenseUrl:string}[]>([]);useEffect(()=>{void fetch('/images/attribution.json').then(r=>r.json()).then(setCredits);},[]);return <div className="credits"><p>Destination photography is from Wikimedia Commons, resized and cropped for this interface. Hotel photos, when available, come from the linked property listing.</p>{[...credits,...candidates.filter(c=>c.imageCredit).map(c=>({city:c.name,...c.imageCredit!}))].filter((c,i,all)=>all.findIndex(other=>other.source===c.source)===i).map(c=><div key={c.source}><a href={c.source} target="_blank" rel="noreferrer">{c.city}<ArrowUpRight size={14}/></a><small>{c.author.replace(/<[^>]*>/g,'')}</small><a href={c.licenseUrl} target="_blank" rel="noreferrer">{c.license}</a></div>)}<p>Destination photos show the place, not a particular hotel. Each result links to the sources used to check it.</p></div>;}

