begin;
do $$
declare personal public.roamer_workspaces; tester public.roamer_workspaces;
 fixture public.roamer_trips; next_state jsonb; accepted boolean;
begin
 select * into strict personal from public.roamer_workspaces where id='personal';
 select * into strict tester from public.roamer_workspaces where id='stress-careful' and owner_id=personal.owner_id;
 insert into public.roamer_trips(owner_id,workspace_id,state,title)
 select tester.owner_id,tester.id,state,'Transactional profile isolation fixture'
 from public.roamer_trips where workspace_id='personal' and owner_id=personal.owner_id order by created_at desc limit 1 returning * into strict fixture;
 next_state=jsonb_set(fixture.state,'{profile}',jsonb_build_object('interests',jsonb_build_array('fixture preference'),'noCar',true,'stayStyle','Fixture quiet room','notes',jsonb_build_array('Transactional test only')));
 select public.roamer_commit(fixture.id,fixture.version,next_state,jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'tripId',fixture.id,'revision',(next_state->>'revision')::int,'type','profile_patch','payload',next_state->'profile','occurredAt',now()))) into accepted;
 if not accepted then raise exception 'Profile fixture commit was rejected';end if;
 if (select profile from public.roamer_workspaces where id='stress-careful') is distinct from next_state->'profile' then raise exception 'Tester profile was not saved in its own workspace';end if;
 if (select profile from public.roamer_workspaces where id='personal') is distinct from personal.profile then raise exception 'Tester preference leaked into personal workspace';end if;
 if exists(select 1 from public.roamer_commands where trip_id=fixture.id) then raise exception 'Profile-only check unexpectedly queued a command';end if;
end $$;
select true as workspace_profile_isolation_passed,true as no_grok_tasks_queued;
rollback;
