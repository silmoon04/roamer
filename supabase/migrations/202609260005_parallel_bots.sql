-- The legacy claim function remains available until the serial worker has drained.
create or replace function public.roamer_command_bot(p_kind text,p_payload jsonb)
returns text language sql immutable set search_path=public as $$
 select case
  when p_kind='conversation' then 'Travel Agent'
  when p_kind='browser' and p_payload->>'purpose'='transport' then 'Explore Bot'
  when p_kind='browser' and p_payload->>'purpose'='price' and p_payload->>'priceKind'='flights' then 'Flights Bot'
  when p_kind='browser' and p_payload->>'purpose'='price' and p_payload->>'priceKind'='stays' then 'Stays Bot'
  else null end;
$$;

create or replace function public.roamer_claim_parallel(p_owner uuid,p_busy_bots text[] default '{}',p_allow_research boolean default true)
returns setof public.roamer_commands language plpgsql security definer set search_path=public as $$
begin
 if p_owner is null then raise exception 'A worker owner is required'; end if;
 -- Protect the same account's screens even if two authorized claim clients race.
 perform pg_advisory_xact_lock(hashtextextended(p_owner::text,0));
 return query update public.roamer_commands set status='running',lease_until=now()+interval '90 seconds',updated_at=now(),attempts=attempts+1
 where id=(select q.id from public.roamer_commands q where q.owner_id=p_owner and q.status='queued'
   and ((q.kind='research' and p_allow_research and (select count(*) from public.roamer_commands r where r.owner_id=p_owner and r.kind='research' and r.status='running' and r.lease_until>now())<3)
     or (public.roamer_command_bot(q.kind,q.payload) is not null
       and not (public.roamer_command_bot(q.kind,q.payload)=any(coalesce(p_busy_bots,'{}'::text[])))
       and not exists(select 1 from public.roamer_commands running where running.owner_id=p_owner and running.status='running' and running.lease_until>now()
         and public.roamer_command_bot(running.kind,running.payload)=public.roamer_command_bot(q.kind,q.payload))))
   order by case when q.kind='conversation' then 0 else 1 end,q.created_at for update skip locked limit 1)
 returning *;
end $$;
revoke all on function public.roamer_command_bot(text,jsonb) from public,anon,authenticated;
revoke all on function public.roamer_claim_parallel(uuid,text[],boolean) from public,anon,authenticated;
grant execute on function public.roamer_command_bot(text,jsonb) to service_role;
grant execute on function public.roamer_claim_parallel(uuid,text[],boolean) to service_role;
