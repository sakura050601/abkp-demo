-- Run in Supabase SQL Editor. Safe to rerun; app accounts do not use Supabase Auth.
create table if not exists public.app_users(
 id uuid primary key default gen_random_uuid(),
 nickname text not null,
 email text not null unique,
 password_hash text,
 created_at timestamptz not null default now()
);
create table if not exists public.projects(
 id uuid primary key default gen_random_uuid(),
 name text not null,
 is_default boolean not null default false
);
alter table public.projects add column if not exists is_default boolean not null default false;
create table if not exists public.project_states(
 project_id uuid primary key references public.projects(id) on delete cascade,
 revision bigint not null default 0,
 payload jsonb not null default '{"raw":[],"cards":[],"cores":[],"events":[]}'::jsonb
);
create table if not exists public.memberships(
 project_id uuid references public.projects(id) on delete cascade,
 user_id uuid references public.app_users(id) on delete cascade,
 display_name text not null,
 role text not null check(role in ('designer','senior','viewer')),
 created_at timestamptz not null default now(),
 primary key(project_id,user_id)
);
alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships add constraint memberships_role_check check(role in ('designer','senior','viewer','it'));

-- Preserve old membership IDs without consulting auth.users.
alter table public.memberships drop constraint if exists memberships_user_id_fkey;
insert into public.app_users(id,nickname,email,password_hash)
select distinct m.user_id,m.display_name,'legacy-'||m.user_id::text||'@invalid.local',null
from public.memberships m
left join public.app_users u on u.id=m.user_id
where u.id is null
on conflict(id) do nothing;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.memberships'::regclass and conname='memberships_app_users_user_id_fkey') then
  alter table public.memberships add constraint memberships_app_users_user_id_fkey foreign key(user_id) references public.app_users(id) on delete cascade;
 end if;
end $$;

update public.projects
set is_default=true
where id=(select id from public.projects order by id limit 1)
and not exists(select 1 from public.projects where is_default);
create unique index if not exists projects_one_default on public.projects(is_default) where is_default;

alter table public.app_users enable row level security;
alter table public.projects enable row level security;
alter table public.memberships enable row level security;
alter table public.project_states enable row level security;
drop policy if exists own_membership on public.memberships;
drop policy if exists member_projects on public.projects;
drop policy if exists member_state on public.project_states;
revoke all on public.app_users,public.projects,public.memberships,public.project_states from anon,authenticated;
grant all on public.app_users,public.projects,public.memberships,public.project_states to service_role;

alter table public.app_users add column if not exists auth_version integer not null default 0;
create table if not exists public.auth_passkeys(
 id text primary key,
 user_id uuid not null references public.app_users(id) on delete cascade,
 public_key text not null,
 counter bigint not null default 0 check(counter >= 0),
 transports text[] not null default '{}',
 name text not null,
 created_at timestamptz not null default now()
);
create index if not exists auth_passkeys_user on public.auth_passkeys(user_id);
create table if not exists public.auth_sessions(
 token_hash text primary key,
 csrf_token text not null,
 user_id uuid references public.app_users(id) on delete cascade,
 project_id uuid references public.projects(id) on delete cascade,
 auth_version integer,
 authenticated_at timestamptz,
 expires_at timestamptz not null
);
create index if not exists auth_sessions_user on public.auth_sessions(user_id);
create index if not exists auth_sessions_expiry on public.auth_sessions(expires_at);
create table if not exists public.auth_grants(
 token_hash text primary key,
 user_id uuid not null references public.app_users(id) on delete cascade,
 project_id uuid not null references public.projects(id) on delete cascade,
 purpose text not null check(purpose in ('enroll','recover')),
 expires_at timestamptz not null
);
alter table public.auth_grants add column if not exists session_hash text;
create table if not exists public.auth_challenges(
 id uuid primary key default gen_random_uuid(),
 session_hash text not null references public.auth_sessions(token_hash) on delete cascade,
 challenge text not null,
 kind text not null check(kind in ('login','enroll','add')),
 user_id uuid references public.app_users(id) on delete cascade,
 auth_version integer,
 grant_hash text,
 name text,
 expires_at timestamptz not null
);
create index if not exists auth_challenges_session on public.auth_challenges(session_hash);
create table if not exists public.auth_audit(
 id uuid primary key default gen_random_uuid(),
 user_id uuid references public.app_users(id) on delete set null,
 action text not null,
 verified_by text,
 created_at timestamptz not null default now()
);

