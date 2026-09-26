-- The previous worker may finish its active job; v2 must not claim any earlier shared-bot work.
create or replace function public.roamer_claim_parallel(p_owner uuid,p_busy_bots text[] default '{}',p_allow_research boolean default true)
returns setof public.roamer_commands language plpgsql security definer set search_path=public as $$
begin
 if p_owner is null then raise exception 'A worker owner is required';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 return query update public.roamer_commands set status='running',lease_until=now()+interval '90 seconds',updated_at=now(),attempts=attempts+1
 where id=(select q.id from public.roamer_commands q
  join public.roamer_trips t on t.id=q.trip_id and t.owner_id=q.owner_id
  join public.roamer_workspaces w on w.id=t.workspace_id and w.owner_id=t.owner_id
  where q.owner_id=p_owner and q.status='queued' and t.workspace_id<>'legacy' and t.bot_id=w.bot_id
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

