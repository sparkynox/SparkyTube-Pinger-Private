-- ALREADY APPLIED to the Supabase project "sparkytube-server" (eagpejfljladgbsinnru).
-- kept here only for reference / if you ever recreate the project

-- run once in Supabase > SQL Editor

create table if not exists kv (
  key text primary key,
  value jsonb not null
);

create table if not exists counters (
  name text primary key,
  n bigint not null default 0
);

-- atomic +n, so two downloads at the same moment can't lose a count
create or replace function bump_counter(p_name text, p_by bigint default 1)
returns bigint
language sql
set search_path = public
as $$
  insert into counters (name, n) values (p_name, p_by)
  on conflict (name) do update set n = counters.n + excluded.n
  returning n;
$$;

-- nobody but the service key can touch these
alter table kv enable row level security;
alter table counters enable row level security;

revoke execute on function bump_counter(text, bigint) from public, anon, authenticated;
grant execute on function bump_counter(text, bigint) to service_role;