alter table public.auth_passkeys enable row level security;
alter table public.auth_sessions enable row level security;
alter table public.auth_grants enable row level security;
alter table public.auth_challenges enable row level security;
alter table public.auth_audit enable row level security;
revoke all on public.auth_passkeys,public.auth_sessions,public.auth_grants,public.auth_challenges,public.auth_audit from anon,authenticated;
grant all on public.auth_passkeys,public.auth_sessions,public.auth_grants,public.auth_challenges,public.auth_audit to service_role;

create or replace function public.auth_issue_grant(
 p_email text, p_nickname text, p_project_id uuid, p_role text,
 p_purpose text, p_token_hash text, p_verified_by text
) returns uuid language plpgsql set search_path = public, pg_temp as $$
declare account public.app_users; target_project uuid;
begin
 if coalesce(lower(trim(p_email)), '') !~ '^[^[:space:]@]+@abist[.]co[.]jp$' then
  raise exception 'Only @abist.co.jp company email addresses are allowed';
 end if;
 if p_purpose not in ('enroll','recover') or length(trim(p_verified_by)) < 3 then
  raise exception 'Identity verification is required';
 end if;
 target_project := p_project_id;
 if target_project is null then select id into target_project from public.projects where is_default; end if;
 if target_project is null then raise exception 'Project is required'; end if;
 select * into account from public.app_users where email=lower(trim(p_email)) for update;
 if account.id is null then
  if p_purpose='recover' then raise exception 'Account does not exist'; end if;
  insert into public.app_users(email,nickname) values(lower(trim(p_email)),p_nickname) returning * into account;
 end if;
 if p_purpose='recover' then
  if not exists(select 1 from public.memberships where user_id=account.id and project_id=target_project) then
   raise exception 'Membership is required';
  end if;
  update public.app_users set auth_version=auth_version+1, password_hash=null where id=account.id;
  delete from public.auth_passkeys where user_id=account.id;
  delete from public.auth_sessions where user_id=account.id;
  delete from public.auth_challenges where user_id=account.id;
 else
  if exists(select 1 from public.auth_passkeys where user_id=account.id) then raise exception 'Use recovery for enrolled accounts'; end if;
  insert into public.memberships(project_id,user_id,display_name,role)
  values(target_project,account.id,account.nickname,p_role) on conflict(project_id,user_id) do nothing;
 end if;
 delete from public.auth_grants where user_id=account.id;
 insert into public.auth_grants(token_hash,user_id,project_id,purpose,expires_at)
 values(p_token_hash,account.id,target_project,p_purpose,now()+interval '30 minutes');
 insert into public.auth_audit(user_id,action,verified_by) values(account.id,p_purpose||'_issued',p_verified_by);
 return account.id;
end $$;

create or replace function public.auth_complete(
 p_context jsonb, p_credential jsonb, p_new_token_hash text, p_csrf_token text
) returns void language plpgsql set search_path = public, pg_temp as $$
declare account public.app_users; browser_session public.auth_sessions; invitation public.auth_grants;
 target_project uuid; affected integer; ceremony text := p_context->>'kind';
begin
 select * into account from public.app_users where id=(p_context->>'user_id')::uuid for update;
 if account.id is null or account.auth_version<>(p_context->>'auth_version')::integer then raise exception 'Account changed'; end if;
 select * into browser_session from public.auth_sessions where token_hash=p_context->>'session_hash' and expires_at>now() for update;
 if browser_session.token_hash is null then raise exception 'Session expired'; end if;
 if ceremony='login' then
  update public.auth_passkeys set counter=(p_credential->>'counter')::bigint
  where id=p_credential->>'id' and user_id=account.id and counter=(p_credential->>'previous_counter')::bigint;
  get diagnostics affected = row_count;
  if affected<>1 then raise exception 'Credential changed'; end if;
 elsif ceremony in ('enroll','add') then
  if ceremony='enroll' then
     if lower(trim(account.email)) !~ '^[^[:space:]@]+@abist[.]co[.]jp$' then
        raise exception 'Only @abist.co.jp company email addresses are allowed';
     end if;
   delete from public.auth_grants where token_hash=p_context->>'grant_hash' and user_id=account.id and expires_at>now()
    and (session_hash is null or session_hash=p_context->>'session_hash') returning * into invitation;
   if invitation.token_hash is null or exists(select 1 from public.auth_passkeys where user_id=account.id) then raise exception 'Invitation expired'; end if;
   target_project := invitation.project_id;
  else
   if browser_session.user_id is distinct from account.id or browser_session.auth_version<>account.auth_version
    or browser_session.authenticated_at is null or browser_session.authenticated_at<now()-interval '5 minutes' then raise exception 'Recent authentication required'; end if;
   if (select count(*) from public.auth_passkeys where user_id=account.id)>=10 then raise exception 'Passkey limit reached'; end if;
   target_project := browser_session.project_id;
  end if;
  insert into public.auth_passkeys(id,user_id,public_key,counter,transports,name)
  values(p_credential->>'id',account.id,p_credential->>'public_key',(p_credential->>'counter')::bigint,
   array(select jsonb_array_elements_text(p_credential->'transports')),p_context->>'name');
  update public.app_users set password_hash=null where id=account.id;
 else raise exception 'Invalid ceremony';
 end if;
 if target_project is null then
  select project_id into target_project from public.memberships where user_id=account.id order by created_at,project_id limit 1;
 end if;
 if not exists(select 1 from public.memberships where user_id=account.id and project_id=target_project) then raise exception 'Membership required'; end if;
 delete from public.auth_sessions where token_hash=browser_session.token_hash;
 insert into public.auth_sessions(token_hash,csrf_token,user_id,project_id,auth_version,authenticated_at,expires_at)
 values(p_new_token_hash,p_csrf_token,account.id,target_project,account.auth_version,now(),now()+interval '8 hours');
 insert into public.auth_audit(user_id,action) values(account.id,ceremony||'_completed');
