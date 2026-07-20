-- Photo storage.
--
-- Photos arrive here ALREADY redacted and re-encoded by the browser
-- (src/lib/imaging.ts): faces pixelated, EXIF stripped as a side effect of the
-- canvas round-trip. The original file never leaves the device, so there is no
-- path by which an unredacted frame reaches this bucket.
--
-- Objects are keyed `<user_id>/<report_id>-<kind>.jpg`, which is what the
-- owner-scoped write policies below match on.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-photos', 'report-photos', true, 5242880,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Public read: the accountability ledger is meant to be showable, and these are
-- redacted street photographs.
drop policy if exists report_photos_public_read on storage.objects;
create policy report_photos_public_read on storage.objects
  for select to public
  using (bucket_id = 'report-photos');

-- Writes are confined to a folder named for the uploading user.
drop policy if exists report_photos_insert_own on storage.objects;
create policy report_photos_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'report-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists report_photos_update_own on storage.objects;
create policy report_photos_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'report-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists report_photos_delete_own on storage.objects;
create policy report_photos_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'report-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
