-- Keep submitted URLs stable without changing any existing trip's bot binding.
create table if not exists public.roamer_trip_links (
 source_trip_id uuid primary key references public.roamer_trips(id),
 target_trip_id uuid not null references public.roamer_trips(id),
 owner_id uuid not null references auth.users(id), created_at timestamptz not null default now(),
 check(source_trip_id<>target_trip_id)
);
alter table public.roamer_trip_links enable row level security;
drop policy if exists own_trip_links on public.roamer_trip_links;
create policy own_trip_links on public.roamer_trip_links for select to authenticated using(owner_id=(select auth.uid()));
revoke all on public.roamer_trip_links from public,anon,authenticated;
grant select on public.roamer_trip_links to authenticated;
grant all on public.roamer_trip_links to service_role;

-- Recovery snapshots are service-only. Original trips, events and receipts remain in place.
create table if not exists public.roamer_workspace_resets (
 id uuid primary key, owner_id uuid not null references auth.users(id),
 source_trip_id uuid not null references public.roamer_trips(id),
 new_trip_id uuid not null references public.roamer_trips(id),
 before_state jsonb not null, created_at timestamptz not null default now()
);
alter table public.roamer_workspace_resets enable row level security;
revoke all on public.roamer_workspace_resets from public,anon,authenticated;
grant all on public.roamer_workspace_resets to service_role;

create or replace function public.roamer_reset_personal(
 p_reset uuid,p_owner uuid,p_source uuid,p_new_trip uuid,p_expected_bot text,
 p_bot text,p_bot_name text,p_browser_bot text,p_initial_state jsonb
) returns uuid language plpgsql security definer set search_path=public as $$
declare w public.roamer_workspaces; existing public.roamer_workspace_resets; snapshot jsonb;
begin
 if p_owner is null then raise exception 'A workspace owner is required';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 select * into existing from public.roamer_workspace_resets where id=p_reset;
 if found then
  if existing.owner_id<>p_owner or existing.source_trip_id<>p_source then raise exception 'Reset request belongs to another workspace';end if;
  return existing.new_trip_id;
 end if;
 -- Match roamer_commit's trip-before-workspace lock order.
 perform 1 from public.roamer_trips where owner_id=p_owner and workspace_id='personal' for update;
 select * into w from public.roamer_workspaces where id='personal' and owner_id=p_owner for update;
 if not found or w.bot_id is distinct from p_expected_bot then raise exception 'Personal bot changed; review the reset before retrying';end if;
 if not exists(select 1 from public.roamer_trips where id=p_source and owner_id=p_owner and workspace_id='personal') then raise exception 'Submitted trip does not belong to the personal workspace';end if;
 if p_new_trip=p_source or p_bot is null or p_browser_bot is null or p_bot=p_browser_bot or p_bot=w.bot_id or p_browser_bot=coalesce(w.browser_bot_id,w.bot_id) then raise exception 'A fresh trip and two fresh bots are required';end if;
 if exists(select 1 from public.roamer_trips where bot_id in(p_bot,p_browser_bot) or browser_bot_id in(p_bot,p_browser_bot)) then raise exception 'Fresh bots must not have existing trip context';end if;
 if p_initial_state->'profile' is distinct from '{"interests":[],"noCar":null,"stayStyle":"","notes":[]}'::jsonb
  or p_initial_state->'confirmedCriteria' is distinct from '[]'::jsonb
  or p_initial_state->'messages' is distinct from '[]'::jsonb or p_initial_state->'candidates' is distinct from '[]'::jsonb
  or p_initial_state->'questions' is distinct from '[]'::jsonb or p_initial_state->'actions' is distinct from '[]'::jsonb
  or p_initial_state->'requirements' is distinct from '[]'::jsonb or p_initial_state->>'revision' is distinct from '0'
  or p_initial_state->>'phase' is distinct from 'gathering' then raise exception 'Reset state must contain no prior trip details';end if;
 snapshot=jsonb_build_object('workspace',to_jsonb(w),
  'trips',coalesce((select jsonb_agg(to_jsonb(t)) from public.roamer_trips t where owner_id=p_owner and workspace_id='personal'),'[]'::jsonb),
  'commands',coalesce((select jsonb_agg(to_jsonb(c)) from public.roamer_commands c join public.roamer_trips t on t.id=c.trip_id where t.owner_id=p_owner and t.workspace_id='personal' and c.status in('queued','running')),'[]'::jsonb),
  'links',coalesce((select jsonb_agg(to_jsonb(l)) from public.roamer_trip_links l where owner_id=p_owner),'[]'::jsonb));
 update public.roamer_trips set archived=true where owner_id=p_owner and workspace_id='personal';
 update public.roamer_commands c set status='superseded',lease_until=null,updated_at=now(),error='Archived at the user''s request. A fresh personal trip was created.'
  from public.roamer_trips t where t.id=c.trip_id and t.owner_id=p_owner and t.workspace_id='personal' and c.status in('queued','running');
 update public.roamer_workspaces set bot_id=p_bot,bot_name=p_bot_name,browser_bot_id=p_browser_bot,
  profile=p_initial_state->'profile',updated_at=now() where id='personal' and owner_id=p_owner;
 insert into public.roamer_trips(id,owner_id,workspace_id,title,state) values(p_new_trip,p_owner,'personal','New trip',p_initial_state);
 -- Collapse prior personal links to one current target, never a redirect chain.
 update public.roamer_trip_links l set target_trip_id=p_new_trip where l.owner_id=p_owner and exists(select 1 from public.roamer_trips t where t.id=l.source_trip_id and t.workspace_id='personal' and t.owner_id=p_owner);
 insert into public.roamer_trip_links(source_trip_id,target_trip_id,owner_id) values(p_source,p_new_trip,p_owner)
  on conflict(source_trip_id) do update set target_trip_id=excluded.target_trip_id where roamer_trip_links.owner_id=excluded.owner_id;
 insert into public.roamer_workspace_resets(id,owner_id,source_trip_id,new_trip_id,before_state) values(p_reset,p_owner,p_source,p_new_trip,snapshot);
 return p_new_trip;
end $$;
revoke all on function public.roamer_reset_personal(uuid,uuid,uuid,uuid,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.roamer_reset_personal(uuid,uuid,uuid,uuid,text,text,text,text,jsonb) to service_role;

-- Reject late receipts and stale web mutations before they can update the current profile.
create or replace function public.roamer_protect_archived_state()
returns trigger language plpgsql set search_path=public as $$
begin
 if old.archived and (new.state is distinct from old.state or new.version is distinct from old.version) then
  raise exception 'Archived trips are read-only';
 end if;
 return new;
end $$;
drop trigger if exists roamer_archived_state on public.roamer_trips;
create trigger roamer_archived_state before update of state,version on public.roamer_trips for each row execute function public.roamer_protect_archived_state();
revoke all on function public.roamer_protect_archived_state() from public,anon,authenticated;
