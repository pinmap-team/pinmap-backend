-- Fix the capture source URL check from 007: a UUID has five groups.
-- Apply after 007_capture_content.sql. Existing rows and other constraints remain intact.
begin;

alter table public.pinmap_saved_content
  drop constraint if exists pinmap_saved_content_source_url_check;
alter table public.pinmap_saved_content
  add constraint pinmap_saved_content_source_url_check check (
    source_url ~ '^https://www[.]instagram[.]com/(p|reel|tv)/[A-Za-z0-9_-]+/$'
    or source_url ~ '^pinmap://capture/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  );

commit;
