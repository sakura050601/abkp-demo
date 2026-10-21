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
