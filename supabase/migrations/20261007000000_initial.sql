-- Digital Signage schema for Supabase/Postgres. Apply with `supabase db push` or the SQL editor.
create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Asia/Riyadh',
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'viewer' check (role in ('admin', 'operator', 'viewer')),
  organization_id uuid references public.organizations(id) on delete set null,
  disabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, email, role)
  values (new.id, new.email, 'viewer')
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute procedure public.handle_new_user();

create table if not exists public.playlists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete set null,
  name text not null check (char_length(name) between 1 and 120),
  enabled boolean not null default true,
  draft_version integer not null default 0,
  published_version integer,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.media (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete set null,
  storage_path text not null unique,
  display_name text not null check (char_length(display_name) between 1 and 240),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'video/mp4')),
  kind text not null check (kind in ('image', 'video')),
  file_size bigint not null check (file_size > 0 and file_size <= 2147483648),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  width integer,
  height integer,
  duration_ms integer,
  thumbnail_data text,
  compatibility text not null default 'unknown' check (compatibility in ('unknown', 'candidate', 'warning')),
  metadata jsonb not null default '{}'::jsonb,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists media_sha256_unique_idx on public.media(sha256);
create index if not exists media_created_at_idx on public.media(created_at desc);

create table if not exists public.playlist_items (
  id uuid primary key default gen_random_uuid(),
  playlist_id uuid not null references public.playlists(id) on delete cascade,
  media_id uuid not null references public.media(id) on delete restrict,
  position integer not null check (position >= 0),
  duration_ms integer,
  loop_video boolean not null default false,
  created_at timestamptz not null default now(),
  unique (playlist_id, position)
);
create index if not exists playlist_items_media_idx on public.playlist_items(media_id);

create table if not exists public.playlist_versions (
  id uuid primary key default gen_random_uuid(),
  playlist_id uuid not null references public.playlists(id) on delete cascade,
  version integer not null,
  manifest jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz not null default now(),
  unique (playlist_id, version)
);

create table if not exists public.screens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete set null,
  name text not null check (char_length(name) between 1 and 120),
  timezone text not null default 'Asia/Riyadh',
  enabled boolean not null default true,
  assigned_playlist_id uuid references public.playlists(id) on delete set null,
  paired_at timestamptz,
  last_seen_at timestamptz,
  last_sync_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ready', 'syncing', 'failed', 'offline')),
  last_sync_error text,
  current_playlist_id uuid references public.playlists(id) on delete set null,
  current_playlist_version integer,
  current_item_id uuid,
  cached_media_count integer not null default 0,
  device_info jsonb not null default '{}'::jsonb,
  sync_command_version integer not null default 0,
  reload_command_version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists screens_last_seen_idx on public.screens(last_seen_at desc);

