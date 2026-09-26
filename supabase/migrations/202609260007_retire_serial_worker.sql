-- Retire the serial scheduler so an older laptop process cannot claim isolated work.
create or replace function public.roamer_claim(p_allow_conversation boolean default true,p_allow_research boolean default true,p_owner uuid default null)
returns setof public.roamer_commands language sql security definer set search_path=public as $$
 select * from public.roamer_commands where false;
$$;
revoke all on function public.roamer_claim(boolean,boolean,uuid) from public,anon,authenticated;
grant execute on function public.roamer_claim(boolean,boolean,uuid) to service_role;
