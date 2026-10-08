-- QuickTime files are accepted only after the client preflight and server-side inspection of the
-- stored moov atom confirm H.264 video and, when present, AAC audio. Align the private bucket.
alter table public.media drop constraint if exists media_mime_type_check;
alter table public.media
  add constraint media_mime_type_check
  check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'));

alter table public.media_uploads drop constraint if exists media_uploads_mime_type_check;
alter table public.media_uploads
  add constraint media_uploads_mime_type_check
  check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'));

update storage.buckets
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']
where id = 'signage-media';
