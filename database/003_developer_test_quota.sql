-- Apply after 001 and 002 in the Supabase project named by SUPABASE_URL.
-- A shared ceiling bounds paid extraction from the code-protected developer
-- test screen even if its static access code is disclosed.

begin;

create table if not exists public.pinmap_developer_test_quota (
  day_kst date primary key,
  used integer not null default 0 check (used >= 0)
);

alter table public.pinmap_developer_test_quota enable row level security;
revoke all on public.pinmap_developer_test_quota from public, anon, authenticated;

create or replace function public.pinmap_claim_developer_test()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (pg_catalog.now() at time zone 'Asia/Seoul')::date;
  v_used integer;
begin
  insert into public.pinmap_developer_test_quota (day_kst, used)
    values (v_day, 1)
  on conflict (day_kst) do update
    set used = public.pinmap_developer_test_quota.used + 1
    where public.pinmap_developer_test_quota.used < 20
  returning used into v_used;

  if v_used is null then
    return pg_catalog.jsonb_build_object('allowed', false, 'remaining', 0);
  end if;
  return pg_catalog.jsonb_build_object('allowed', true, 'remaining', 20 - v_used);
end;
$$;

revoke all on function public.pinmap_claim_developer_test() from public, anon, authenticated;
grant execute on function public.pinmap_claim_developer_test() to service_role;

commit;
