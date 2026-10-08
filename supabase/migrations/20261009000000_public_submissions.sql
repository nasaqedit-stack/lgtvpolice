-- Public Submissions schema for Supabase/Postgres
create extension if not exists pgcrypto;

-- Submissions table
create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete set null,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  title text not null check (char_length(title) between 1 and 240),
  description text,
  contributor_name text check (char_length(contributor_name) <= 120),
  contributor_email text check (contributor_email ~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'),
  contributor_phone text check (char_length(contributor_phone) <= 30),
  consent_accepted boolean not null default false,
  consent_version text not null default '1.0',
  consent_text text not null,
  consent_accepted_at timestamptz,
  state text not null default 'DRAFT' check (state in ('DRAFT', 'SUBMITTED', 'PROCESSING', 'READY_FOR_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'ARCHIVED')),
  rejection_reason text,
  original_media_id uuid references public.media(id) on delete restrict,
  optimized_media_id uuid references public.media(id) on delete set null,
  thumbnail_media_id uuid references public.media(id) on delete set null,
  processing_error text,
  processing_started_at timestamptz,
  processing_completed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  published_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists submissions_state_idx on public.submissions(state);
create index if not exists submissions_org_idx on public.submissions(organization_id, state, created_at desc);
create index if not exists submissions_token_idx on public.submissions(token_hash);

-- Submission events (audit log) - immutable
create table if not exists public.submission_events (
  id bigint generated always as identity primary key,
  submission_id uuid not null references public.submissions(id) on delete cascade,
  actor uuid references auth.users(id) on delete set null,
  actor_type text not null check (actor_type in ('contributor', 'admin', 'system')),
  from_state text check (from_state in ('DRAFT', 'SUBMITTED', 'PROCESSING', 'READY_FOR_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'ARCHIVED')),
  to_state text not null check (to_state in ('DRAFT', 'SUBMITTED', 'PROCESSING', 'READY_FOR_REVIEW', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'ARCHIVED')),
  reason text,
  ip_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists submission_events_submission_idx on public.submission_events(submission_id, created_at desc);

-- Prevent UPDATE and DELETE on audit log
create or replace function public.prevent_submission_events_mutation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'submission_events is append-only: UPDATE and DELETE are not allowed';
end;
$$;

drop trigger if exists submission_events_no_update on public.submission_events;
create trigger submission_events_no_update
before update on public.submission_events
for each row execute procedure public.prevent_submission_events_mutation();

drop trigger if exists submission_events_no_delete on public.submission_events;
create trigger submission_events_no_delete
before delete on public.submission_events
for each row execute procedure public.prevent_submission_events_mutation();

-- Rate limiting for public submissions
create table if not exists public.submission_rate_limits (
  key_hash text not null,
  bucket_start timestamptz not null,
  attempts integer not null default 0,
  primary key (key_hash, bucket_start)
);

-- Submission tokens (public access tokens)
create table if not exists public.submission_tokens (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz,
  max_submissions integer,
  submission_count integer not null default 0,
  enabled boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists submission_tokens_org_idx on public.submission_tokens(organization_id, enabled);

-- Function to create a submission token (admin only)
create or replace function public.create_submission_token(
  p_organization_id uuid,
  p_name text,
  p_expires_at timestamptz default null,
  p_max_submissions integer default null,
  p_created_by uuid default null
) returns table(id uuid, token text, token_hash text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  raw_token text;
  token_hash text;
  token_id uuid;
begin
  raw_token := encode(gen_random_bytes(32), 'hex');
  token_hash := encode(digest(raw_token, 'sha256'), 'hex');
  insert into public.submission_tokens(organization_id, name, token_hash, expires_at, max_submissions, created_by)
  values (p_organization_id, p_name, token_hash, p_expires_at, p_max_submissions, p_created_by)
  returning id, expires_at into token_id, p_expires_at;
  return query select token_id, raw_token, token_hash, p_expires_at;
end;
$$;

revoke all on function public.create_submission_token(uuid, text, timestamptz, integer, uuid) from public, anon, authenticated;
grant execute on function public.create_submission_token(uuid, text, timestamptz, integer, uuid) to service_role;

-- Function to validate submission token and consume rate limit
create or replace function public.validate_submission_token(
  p_token_hash text,
  p_ip_hash text,
  p_now timestamptz default now()
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  found_token public.submission_tokens%rowtype;
  window_start timestamptz;
  attempt_count integer;
  salt text;
begin
  -- Find valid token
  select * into found_token from public.submission_tokens
    where token_hash = p_token_hash and enabled
    and (expires_at is null or expires_at > p_now)
    and (max_submissions is null or submission_count < max_submissions)
    for update;
  if not found then return null; end if;

  -- Rate limit per IP per 10-minute window (similar to pairing)
  salt := current_setting('app.submission_rate_limit_salt', true);
  if salt is null or salt = '' then
    salt := current_setting('app.pairing_rate_limit_salt', true);
  end if;
  if salt is null or salt = '' then
    raise exception 'Submission rate limit salt not configured';
  end if;

  window_start := date_trunc('minute', p_now) - ((extract(minute from p_now)::integer % 10) * interval '1 minute');
  insert into public.submission_rate_limits(key_hash, bucket_start, attempts)
    values (encode(digest(p_ip_hash || salt, 'sha256'), 'hex'), window_start, 1)
  on conflict (key_hash, bucket_start) do update set attempts = public.submission_rate_limits.attempts + 1
  returning attempts into attempt_count;
  delete from public.submission_rate_limits where bucket_start < p_now - interval '1 day';

  if attempt_count > 8 then
    raise exception 'Rate limit exceeded';
  end if;

  return found_token.id;
end;
$$;

revoke all on function public.validate_submission_token(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.validate_submission_token(text, text, timestamptz) to service_role;

-- Function to create a submission
create or replace function public.create_submission(
  p_token_id uuid,
  p_title text,
  p_description text,
  p_contributor_name text,
  p_contributor_email text,
  p_contributor_phone text,
  p_consent_accepted boolean,
  p_consent_version text,
  p_consent_text text,
  p_ip_hash text,
  p_now timestamptz default now()
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  submission_id uuid;
  token_row public.submission_tokens%rowtype;
begin
  -- Validate token and get organization
  select * into token_row from public.submission_tokens
    where id = p_token_id and enabled
    and (expires_at is null or expires_at > p_now)
    and (max_submissions is null or submission_count < max_submissions)
    for update;
  if not found then raise exception 'Invalid or expired token'; end if;

  if not p_consent_accepted then
    raise exception 'Consent must be accepted';
  end if;
  if p_consent_text is null or p_consent_text = '' then
    raise exception 'Consent text is required';
  end if;
  if p_consent_version is null or p_consent_version = '' then
    raise exception 'Consent version is required';
  end if;

  -- Create submission
  insert into public.submissions(
    organization_id, token_hash, title, description,
    contributor_name, contributor_email, contributor_phone,
    consent_accepted, consent_version, consent_text, consent_accepted_at,
    state, ip_hash
  )
  values (
    token_row.organization_id,
    (select token_hash from public.submission_tokens where id = p_token_id),
    trim(p_title), trim(p_description),
    trim(p_contributor_name), trim(p_contributor_email), trim(p_contributor_phone),
    true, p_consent_version, p_consent_text, p_now,
    'SUBMITTED', p_ip_hash
  )
  returning id into submission_id;

  -- Increment token submission count
  update public.submission_tokens set submission_count = submission_count + 1 where id = p_token_id;

  -- Audit event
  insert into public.submission_events(submission_id, actor_type, from_state, to_state, reason, ip_hash)
  values (submission_id, 'contributor', 'DRAFT', 'SUBMITTED', 'Submitted via public link', p_ip_hash);

  return submission_id;
end;
$$;

revoke all on function public.create_submission(uuid, text, text, text, text, text, boolean, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.create_submission(uuid, text, text, text, text, text, boolean, text, text, text, timestamptz) to service_role;

-- Function to start processing a submission
create or replace function public.start_submission_processing(
  p_submission_id uuid,
  p_now timestamptz default now()
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.submissions
  set state = 'PROCESSING', processing_started_at = p_now, updated_at = p_now
  where id = p_submission_id and state = 'SUBMITTED';
  if not found then raise exception 'Submission not found or not in SUBMITTED state'; end if;
  insert into public.submission_events(submission_id, actor_type, from_state, to_state, reason)
  values (p_submission_id, 'system', 'SUBMITTED', 'PROCESSING', 'Media processing started');
end;
$$;

revoke all on function public.start_submission_processing(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.start_submission_processing(uuid, timestamptz) to service_role;

-- Function to complete processing
create or replace function public.complete_submission_processing(
  p_submission_id uuid,
  p_original_media_id uuid,
  p_optimized_media_id uuid,
  p_thumbnail_media_id uuid,
  p_now timestamptz default now()
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.submissions
  set state = 'READY_FOR_REVIEW',
      original_media_id = p_original_media_id,
      optimized_media_id = p_optimized_media_id,
      thumbnail_media_id = p_thumbnail_media_id,
      processing_completed_at = p_now,
      updated_at = p_now
  where id = p_submission_id and state = 'PROCESSING';
  if not found then raise exception 'Submission not found or not in PROCESSING state'; end if;
  insert into public.submission_events(submission_id, actor_type, from_state, to_state, reason)
  values (p_submission_id, 'system', 'PROCESSING', 'READY_FOR_REVIEW', 'Media processing completed');
end;
$$;

revoke all on function public.complete_submission_processing(uuid, uuid, uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.complete_submission_processing(uuid, uuid, uuid, uuid, timestamptz) to service_role;

-- Function to fail processing
create or replace function public.fail_submission_processing(
  p_submission_id uuid,
  p_error text,
  p_now timestamptz default now()
) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.submissions
  set state = 'SUBMITTED',
      processing_error = p_error,
      processing_completed_at = p_now,
      updated_at = p_now
  where id = p_submission_id and state = 'PROCESSING';
  if not found then raise exception 'Submission not found or not in PROCESSING state'; end if;
  insert into public.submission_events(submission_id, actor_type, from_state, to_state, reason, metadata)
  values (p_submission_id, 'system', 'PROCESSING', 'SUBMITTED', 'Media processing failed', jsonb_build_object('error', p_error));
end;
$$;

revoke all on function public.fail_submission_processing(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.fail_submission_processing(uuid, text, timestamptz) to service_role;

-- Function to approve submission (admin only)
create or replace function public.approve_submission(
  p_submission_id uuid,
  p_admin_id uuid,
  p_confirm boolean,
  p_now timestamptz default now()
) returns void
language plpgsql security definer set search_path = public as $$
declare
  submission_row public.submissions%rowtype;
begin
  if not p_confirm then raise exception 'Confirmation required'; end if;

  select * into submission_row from public.submissions where id = p_submission_id for update;
  if not found then raise exception 'Submission not found'; end if;

  if not submission_row.consent_accepted then
    raise exception 'Contributor consent not recorded';
  end if;
  if submission_row.optimized_media_id is null then
    raise exception 'Media processing not completed';
  end if;
  if submission_row.state = 'APPROVED' then
    raise exception 'Submission already approved';
  end if;
  if submission_row.state not in ('READY_FOR_REVIEW', 'UNDER_REVIEW') then
    raise exception 'Submission not ready for approval';
  end if;

  update public.submissions
  set state = 'APPROVED',
      approved_by = p_admin_id,
      approved_at = p_now,
      updated_at = p_now
  where id = p_submission_id;

  insert into public.submission_events(submission_id, actor, actor_type, from_state, to_state, reason)
  values (p_submission_id, p_admin_id, 'admin', submission_row.state, 'APPROVED', 'Final admin approval');
end;
$$;

revoke all on function public.approve_submission(uuid, uuid, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.approve_submission(uuid, uuid, boolean, timestamptz) to service_role;

-- Function to reject submission (admin only)
create or replace function public.reject_submission(
  p_submission_id uuid,
  p_admin_id uuid,
  p_reason text,
  p_now timestamptz default now()
) returns void
language plpgsql security definer set search_path = public as $$
declare
  submission_row public.submissions%rowtype;
begin
  select * into submission_row from public.submissions where id = p_submission_id for update;
  if not found then raise exception 'Submission not found'; end if;
  if submission_row.state in ('APPROVED', 'PUBLISHED', 'ARCHIVED') then
    raise exception 'Cannot reject approved/published/archived submission';
  end if;

  update public.submissions
  set state = 'REJECTED',
      rejection_reason = p_reason,
      reviewed_by = p_admin_id,
      reviewed_at = p_now,
      updated_at = p_now
  where id = p_submission_id;

  insert into public.submission_events(submission_id, actor, actor_type, from_state, to_state, reason)
  values (p_submission_id, p_admin_id, 'admin', submission_row.state, 'REJECTED', p_reason);
end;
$$;

revoke all on function public.reject_submission(uuid, uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.reject_submission(uuid, uuid, text, timestamptz) to service_role;

-- Function to publish submission
create or replace function public.publish_submission(
  p_submission_id uuid,
  p_admin_id uuid,
  p_now timestamptz default now()
) returns void
language plpgsql security definer set search_path = public as $$
declare
  submission_row public.submissions%rowtype;
begin
  select * into submission_row from public.submissions where id = p_submission_id for update;
  if not found then raise exception 'Submission not found'; end if;
  if submission_row.state <> 'APPROVED' then
    raise exception 'Only approved submissions can be published';
  end if;

  update public.submissions
  set state = 'PUBLISHED',
      published_at = p_now,
      updated_at = p_now
  where id = p_submission_id;

  insert into public.submission_events(submission_id, actor, actor_type, from_state, to_state, reason)
  values (p_submission_id, p_admin_id, 'admin', 'APPROVED', 'PUBLISHED', 'Published after approval');
end;
$$;

revoke all on function public.publish_submission(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.publish_submission(uuid, uuid, timestamptz) to service_role;

-- Function to archive submission
create or replace function public.archive_submission(
  p_submission_id uuid,
  p_admin_id uuid,
  p_now timestamptz default now()
) returns void
language plpgsql security definer set search_path = public as $$
declare
  submission_row public.submissions%rowtype;
begin
  select * into submission_row from public.submissions where id = p_submission_id for update;
  if not found then raise exception 'Submission not found'; end if;
  if submission_row.state = 'ARCHIVED' then
    raise exception 'Already archived';
  end if;

  update public.submissions
  set state = 'ARCHIVED',
      archived_at = p_now,
      updated_at = p_now
  where id = p_submission_id;

  insert into public.submission_events(submission_id, actor, actor_type, from_state, to_state, reason)
  values (p_submission_id, p_admin_id, 'admin', submission_row.state, 'ARCHIVED', 'Archived by admin');
end;
$$;

revoke all on function public.archive_submission(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.archive_submission(uuid, uuid, timestamptz) to service_role;

-- RLS policies
alter table public.submissions enable row level security;
alter table public.submission_events enable row level security;
alter table public.submission_rate_limits enable row level security;
alter table public.submission_tokens enable row level security;

-- No public access to submissions - all through server routes with service role
drop policy if exists submissions_no_public on public.submissions;
create policy submissions_no_public on public.submissions for all to public using (false);

drop policy if exists submission_events_no_public on public.submission_events;
create policy submission_events_no_public on public.submission_events for all to public using (false);

drop policy if exists submission_rate_limits_no_public on public.submission_rate_limits;
create policy submission_rate_limits_no_public on public.submission_rate_limits for all to public using (false);

drop policy if exists submission_tokens_no_public on public.submission_tokens;
create policy submission_tokens_no_public on public.submission_tokens for all to public using (false);

-- Service role access for server routes
grant all on public.submissions to service_role;
grant all on public.submission_events to service_role;
grant all on public.submission_rate_limits to service_role;
grant all on public.submission_tokens to service_role;