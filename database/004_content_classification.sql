-- Additive migration; old clients and saved rows remain valid.
begin;
alter table public.pinmap_saved_content
  add column if not exists classification jsonb not null default '{}'::jsonb
  check (pg_catalog.jsonb_typeof(classification) = 'object'
         and pg_catalog.octet_length(classification::text) <= 2000);
commit;
