-- The accepted UI event and its work item must survive or roll back together.
drop function if exists public.roamer_commit(uuid,bigint,jsonb,jsonb);
create or replace function public.roamer_commit(p_trip uuid, p_expected_version bigint, p_state jsonb, p_events jsonb, p_command jsonb default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare t public.roamer_trips; item jsonb; inserted integer := 0; n integer;
begin
  select * into t from public.roamer_trips where id=p_trip for update;
  if not found or t.version<>p_expected_version then return false; end if;
  if jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events)=0 then raise exception 'Empty event batch'; end if;
  for item in select * from jsonb_array_elements(p_events) loop
    if (item->>'tripId')::uuid<>p_trip then raise exception 'Event belongs to another trip'; end if;
    insert into public.roamer_events(id,trip_id,owner_id,revision,type,payload,occurred_at)
    values ((item->>'id')::uuid,p_trip,t.owner_id,(item->>'revision')::int,item->>'type',item->'payload',(item->>'occurredAt')::timestamptz)
    on conflict (id) do nothing;
    get diagnostics n = row_count; inserted := inserted+n;
  end loop;
  if inserted<>jsonb_array_length(p_events) then raise exception 'Duplicate event batch'; end if;
  if p_command is not null then
    insert into public.roamer_commands(id,trip_id,owner_id,revision,kind,payload)
    values ((p_command->>'id')::uuid,p_trip,t.owner_id,(p_state->>'revision')::int,p_command->>'kind',p_command->'payload');
  end if;
  update public.roamer_trips set state=p_state, version=version+inserted, updated_at=now() where id=p_trip;
  -- Ordinary conversation/search updates must not overwrite preferences saved by another trip.
  if exists(select 1 from jsonb_array_elements(p_events) e where e->>'type'='profile_patch') then
    insert into public.roamer_profiles(owner_id,data) values(t.owner_id,p_state->'profile')
      on conflict(owner_id) do update set data=excluded.data,updated_at=now();
  end if;
  return true;
end $$;
revoke all on function public.roamer_commit(uuid,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.roamer_commit(uuid,bigint,jsonb,jsonb,jsonb) to service_role;

create table if not exists public.roamer_login_limits (
  bucket text primary key, window_start timestamptz not null, attempts integer not null default 0
);
alter table public.roamer_login_limits enable row level security;
revoke all on public.roamer_login_limits from public,anon,authenticated;
create or replace function public.roamer_login_attempt(p_bucket text)
returns boolean language plpgsql security definer set search_path=public as $$
declare n integer; global_n integer;
begin
  delete from public.roamer_login_limits where window_start<now()-interval '1 day';
  insert into public.roamer_login_limits(bucket,window_start,attempts) values('global',now(),1)
    on conflict(bucket) do update set
      attempts=case when roamer_login_limits.window_start<now()-interval '10 minutes' then 1 else roamer_login_limits.attempts+1 end,
      window_start=case when roamer_login_limits.window_start<now()-interval '10 minutes' then now() else roamer_login_limits.window_start end
    returning attempts into global_n;
  insert into public.roamer_login_limits(bucket,window_start,attempts) values(p_bucket,now(),1)
    on conflict(bucket) do update set
      attempts=case when roamer_login_limits.window_start<now()-interval '10 minutes' then 1 else roamer_login_limits.attempts+1 end,
      window_start=case when roamer_login_limits.window_start<now()-interval '10 minutes' then now() else roamer_login_limits.window_start end
    returning attempts into n;
  return n<=20 and global_n<=100;
end $$;
revoke all on function public.roamer_login_attempt(text) from public,anon,authenticated;
grant execute on function public.roamer_login_attempt(text) to service_role;
