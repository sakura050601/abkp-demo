-- Run once in Supabase SQL Editor. Client writes are forbidden; Render validates every command.
create table public.projects(id uuid primary key default gen_random_uuid(), name text not null);
create table public.memberships(
 project_id uuid references public.projects(id) on delete cascade,
 user_id uuid references auth.users(id) on delete cascade,
 display_name text not null,
 role text not null check(role in ('designer','senior','viewer')),
 created_at timestamptz not null default now(), primary key(project_id,user_id)
);
-- Single atomic aggregate for the demo. raw/cards/cores retain separate IDs and immutable core snapshots.
create table public.project_states(
 project_id uuid primary key references public.projects(id) on delete cascade,
 revision bigint not null default 0,
 payload jsonb not null default '{"raw":[],"cards":[],"cores":[],"events":[]}'::jsonb
);
alter table public.projects enable row level security;
alter table public.memberships enable row level security;
alter table public.project_states enable row level security;
revoke all on public.projects,public.memberships,public.project_states from anon,authenticated;
grant select on public.projects,public.memberships,public.project_states to authenticated;
grant all on public.projects,public.memberships,public.project_states to service_role;
create policy own_membership on public.memberships for select to authenticated using(user_id=auth.uid());
create policy member_projects on public.projects for select to authenticated using(exists(select 1 from public.memberships m where m.project_id=projects.id and m.user_id=auth.uid()));
create policy member_state on public.project_states for select to authenticated using(exists(select 1 from public.memberships m where m.project_id=project_states.project_id and m.user_id=auth.uid()));
-- Bootstrap: create users in Authentication first, then replace UUIDs and run:
-- insert into public.projects(id,name) values ('PROJECT_UUID','設計事業部');
-- insert into public.project_states(project_id) values ('PROJECT_UUID');
-- insert into public.memberships(project_id,user_id,display_name,role) values
-- ('PROJECT_UUID','AUTHOR_AUTH_UUID','藤井 美咲','designer'),
-- ('PROJECT_UUID','REVIEWER_AUTH_UUID','田中 健一','designer'),
-- ('PROJECT_UUID','SENIOR_AUTH_UUID','佐藤 直樹','senior');