create table if not exists public.screen_credentials (
  id uuid primary key default gen_random_uuid(),
  screen_id uuid not null references public.screens(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists screen_credentials_screen_idx on public.screen_credentials(screen_id) where revoked_at is null;

create table if not exists public.pairing_codes (
  id uuid primary key default gen_random_uuid(),
  screen_id uuid not null references public.screens(id) on delete cascade,
  code_hash text not null unique check (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  attempts integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists pairing_codes_expiry_idx on public.pairing_codes(expires_at);

create table if not exists public.schedule_entries (
  id uuid primary key default gen_random_uuid(),
  screen_id uuid not null references public.screens(id) on delete cascade,
  playlist_id uuid not null references public.playlists(id) on delete restrict,
  weekdays integer[] not null default array[1,2,3,4,5,6,7],
  start_time text not null check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time text not null check (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone text not null default 'Asia/Riyadh',
  enabled boolean not null default true,
  priority integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cardinality(weekdays) between 1 and 7),
  check (start_time <> end_time)
);
create index if not exists schedules_screen_idx on public.schedule_entries(screen_id, enabled, priority desc);

create table if not exists public.screen_heartbeats (
  id bigint generated always as identity primary key,
  screen_id uuid not null references public.screens(id) on delete cascade,
  received_at timestamptz not null default now(),
  current_playlist_id uuid,
  current_playlist_version integer,
  current_item_id uuid,
  sync_status text not null default 'ready' check (sync_status in ('ready', 'syncing', 'failed', 'offline')),
  sync_error text,
  cached_media_count integer not null default 0,
  storage_usage_bytes bigint,
  storage_quota_bytes bigint,
  device_info jsonb not null default '{}'::jsonb
);
create index if not exists screen_heartbeats_recent_idx on public.screen_heartbeats(screen_id, received_at desc);

create table if not exists public.sync_manifests (
  screen_id uuid not null references public.screens(id) on delete cascade,
  version integer not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  manifest jsonb not null,
  created_at timestamptz not null default now(),
  primary key (screen_id, version)
);

create table if not exists public.configuration_versions (
  id bigint generated always as identity primary key,
  screen_id uuid not null references public.screens(id) on delete cascade,
  version integer not null,
  configuration jsonb not null,
  created_at timestamptz not null default now(),
  unique (screen_id, version)
);

create table if not exists public.media_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique,
  multipart_id text not null,
  file_name text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 2147483648),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'video/mp4')),
  status text not null default 'uploading' check (status in ('uploading', 'completed', 'aborted')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  completed_media_id uuid references public.media(id) on delete set null
);
create index if not exists media_uploads_user_idx on public.media_uploads(user_id, status, created_at desc);

create table if not exists public.pairing_rate_limits (
  key_hash text not null,
  bucket_start timestamptz not null,
  attempts integer not null default 0,
  primary key (key_hash, bucket_start)
);

-- A pairing code can be consumed only once; the screen credential stores only a one-way hash.
create or replace function public.consume_pairing_code(
  p_code_hash text,
  p_token_hash text,
  p_device_info jsonb default '{}'::jsonb,
  p_now timestamptz default now()
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  found_code public.pairing_codes%rowtype;
begin
  select * into found_code from public.pairing_codes
    where code_hash = p_code_hash for update;
  if not found then return null; end if;
  if found_code.used_at is not null or found_code.expires_at <= p_now or found_code.attempts >= 5 then
    return null;
  end if;
  update public.pairing_codes set used_at = p_now, attempts = attempts + 1 where id = found_code.id;
  update public.screen_credentials set revoked_at = p_now where screen_id = found_code.screen_id and revoked_at is null;
  insert into public.screen_credentials(screen_id, token_hash) values (found_code.screen_id, p_token_hash);
  update public.screens set paired_at = p_now, device_info = coalesce(p_device_info, '{}'::jsonb), last_sync_status = 'never', updated_at = p_now
    where id = found_code.screen_id;
  return found_code.screen_id;
end;
$$;

create or replace function public.consume_pairing_rate_limit(p_key_hash text, p_now timestamptz default now())
returns boolean language plpgsql security definer set search_path = public as $$
declare
  window_start timestamptz;
  attempt_count integer;
begin
  window_start := date_trunc('minute', p_now) - ((extract(minute from p_now)::integer % 10) * interval '1 minute');
  insert into public.pairing_rate_limits(key_hash, bucket_start, attempts)
    values (p_key_hash, window_start, 1)
  on conflict (key_hash, bucket_start) do update set attempts = public.pairing_rate_limits.attempts + 1
  returning attempts into attempt_count;
  delete from public.pairing_rate_limits where bucket_start < p_now - interval '1 day';
  return attempt_count <= 8;
end;
$$;

-- Serializes manifest version assignment so two concurrent polls cannot fork the same version.
create or replace function public.save_sync_manifest(p_screen_id uuid, p_hash text, p_manifest jsonb)
returns table(manifest_version integer, changed boolean)
language plpgsql security definer set search_path = public as $$
declare
  current_version integer;
  current_hash text;
  next_version integer;
begin
  perform 1 from public.screens where id = p_screen_id for update;
  if not found then raise exception 'screen not found'; end if;
  select sm.version, sm.content_hash into current_version, current_hash
    from public.sync_manifests sm where sm.screen_id = p_screen_id order by sm.version desc limit 1;
  if current_version is not null and current_hash = p_hash then
    return query select current_version, false;
    return;
  end if;
  next_version := coalesce(current_version, 0) + 1;
  insert into public.sync_manifests(screen_id, version, content_hash, manifest)
    values (p_screen_id, next_version, p_hash, p_manifest);
  insert into public.configuration_versions(screen_id, version, configuration)
    values (p_screen_id, next_version, p_manifest);
  return query select next_version, true;
end;
$$;

-- Saves the editable playlist atomically, optionally publishing an immutable manifest revision.
create or replace function public.save_playlist_revision(
  p_playlist_id uuid,
  p_name text,
  p_enabled boolean,
  p_items jsonb,
  p_publish boolean,
  p_created_by uuid default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  item jsonb;
  item_media public.media%rowtype;
  item_position integer := 0;
  published_ver integer;
  draft_ver integer;
  snapshot_items jsonb := '[]'::jsonb;
  duration_value integer;
  loop_value boolean;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
    raise exception 'playlist must contain between zero and 100 items';
  end if;
  if char_length(trim(p_name)) < 1 or char_length(trim(p_name)) > 120 then
    raise exception 'invalid playlist name';
  end if;
  update public.playlists set name = trim(p_name), enabled = p_enabled, updated_at = now()
    where id = p_playlist_id returning published_version, draft_version into published_ver, draft_ver;
  if not found then raise exception 'playlist not found'; end if;

  delete from public.playlist_items where playlist_id = p_playlist_id;
  for item in select value from jsonb_array_elements(p_items) loop
    select * into item_media from public.media where id = (item->>'mediaId')::uuid;
    if not found then raise exception 'media item not found'; end if;
    duration_value := nullif(item->>'durationMs', '')::integer;
    if item_media.kind = 'image' and (duration_value is null or duration_value < 1000 or duration_value > 86400000) then
      raise exception 'image duration must be between 1 second and 24 hours';
    end if;
    loop_value := coalesce((item->>'loop')::boolean, false);
    insert into public.playlist_items(playlist_id, media_id, position, duration_ms, loop_video)
      values (p_playlist_id, item_media.id, item_position, duration_value, loop_value);
    snapshot_items := snapshot_items || jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid(),
      'mediaId', item_media.id,
      'name', item_media.display_name,
      'hash', item_media.sha256,
      'size', item_media.file_size,
      'mimeType', item_media.mime_type,
      'kind', item_media.kind,
      'durationMs', case when item_media.kind = 'image' then duration_value else null end,
      'loop', case when item_media.kind = 'video' then loop_value else false end,
      'position', item_position
    ));
    item_position := item_position + 1;
  end loop;
  draft_ver := coalesce(draft_ver, 0) + 1;
  update public.playlists set draft_version = draft_ver where id = p_playlist_id;
  if p_publish then
    published_ver := coalesce(published_ver, 0) + 1;
    insert into public.playlist_versions(playlist_id, version, manifest, created_by)
      values (p_playlist_id, published_ver, jsonb_build_object(
        'id', p_playlist_id, 'name', trim(p_name), 'version', published_ver,
        'enabled', p_enabled, 'items', snapshot_items
      ), p_created_by);
    update public.playlists set published_version = published_ver where id = p_playlist_id;
    return published_ver;
  end if;
  return coalesce(published_ver, 0);
end;
$$;

-- Usage includes both the editable draft rows and the currently published revision. This prevents
-- deleting media that is still needed by screens merely because a draft has already removed it.
create or replace function public.get_media_usage_counts(p_media_ids uuid[])
returns table(media_id uuid, usage_count bigint)
language sql security definer set search_path = public as $$
  with requested as (
    select distinct unnest(coalesce(p_media_ids, '{}'::uuid[])) as media_id
  ), draft_usage as (
    select pi.playlist_id, pi.media_id, count(*)::bigint as item_count
    from public.playlist_items pi
    join requested r on r.media_id = pi.media_id
    group by pi.playlist_id, pi.media_id
  ), published_usage as (
    select p.id as playlist_id, (entries.value->>'mediaId')::uuid as media_id, count(*)::bigint as item_count
    from public.playlists p
    join public.playlist_versions pv on pv.playlist_id = p.id and pv.version = p.published_version
    cross join lateral jsonb_array_elements(coalesce(pv.manifest->'items', '[]'::jsonb)) as entries(value)
    join requested r on r.media_id = (entries.value->>'mediaId')::uuid
    group by p.id, (entries.value->>'mediaId')::uuid
  ), per_playlist as (
    select playlist_id, media_id, max(item_count) as item_count
    from (
      select * from draft_usage
      union all
      select * from published_usage
    ) usage_rows
    group by playlist_id, media_id
  )
  select r.media_id, coalesce(sum(pp.item_count), 0)::bigint
  from requested r
  left join per_playlist pp on pp.media_id = r.media_id
  group by r.media_id;
$$;

-- All application data is accessed through authenticated server routes using the service role.
-- Direct browser access to these tables is intentionally denied by RLS.
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.playlists enable row level security;
alter table public.media enable row level security;
alter table public.playlist_items enable row level security;
alter table public.playlist_versions enable row level security;
alter table public.screens enable row level security;
alter table public.screen_credentials enable row level security;
alter table public.pairing_codes enable row level security;
alter table public.schedule_entries enable row level security;
alter table public.screen_heartbeats enable row level security;
alter table public.sync_manifests enable row level security;
alter table public.configuration_versions enable row level security;
alter table public.media_uploads enable row level security;
alter table public.pairing_rate_limits enable row level security;

-- Users may only read their own basic profile. Role changes require trusted server/SQL administration.
drop policy if exists profiles_read_self on public.profiles;
create policy profiles_read_self on public.profiles for select to authenticated using (id = auth.uid());

-- Storage is private. No public policies are created; server-generated S3 signed URLs are short-lived.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('signage-media', 'signage-media', false, 2147483648, array['image/jpeg','image/png','image/webp','video/mp4'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Keep only recent heartbeat history; run this as a scheduled maintenance task.
create or replace function public.prune_screen_heartbeats(p_before timestamptz default now() - interval '30 days')
returns bigint language plpgsql security definer set search_path = public as $$
declare deleted_count bigint;
begin
  delete from public.screen_heartbeats where received_at < p_before;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- Least privilege for exposed Postgres roles. These RPCs are called only by the server service role.
revoke all on function public.consume_pairing_code(text, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.consume_pairing_rate_limit(text, timestamptz) from public, anon, authenticated;
revoke all on function public.save_sync_manifest(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.save_playlist_revision(uuid, text, boolean, jsonb, boolean, uuid) from public, anon, authenticated;
revoke all on function public.prune_screen_heartbeats(timestamptz) from public, anon, authenticated;
revoke all on function public.get_media_usage_counts(uuid[]) from public, anon, authenticated;
grant execute on function public.consume_pairing_code(text, text, jsonb, timestamptz) to service_role;
grant execute on function public.consume_pairing_rate_limit(text, timestamptz) to service_role;
grant execute on function public.save_sync_manifest(uuid, text, jsonb) to service_role;
grant execute on function public.save_playlist_revision(uuid, text, boolean, jsonb, boolean, uuid) to service_role;
grant execute on function public.prune_screen_heartbeats(timestamptz) to service_role;
grant execute on function public.get_media_usage_counts(uuid[]) to service_role;
