-- Allow 'bluesky' as a public-post source. X's API now requires paid credits,
-- so the Namma Chennai timeline posts to Bluesky (free, public) as well —
-- postSocial() picks whichever platform is configured.
alter table public.public_posts drop constraint if exists public_posts_source_check;
alter table public.public_posts
  add constraint public_posts_source_check
  check (source in ('simulated', 'x', 'bluesky'));
