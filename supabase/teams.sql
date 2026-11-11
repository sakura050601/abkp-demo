-- Run once in Supabase SQL editor before enabling Teams.
create table if not exists public.teams_connections (
 user_id uuid primary key references public.app_users(id) on delete cascade,
 secret text not null
);
alter table public.teams_connections enable row level security;
revoke all on public.teams_connections from anon, authenticated;
grant all on public.teams_connections to service_role;
