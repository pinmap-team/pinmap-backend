-- Apply in the same Supabase project used by SUPABASE_URL before enabling
-- POST /api/content-extract. An unavailable RPC makes that endpoint fail closed.
-- The quota is five extraction attempts per signed-in user per Seoul calendar day.

begin;

create table if not exists public.pinmap_content_extraction_quota (
  user_id uuid not null references auth.users(id) on delete cascade,
  day_kst date not null,
  used integer not null default 0 check (used >= 0),
  primary key (user_id, day_kst)
);

alter table public.pinmap_content_extraction_quota enable row level security;
revoke all on public.pinmap_content_extraction_quota from public, anon, authenticated;

create or replace function public.pinmap_claim_content_extraction()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_day date := (pg_catalog.now() at time zone 'Asia/Seoul')::date;
  v_used integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if (auth.jwt()->>'is_anonymous')::boolean is distinct from false then
    raise exception 'Permanent account required' using errcode = '28000';
  end if;

  insert into public.pinmap_content_extraction_quota (user_id, day_kst, used)
    values (v_user_id, v_day, 1)
  on conflict (user_id, day_kst) do update
    set used = public.pinmap_content_extraction_quota.used + 1
    where public.pinmap_content_extraction_quota.used < 5
  returning used into v_used;

  if v_used is null then
    return pg_catalog.jsonb_build_object('allowed', false, 'remaining', 0);
  end if;
  return pg_catalog.jsonb_build_object('allowed', true, 'remaining', 5 - v_used);
end;
$$;

revoke all on function public.pinmap_claim_content_extraction() from public, anon;
grant execute on function public.pinmap_claim_content_extraction() to authenticated;

commit;
