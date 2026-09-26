create table if not exists public.roamer_profiles (
  owner_id uuid primary key references auth.users(id),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists public.roamer_trips (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id),
  title text not null default 'A little further afield', state jsonb not null,
  version bigint not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  is_replay boolean not null default false, archived boolean not null default false
);
create table if not exists public.roamer_events (
  id uuid primary key, seq bigint generated always as identity,
  trip_id uuid not null references public.roamer_trips(id) on delete cascade,
  owner_id uuid not null references auth.users(id), revision integer not null,
  type text not null, payload jsonb not null, occurred_at timestamptz not null, created_at timestamptz not null default now()
);
create index if not exists roamer_events_trip_seq on public.roamer_events(trip_id,seq);
create table if not exists public.roamer_commands (
  id uuid primary key default gen_random_uuid(), trip_id uuid not null references public.roamer_trips(id) on delete cascade,
  owner_id uuid not null references auth.users(id), revision integer not null, kind text not null, payload jsonb not null,
  status text not null default 'queued' check (status in ('queued','running','done','error','superseded')),
  lease_until timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  error text, delivery text, attempts integer not null default 0
);
create index if not exists roamer_commands_queue on public.roamer_commands(status,created_at);
create table if not exists public.roamer_workers (
  id text primary key, owner_id uuid not null references auth.users(id), heartbeat timestamptz not null default now(),
  status text not null default 'online', detail text, cursor text
);
alter table public.roamer_profiles enable row level security;
alter table public.roamer_trips enable row level security;
alter table public.roamer_events enable row level security;
alter table public.roamer_commands enable row level security;
alter table public.roamer_workers enable row level security;
create policy own_profile on public.roamer_profiles for select to authenticated using (owner_id = (select auth.uid()));
create policy own_trips on public.roamer_trips for select to authenticated using (owner_id = (select auth.uid()));
create policy own_events on public.roamer_events for select to authenticated using (owner_id = (select auth.uid()));
create policy own_commands on public.roamer_commands for select to authenticated using (owner_id = (select auth.uid()));
create policy own_worker on public.roamer_workers for select to authenticated using (owner_id = (select auth.uid()));
grant select on public.roamer_profiles, public.roamer_trips, public.roamer_events, public.roamer_commands, public.roamer_workers to authenticated;
revoke all on public.roamer_profiles, public.roamer_trips, public.roamer_events, public.roamer_commands, public.roamer_workers from anon;

create or replace function public.roamer_commit(p_trip uuid, p_expected_version bigint, p_state jsonb, p_events jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare t public.roamer_trips; item jsonb; inserted integer := 0; n integer;
begin
  select * into t from public.roamer_trips where id=p_trip for update;
  if not found or t.version<>p_expected_version then return false; end if;
  for item in select * from jsonb_array_elements(p_events) loop
    insert into public.roamer_events(id,trip_id,owner_id,revision,type,payload,occurred_at)
    values ((item->>'id')::uuid,p_trip,t.owner_id,(item->>'revision')::int,item->>'type',item->'payload',(item->>'occurredAt')::timestamptz)
    on conflict (id) do nothing;
    get diagnostics n = row_count; inserted := inserted+n;
  end loop;
  if inserted<>jsonb_array_length(p_events) then raise exception 'Duplicate event batch'; end if;
  update public.roamer_trips set state=p_state, version=version+inserted, updated_at=now() where id=p_trip;
  insert into public.roamer_profiles(owner_id,data) values(t.owner_id,p_state->'profile')
    on conflict(owner_id) do update set data=excluded.data,updated_at=now();
  return true;
end $$;
revoke all on function public.roamer_commit(uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.roamer_commit(uuid,bigint,jsonb,jsonb) to service_role;

create or replace function public.roamer_claim()
returns setof public.roamer_commands language plpgsql security definer set search_path=public as $$
begin
 return query update public.roamer_commands set status='running', lease_until=now()+interval '90 seconds', updated_at=now(), attempts=attempts+1
 where id=(select id from public.roamer_commands where status='queued' order by case when kind='conversation' then 0 else 1 end,created_at for update skip locked limit 1)
 returning *;
end $$;
revoke all on function public.roamer_claim() from public,anon,authenticated;
grant execute on function public.roamer_claim() to service_role;

alter publication supabase_realtime add table public.roamer_trips, public.roamer_events, public.roamer_workers;
