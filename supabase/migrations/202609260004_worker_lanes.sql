drop function if exists public.roamer_claim(boolean);
create or replace function public.roamer_claim(p_allow_conversation boolean default true,p_allow_research boolean default true,p_owner uuid default null)
returns setof public.roamer_commands language plpgsql security definer set search_path=public as $$
begin
 return query update public.roamer_commands set status='running', lease_until=now()+interval '90 seconds', updated_at=now(), attempts=attempts+1
 where id=(select id from public.roamer_commands where status='queued'
   and (p_owner is null or owner_id=p_owner)
   and ((p_allow_conversation and kind in ('conversation','browser')) or (p_allow_research and kind not in ('conversation','browser')))
   order by case when kind='conversation' then 0 else 1 end,created_at for update skip locked limit 1)
 returning *;
end $$;
revoke all on function public.roamer_claim(boolean,boolean,uuid) from public,anon,authenticated;
grant execute on function public.roamer_claim(boolean,boolean,uuid) to service_role;
