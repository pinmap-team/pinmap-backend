begin;
create table public.pinmap_billing_checkouts (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 environment text not null check(environment in ('sandbox','live')), transaction_id text unique, created_at timestamptz not null default now()
);
create table public.pinmap_subscriptions (
 subscription_id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
 customer_id text not null, environment text not null check(environment in ('sandbox','live')), status text not null, price_id text not null,
 period_start timestamptz, period_end timestamptz, paid_until timestamptz, revoked_until timestamptz,
 cancel_at timestamptz, provider_updated_at timestamptz not null, updated_at timestamptz not null default now()
);
create index on public.pinmap_subscriptions(user_id);
create table public.pinmap_billing_events (event_id text primary key, created_at timestamptz not null default now());
create table public.pinmap_analysis_usage (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 subscription_id text not null references public.pinmap_subscriptions(subscription_id),
 period_start timestamptz not null, state text not null check(state in ('reserved','completed')),
 created_at timestamptz not null default now()
);
create index on public.pinmap_analysis_usage(user_id,subscription_id,period_start);
alter table public.pinmap_billing_checkouts enable row level security;
alter table public.pinmap_subscriptions enable row level security;
alter table public.pinmap_billing_events enable row level security;
alter table public.pinmap_analysis_usage enable row level security;
revoke all on public.pinmap_billing_checkouts,public.pinmap_subscriptions,public.pinmap_billing_events,public.pinmap_analysis_usage from public,anon,authenticated;
grant all on public.pinmap_billing_checkouts,public.pinmap_subscriptions,public.pinmap_billing_events,public.pinmap_analysis_usage to service_role;
-- Reuse the pending checkout across retries and concurrent checkout clicks.
create function public.pinmap_begin_checkout(p_user_id uuid,p_environment text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.pinmap_billing_checkouts;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,18));
 if exists(select 1 from public.pinmap_subscriptions where user_id=p_user_id and environment=p_environment and status in ('active','trialing','past_due','paused')) then
 return jsonb_build_object('error','subscription_exists'); end if;
 select * into c from public.pinmap_billing_checkouts where user_id=p_user_id and environment=p_environment
 and created_at>now()-interval '30 minutes' order by created_at desc limit 1;
 if found then return jsonb_build_object('id',c.id,'transaction_id',c.transaction_id,'existing',true); end if;
 insert into public.pinmap_billing_checkouts(user_id,environment) values(p_user_id,p_environment) returning * into c;
 return jsonb_build_object('id',c.id,'existing',false);
end $$;
revoke all on function public.pinmap_begin_checkout(uuid,text) from public,anon,authenticated;
grant execute on function public.pinmap_begin_checkout(uuid,text) to service_role;
-- One atomic operation for duplicate delivery and out-of-order subscription snapshots.
create function public.pinmap_apply_billing_event(p_event_id text,p_subscription jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 insert into public.pinmap_billing_events(event_id) values(p_event_id) on conflict do nothing;
 if not found then return false; end if;
 insert into public.pinmap_subscriptions(subscription_id,user_id,customer_id,environment,status,price_id,period_start,period_end,paid_until,revoked_until,cancel_at,provider_updated_at)
 values(p_subscription->>'subscription_id',(p_subscription->>'user_id')::uuid,p_subscription->>'customer_id',p_subscription->>'environment',p_subscription->>'status',p_subscription->>'price_id',
 (p_subscription->>'period_start')::timestamptz,(p_subscription->>'period_end')::timestamptz,(p_subscription->>'paid_until')::timestamptz,
 (p_subscription->>'revoked_until')::timestamptz,(p_subscription->>'cancel_at')::timestamptz,(p_subscription->>'provider_updated_at')::timestamptz)
 on conflict(subscription_id) do update set
 status=excluded.status,price_id=excluded.price_id,period_start=excluded.period_start,period_end=excluded.period_end,
 paid_until=greatest(public.pinmap_subscriptions.paid_until,excluded.paid_until),revoked_until=greatest(public.pinmap_subscriptions.revoked_until,excluded.revoked_until),cancel_at=excluded.cancel_at,
 provider_updated_at=excluded.provider_updated_at,updated_at=now()
 where public.pinmap_subscriptions.user_id=excluded.user_id
 and public.pinmap_subscriptions.provider_updated_at<=excluded.provider_updated_at;
 return true;
end $$;
-- Reserve before calling AI. Expired reservations stop crashed workers locking a quota forever.
create function public.pinmap_reserve_analysis(p_user_id uuid,p_environment text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.pinmap_subscriptions; n integer; r uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,17));
 select * into s from public.pinmap_subscriptions where user_id=p_user_id and environment=p_environment and status='active'
 and period_start<=now() and period_end>now() and paid_until>=period_end and (revoked_until is null or paid_until>revoked_until)
 order by period_end desc limit 1;
 if not found then
  if exists(select 1 from public.pinmap_subscriptions where user_id=p_user_id and environment=p_environment) then return jsonb_build_object('allowed',false,'error','subscription_inactive'); end if;
  return jsonb_build_object('allowed',true,'reservation_id',null); -- existing free policy
 end if;
 select count(*) into n from public.pinmap_analysis_usage where user_id=p_user_id and subscription_id=s.subscription_id
 and period_start=s.period_start and (state='completed' or created_at>now()-interval '15 minutes');
 if n>=300 then return jsonb_build_object('allowed',false,'error','monthly_analysis_limit','limit',300); end if;
 insert into public.pinmap_analysis_usage(user_id,subscription_id,period_start,state) values(p_user_id,s.subscription_id,s.period_start,'reserved') returning id into r;
 return jsonb_build_object('allowed',true,'reservation_id',r);
end $$;
create function public.pinmap_finish_analysis(p_id uuid,p_success boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_success then update public.pinmap_analysis_usage set state='completed' where id=p_id;
 else delete from public.pinmap_analysis_usage where id=p_id and state='reserved'; end if;
end $$;
revoke all on function public.pinmap_apply_billing_event(text,jsonb),public.pinmap_reserve_analysis(uuid,text),public.pinmap_finish_analysis(uuid,boolean) from public,anon,authenticated;
grant execute on function public.pinmap_apply_billing_event(text,jsonb),public.pinmap_reserve_analysis(uuid,text),public.pinmap_finish_analysis(uuid,boolean) to service_role;
-- Paid accounts must be able to keep more than the old 100 saved posts.
create or replace function pinmap_private.limit_saved_content() returns trigger language plpgsql security definer set search_path='' as $$
declare cap integer:=100;
begin
 perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,0));
 if exists(select 1 from public.pinmap_subscriptions where user_id=new.user_id and status='active' and period_end>now() and paid_until>=period_end and (revoked_until is null or paid_until>revoked_until)) then return new; end if;
 if not exists(select 1 from public.pinmap_saved_content where user_id=new.user_id and source_url=new.source_url)
 and (select count(*) from public.pinmap_saved_content where user_id=new.user_id)>=cap then raise exception 'Saved content limit reached' using errcode='PZ001'; end if;
 return new;
end $$;
commit;
