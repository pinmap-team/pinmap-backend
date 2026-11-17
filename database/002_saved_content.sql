-- Apply after 001_content_extraction_quota.sql in the Supabase project used by
-- SUPABASE_URL. This migration is required before /api/content-save is enabled.
-- Only the server-held secret key may access these trusted analysis records.
-- Image data URLs are bounded; original captions, OCR and video are not stored.

begin;

create table if not exists public.pinmap_saved_content (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_url text not null check (
    source_url ~ '^https://www[.]instagram[.]com/(p|reel|tv)/[A-Za-z0-9_-]+/$'
  ),
  content_kind text not null check (content_kind in ('place', 'event', 'mixed', 'unknown')),
  status text not null check (status in (
    'extracted', 'needs_review', 'collection_failed', 'needs_media_or_ai',
    'extractor_unavailable', 'extractor_timeout', 'extractor_invalid_response'
  )),
  ai_title text check (pg_catalog.octet_length(ai_title) <= 1600),
  ai_summary text check (pg_catalog.octet_length(ai_summary) <= 3200),
  author_username text check (pg_catalog.octet_length(author_username) <= 256),
  author_profile_data_url text check (
    author_profile_data_url ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$'
    and pg_catalog.octet_length(author_profile_data_url) <= 410000
  ),
  cover_data_url text check (
    cover_data_url ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$'
    and pg_catalog.octet_length(cover_data_url) <= 410000
  ),
  places jsonb not null default '[]'::jsonb check (
    pg_catalog.jsonb_typeof(places) = 'array'
    and pg_catalog.jsonb_array_length(places) <= 40
    and pg_catalog.octet_length(places::text) <= 160000
  ),
  events jsonb not null default '[]'::jsonb check (
    pg_catalog.jsonb_typeof(events) = 'array'
    and pg_catalog.jsonb_array_length(events) <= 40
    and pg_catalog.octet_length(events::text) <= 250000
  ),
  map_locations jsonb not null default '[]'::jsonb check (
    pg_catalog.jsonb_typeof(map_locations) = 'array'
    and pg_catalog.jsonb_array_length(map_locations) <= 40
    and pg_catalog.octet_length(map_locations::text) <= 600000
  ),
  extraction_notes jsonb not null default '[]'::jsonb check (
    pg_catalog.jsonb_typeof(extraction_notes) = 'array'
    and pg_catalog.jsonb_array_length(extraction_notes) <= 12
    and pg_catalog.octet_length(extraction_notes::text) <= 12000
  ),
  media_warnings jsonb not null default '[]'::jsonb check (
    pg_catalog.jsonb_typeof(media_warnings) = 'array'
    and pg_catalog.jsonb_array_length(media_warnings) <= 40
    and pg_catalog.octet_length(media_warnings::text) <= 32000
  ),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  unique (user_id, source_url),
  check (
    (content_kind = 'place' and pg_catalog.jsonb_array_length(places) > 0 and pg_catalog.jsonb_array_length(events) = 0)
    or (content_kind = 'event' and pg_catalog.jsonb_array_length(events) > 0 and pg_catalog.jsonb_array_length(places) = 0)
    or (content_kind = 'mixed' and pg_catalog.jsonb_array_length(places) > 0 and pg_catalog.jsonb_array_length(events) > 0)
    or (content_kind = 'unknown' and pg_catalog.jsonb_array_length(places) = 0 and pg_catalog.jsonb_array_length(events) = 0)
  )
);

create index if not exists pinmap_saved_content_user_recent_idx
  on public.pinmap_saved_content (user_id, updated_at desc, id desc);

-- Keep row creation bounded even when several server requests for one user
-- arrive together. No browser-facing database role can access this table.
create schema if not exists pinmap_private;
revoke all on schema pinmap_private from public, anon, authenticated;

create or replace function pinmap_private.limit_saved_content()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 0));
  if not exists (
    select 1 from public.pinmap_saved_content
    where user_id = new.user_id and source_url = new.source_url
  ) and (
    select pg_catalog.count(*) from public.pinmap_saved_content where user_id = new.user_id
  ) >= 100 then
    raise exception 'Saved content limit reached' using errcode = 'PZ001';
  end if;
  return new;
end;
$$;

revoke all on function pinmap_private.limit_saved_content() from public, anon, authenticated;
create trigger pinmap_saved_content_limit_insert
  before insert on public.pinmap_saved_content
  for each row execute function pinmap_private.limit_saved_content();

alter table public.pinmap_saved_content enable row level security;
revoke all on public.pinmap_saved_content from public, anon, authenticated;
grant select, insert, update, delete on public.pinmap_saved_content to service_role;

commit;
