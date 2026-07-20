-- OAuth-aware profile creation.
--
-- The original trigger only read `display_name`, which is what our own signup
-- form sends. Google returns `full_name` / `name` and an avatar instead, so an
-- OAuth user landed with an empty display name and the UI fell back to showing
-- the email local-part. Coalesce across the shapes each provider actually uses.

alter table public.profiles
  add column if not exists avatar_url text;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, email, avatar_url)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),  -- our signup form
      nullif(new.raw_user_meta_data ->> 'full_name', ''),     -- Google
      nullif(new.raw_user_meta_data ->> 'name', ''),          -- other providers
      split_part(coalesce(new.email, 'citizen'), '@', 1)      -- last resort
    ),
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'avatar_url', ''),
      nullif(new.raw_user_meta_data ->> 'picture', '')
    )
  )
  on conflict (id) do update
    set display_name = coalesce(nullif(excluded.display_name, ''), public.profiles.display_name),
        avatar_url   = coalesce(excluded.avatar_url, public.profiles.avatar_url),
        email        = coalesce(excluded.email, public.profiles.email);
  return new;
end;
$$;

-- Backfill anyone created before this ran.
update public.profiles p
   set display_name = coalesce(
         nullif(p.display_name, ''),
         nullif(u.raw_user_meta_data ->> 'full_name', ''),
         nullif(u.raw_user_meta_data ->> 'name', ''),
         split_part(coalesce(u.email, 'citizen'), '@', 1)
       ),
       avatar_url = coalesce(
         p.avatar_url,
         nullif(u.raw_user_meta_data ->> 'avatar_url', ''),
         nullif(u.raw_user_meta_data ->> 'picture', '')
       )
  from auth.users u
 where u.id = p.id;
