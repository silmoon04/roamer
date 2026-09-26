-- Registry rows are provisioned by the local setup script, never by browser clients.
create table if not exists public.roamer_workspaces (
 id text primary key check (id in ('legacy','personal','stress-careful','stress-slower','stress-friends')),
 owner_id uuid not null references auth.users(id), bot_id text, bot_name text not null,
 browser_bot_id text, profile jsonb not null default '{"interests":[],"noCar":null,"stayStyle":"","notes":[]}'::jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(id,owner_id)
);
alter table public.roamer_workspaces enable row level security;
drop policy if exists own_workspaces on public.roamer_workspaces;
create policy own_workspaces on public.roamer_workspaces for select to authenticated using(owner_id=(select auth.uid()));
revoke all on public.roamer_workspaces from public,anon,authenticated;
grant select on public.roamer_workspaces to authenticated;
grant all on public.roamer_workspaces to service_role;

-- Preserve existing jobs on their earlier bot. The API refuses new legacy work.
insert into public.roamer_workspaces(id,owner_id,bot_id,bot_name)
select 'legacy',owner_id,'eaef29aa-d867-415e-aa91-44e884de5f6c','Travel Agent'
from public.roamer_trips order by created_at limit 1 on conflict(id) do nothing;
alter table public.roamer_trips add column if not exists workspace_id text not null default 'legacy';
alter table public.roamer_trips add column if not exists bot_id text;
alter table public.roamer_trips add column if not exists browser_bot_id text;
update public.roamer_trips t set bot_id=w.bot_id,browser_bot_id=w.browser_bot_id
from public.roamer_workspaces w where t.workspace_id=w.id and t.owner_id=w.owner_id and t.bot_id is null;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='roamer_trips_workspace_owner_fkey') then
  alter table public.roamer_trips add constraint roamer_trips_workspace_owner_fkey foreign key(workspace_id,owner_id) references public.roamer_workspaces(id,owner_id);
 end if;
end $$;
create index if not exists roamer_trips_workspace_history on public.roamer_trips(owner_id,workspace_id,created_at desc);

create or replace function public.roamer_bind_workspace()
returns trigger language plpgsql security definer set search_path=public as $$
declare w public.roamer_workspaces;
begin
 if tg_op='UPDATE' then
  if new.workspace_id is distinct from old.workspace_id or new.owner_id is distinct from old.owner_id or new.bot_id is distinct from old.bot_id or new.browser_bot_id is distinct from old.browser_bot_id then
   raise exception 'Trip workspace and bot bindings are immutable';
  end if;
  return new;
 end if;
 select * into w from public.roamer_workspaces where id=new.workspace_id and owner_id=new.owner_id;
 if not found or w.bot_id is null then raise exception 'Workspace is not configured'; end if;
 new.bot_id=w.bot_id;new.browser_bot_id=w.browser_bot_id;
 return new;
end $$;
drop trigger if exists roamer_trip_workspace_binding on public.roamer_trips;
create trigger roamer_trip_workspace_binding before insert or update of workspace_id,owner_id,bot_id,browser_bot_id on public.roamer_trips for each row execute function public.roamer_bind_workspace();
revoke all on function public.roamer_bind_workspace() from public,anon,authenticated;

create or replace function public.roamer_commit(p_trip uuid,p_expected_version bigint,p_state jsonb,p_events jsonb,p_command jsonb default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare t public.roamer_trips;item jsonb;inserted integer:=0;n integer;
begin
 select * into t from public.roamer_trips where id=p_trip for update;
 if not found or t.version<>p_expected_version then return false;end if;
 if jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events)=0 then raise exception 'Empty event batch';end if;
 for item in select * from jsonb_array_elements(p_events) loop
  if (item->>'tripId')::uuid<>p_trip then raise exception 'Event belongs to another trip';end if;
  insert into public.roamer_events(id,trip_id,owner_id,revision,type,payload,occurred_at)
  values((item->>'id')::uuid,p_trip,t.owner_id,(item->>'revision')::int,item->>'type',item->'payload',(item->>'occurredAt')::timestamptz)
  on conflict(id) do nothing;
  get diagnostics n=row_count;inserted:=inserted+n;
 end loop;
 if inserted<>jsonb_array_length(p_events) then raise exception 'Duplicate event batch';end if;
 if p_command is not null then
  insert into public.roamer_commands(id,trip_id,owner_id,revision,kind,payload)
  values((p_command->>'id')::uuid,p_trip,t.owner_id,(p_state->>'revision')::int,p_command->>'kind',p_command->'payload');
 end if;
 update public.roamer_trips set state=p_state,version=version+inserted,updated_at=now() where id=p_trip;
 if exists(select 1 from jsonb_array_elements(p_events) e where e->>'type'='profile_patch') then
  if t.workspace_id='legacy' then
   insert into public.roamer_profiles(owner_id,data) values(t.owner_id,p_state->'profile') on conflict(owner_id) do update set data=excluded.data,updated_at=now();
  else
   update public.roamer_workspaces set profile=p_state->'profile',updated_at=now() where id=t.workspace_id and owner_id=t.owner_id;
   if not found then raise exception 'Workspace profile not found';end if;
  end if;
 end if;
 return true;
end $$;
revoke all on function public.roamer_commit(uuid,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.roamer_commit(uuid,bigint,jsonb,jsonb,jsonb) to service_role;

-- Bind the lease to the trip's immutable bot UUID, never to user-supplied command text.
create or replace function public.roamer_claim_parallel(p_owner uuid,p_busy_bots text[] default '{}',p_allow_research boolean default true)
returns setof public.roamer_commands language plpgsql security definer set search_path=public as $$
begin
 if p_owner is null then raise exception 'A worker owner is required';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 return query update public.roamer_commands set status='running',lease_until=now()+interval '90 seconds',updated_at=now(),attempts=attempts+1
 where id=(select q.id from public.roamer_commands q
  join public.roamer_trips t on t.id=q.trip_id and t.owner_id=q.owner_id
  join public.roamer_workspaces w on w.id=t.workspace_id and w.owner_id=t.owner_id
  where q.owner_id=p_owner and q.status='queued' and t.bot_id=w.bot_id
   and (q.kind='research' and p_allow_research and (select count(*) from public.roamer_commands r where r.owner_id=p_owner and r.kind='research' and r.status='running' and r.lease_until>now())<3
    or q.kind in ('conversation','browser')
     and (case when q.kind='browser' then coalesce(t.browser_bot_id,t.bot_id) else t.bot_id end)=(case when q.kind='browser' then coalesce(w.browser_bot_id,w.bot_id) else w.bot_id end)
     and not ((case when q.kind='browser' then coalesce(t.browser_bot_id,t.bot_id) else t.bot_id end)=any(coalesce(p_busy_bots,'{}'::text[])))
     and not exists(select 1 from public.roamer_commands r join public.roamer_trips rt on rt.id=r.trip_id
       where r.owner_id=p_owner and r.status='running' and r.kind in ('conversation','browser') and r.lease_until>now()
        and (case when r.kind='browser' then coalesce(rt.browser_bot_id,rt.bot_id) else rt.bot_id end)=(case when q.kind='browser' then coalesce(t.browser_bot_id,t.bot_id) else t.bot_id end)))
  order by case when t.workspace_id='personal' then 0 else 1 end,case when q.kind='conversation' then 0 else 1 end,q.created_at
  for update of q skip locked limit 1)
 returning *;
end $$;
revoke all on function public.roamer_claim_parallel(uuid,text[],boolean) from public,anon,authenticated;
grant execute on function public.roamer_claim_parallel(uuid,text[],boolean) to service_role;