end $$;

create or replace function public.auth_remove_passkey(p_session_hash text, p_credential_id text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare account public.app_users; browser_session public.auth_sessions;
begin
 select * into browser_session from public.auth_sessions where token_hash=p_session_hash;
 select * into account from public.app_users where id=browser_session.user_id for update;
 if account.id is null or browser_session.auth_version<>account.auth_version or browser_session.expires_at<=now()
  or browser_session.authenticated_at is null or browser_session.authenticated_at<now()-interval '5 minutes' then raise exception 'Recent authentication required'; end if;
 if not exists(select 1 from public.auth_passkeys where id=p_credential_id and user_id=account.id) then raise exception 'Credential not found'; end if;
 if (select count(*) from public.auth_passkeys where user_id=account.id)<=1 then raise exception 'Cannot remove the last passkey'; end if;
 delete from public.auth_passkeys where id=p_credential_id and user_id=account.id;
 delete from public.auth_sessions where user_id=account.id and token_hash<>p_session_hash;
 delete from public.auth_challenges where user_id=account.id;
 insert into public.auth_audit(user_id,action) values(account.id,'passkey_removed');
end $$;

revoke all on function public.auth_issue_grant(text,text,uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function public.auth_complete(jsonb,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.auth_remove_passkey(text,text) from public,anon,authenticated;
grant execute on function public.auth_issue_grant(text,text,uuid,text,text,text,text) to service_role;
grant execute on function public.auth_complete(jsonb,jsonb,text,text) to service_role;
grant execute on function public.auth_remove_passkey(text,text) to service_role;

create table if not exists public.auth_email_codes(
 id uuid primary key,
 email text not null,
 nickname text not null,
 session_hash text not null,
 code_hash text not null,
 attempts integer not null default 0 check(attempts between 0 and 5),
 consumed boolean not null default false,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '10 minutes'
);
create index if not exists auth_email_codes_email_time on public.auth_email_codes(email,created_at);
create index if not exists auth_email_codes_time on public.auth_email_codes(created_at);
alter table public.auth_email_codes enable row level security;
revoke all on public.auth_email_codes from anon,authenticated;
grant all on public.auth_email_codes to service_role;

create or replace function public.auth_request_email(p_id uuid,p_email text,p_nickname text,p_session_hash text,p_code_hash text)
returns text language plpgsql set search_path = public, pg_temp as $$
begin
 if coalesce(p_email,'') !~ '^[^[:space:]@]+@abist[.]co[.]jp$' then raise exception 'Company email required'; end if;
 if not exists(select 1 from public.auth_sessions where token_hash=p_session_hash and user_id is null and expires_at>now()) then raise exception 'Anonymous session required'; end if;
 if not exists(select 1 from public.projects where is_default) then return 'unavailable'; end if;
 perform pg_advisory_xact_lock(hashtext('auth_email_quota'));
 delete from public.auth_email_codes where created_at<now()-interval '32 days';
 if exists(select 1 from public.auth_email_codes where email=p_email and created_at>now()-interval '60 seconds')
  or (select count(*) from public.auth_email_codes where email=p_email and created_at>now()-interval '1 hour')>=5
  or (select count(*) from public.auth_email_codes where created_at>=date_trunc('day',now()))>=180
  or (select count(*) from public.auth_email_codes where created_at>=date_trunc('month',now()))>=900 then return 'limited'; end if;
 update public.auth_email_codes set consumed=true where email=p_email;
 update public.auth_sessions set expires_at=now()+interval '10 minutes' where token_hash=p_session_hash;
 insert into public.auth_email_codes(id,email,nickname,session_hash,code_hash) values(p_id,p_email,p_nickname,p_session_hash,p_code_hash);
 return 'ok';
end $$;

create or replace function public.auth_verify_email(p_id uuid,p_session_hash text,p_code_hash text,p_grant_hash text)
returns text language plpgsql set search_path = public, pg_temp as $$
declare verification public.auth_email_codes; account public.app_users; target_project uuid;
begin
 select * into verification from public.auth_email_codes where id=p_id and session_hash=p_session_hash for update;
 if verification.id is null or verification.consumed or verification.expires_at<=now() or verification.attempts>=5 then return 'invalid'; end if;
 if not exists(select 1 from public.auth_sessions where token_hash=p_session_hash and user_id is null and expires_at>now()) then return 'invalid'; end if;
 if verification.code_hash<>p_code_hash then
  update public.auth_email_codes set attempts=attempts+1 where id=p_id;
  return 'invalid';
 end if;
 perform pg_advisory_xact_lock(hashtext(verification.email));
 select * into account from public.app_users where email=verification.email for update;
 if account.id is null then
  insert into public.app_users(email,nickname) values(verification.email,verification.nickname) returning * into account;
 end if;
 update public.auth_email_codes set consumed=true where id=p_id;
 if exists(select 1 from public.auth_passkeys where user_id=account.id) then return 'exists'; end if;
 select id into target_project from public.projects where is_default;
 if target_project is null then raise exception 'Workspace unavailable'; end if;
 insert into public.memberships(project_id,user_id,display_name,role)
 values(target_project,account.id,account.nickname,'designer') on conflict(project_id,user_id) do nothing;
 delete from public.auth_grants where user_id=account.id;
 insert into public.auth_grants(token_hash,user_id,project_id,purpose,session_hash,expires_at)
 values(p_grant_hash,account.id,target_project,'enroll',p_session_hash,now()+interval '5 minutes');
 update public.auth_sessions set expires_at=now()+interval '10 minutes' where token_hash=p_session_hash;
 insert into public.auth_audit(user_id,action,verified_by) values(account.id,'email_verified','company email code');
 return 'verified';
end $$;

create or replace function public.auth_change_role(p_session_hash text,p_role text)
returns void language plpgsql set search_path = public, pg_temp as $$
declare browser_session public.auth_sessions; account public.app_users; member public.memberships;
 record public.project_states; card jsonb; cards jsonb := '[]'::jsonb; events jsonb := '[]'::jsonb;
begin
 if p_role not in ('designer','it') or p_role is null then raise exception 'Role not permitted'; end if;
 select * into browser_session from public.auth_sessions where token_hash=p_session_hash and expires_at>now();
 select * into account from public.app_users where id=browser_session.user_id for update;
 if account.id is null or browser_session.auth_version<>account.auth_version or browser_session.authenticated_at is null
  or browser_session.authenticated_at<now()-interval '5 minutes' then raise exception 'Recent authentication required'; end if;
 select * into member from public.memberships where project_id=browser_session.project_id and user_id=account.id for update;
 if member.user_id is null or member.role not in ('designer','it') then raise exception 'Role not permitted'; end if;
 if p_role='it' and member.role<>'it' then
  select * into record from public.project_states where project_id=member.project_id for update;
  for card in select value from jsonb_array_elements(coalesce(record.payload->'cards','[]'::jsonb)) loop
   if card->>'status'='review' and exists(select 1 from jsonb_array_elements(card->'route') step where step->'assignees' ? account.id::text) then
    card := jsonb_set(jsonb_set(card,'{status}','"returned"'::jsonb),'{votes}','[]'::jsonb);
    events := events || jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'actor',account.nickname,'action','役割変更による差戻し','target',card->>'id','detail','承認担当者がIT担当者へ変更','time',now()));
   end if;
   cards := cards || jsonb_build_array(card);
  end loop;
  if jsonb_array_length(events)>0 then
   update public.project_states set revision=revision+1,
    payload=jsonb_set(jsonb_set(record.payload,'{cards}',cards),'{events}',events||coalesce(record.payload->'events','[]'::jsonb))
   where project_id=member.project_id;
  end if;
 end if;
 update public.memberships set role=p_role where project_id=member.project_id and user_id=account.id;
 insert into public.auth_audit(user_id,action) values(account.id,'role_changed_to_'||p_role);
end $$;

revoke all on function public.auth_request_email(uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function public.auth_verify_email(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.auth_change_role(text,text) from public,anon,authenticated;
grant execute on function public.auth_request_email(uuid,text,text,text,text) to service_role;
grant execute on function public.auth_verify_email(uuid,text,text,text) to service_role;
grant execute on function public.auth_change_role(text,text) to service_role;
