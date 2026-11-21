-- Free analysis: 50 successful analyses per Seoul calendar month.
begin;
create table public.pinmap_free_analysis_usage (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 month_kst date not null,
 state text not null check(state in ('reserved','completed')),
 created_at timestamptz not null default now()
);
create index on public.pinmap_free_analysis_usage(user_id,month_kst);
alter table public.pinmap_free_analysis_usage enable row level security;
revoke all on public.pinmap_free_analysis_usage from public,anon,authenticated;
grant all on public.pinmap_free_analysis_usage to service_role;

create or replace function public.pinmap_free_analysis_status(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m date := date_trunc('month',now() at time zone 'Asia/Seoul')::date; n integer;
begin
 select count(*) into n from public.pinmap_free_analysis_usage
 where user_id=p_user_id and month_kst=m and state='completed';
 return jsonb_build_object('monthlyLimit',50,'used',n,'remaining',greatest(0,50-n));
end $$;
revoke all on function public.pinmap_free_analysis_status(uuid) from public,anon,authenticated;
grant execute on function public.pinmap_free_analysis_status(uuid) to service_role;

create or replace function public.pinmap_reserve_analysis(p_user_id uuid,p_environment text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.pinmap_subscriptions; n integer; r uuid;
 m date := date_trunc('month',now() at time zone 'Asia/Seoul')::date;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,17));
 select * into s from public.pinmap_subscriptions where user_id=p_user_id and environment=p_environment and status='active'
 and period_start<=now() and period_end>now() and paid_until>=period_end and (revoked_until is null or paid_until>revoked_until)
 order by period_end desc limit 1;
 if not found then
  select count(*) into n from public.pinmap_free_analysis_usage where user_id=p_user_id and month_kst=m
  and (state='completed' or created_at>now()-interval '15 minutes');
  if n>=50 then return jsonb_build_object('allowed',false,'error','free_monthly_analysis_limit','limit',50); end if;
  insert into public.pinmap_free_analysis_usage(user_id,month_kst,state) values(p_user_id,m,'reserved') returning id into r;
  return jsonb_build_object('allowed',true,'reservation_id',r);
 end if;
 select count(*) into n from public.pinmap_analysis_usage where user_id=p_user_id and subscription_id=s.subscription_id
 and period_start=s.period_start and (state='completed' or created_at>now()-interval '15 minutes');
 if n>=300 then return jsonb_build_object('allowed',false,'error','monthly_analysis_limit','limit',300); end if;
 insert into public.pinmap_analysis_usage(user_id,subscription_id,period_start,state) values(p_user_id,s.subscription_id,s.period_start,'reserved') returning id into r;
 return jsonb_build_object('allowed',true,'reservation_id',r);
end $$;

create or replace function public.pinmap_finish_analysis(p_id uuid,p_success boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_success then
  update public.pinmap_analysis_usage set state='completed' where id=p_id and state='reserved';
  update public.pinmap_free_analysis_usage set state='completed' where id=p_id and state='reserved';
 else
  delete from public.pinmap_analysis_usage where id=p_id and state='reserved';
  delete from public.pinmap_free_analysis_usage where id=p_id and state='reserved';
 end if;
end $$;
revoke all on function public.pinmap_reserve_analysis(uuid,text),public.pinmap_finish_analysis(uuid,boolean) from public,anon,authenticated;
grant execute on function public.pinmap_reserve_analysis(uuid,text),public.pinmap_finish_analysis(uuid,boolean) to service_role;
commit;
