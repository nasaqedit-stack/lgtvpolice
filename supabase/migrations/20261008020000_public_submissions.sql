-- Public submission workflow: contributor submissions, explicit consent, media optimization,
-- admin review, FINAL ADMIN APPROVAL, publication and an append-only audit trail.
--
-- Model: PUBLIC AWARENESS / EDUCATIONAL content only. This system is NOT a channel for
-- classified, secret, confidential or restricted information; contributors must not upload it.
--
-- All tables are private: RLS is enabled and NO policies are created, so only the server
-- service role (Route Handlers) can read or write them. The browser never receives storage
-- credentials, and the public /submit/<token> link grants no admin or database access.

create table if not exists public.submission_links (
  id uuid primary key default gen_random_uuid(),
  -- Only the SHA-256 of the high-entropy token is stored (like screen credentials). The full
  -- URL is shown to the administrator once, at creation time.
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  label text not null check (char_length(label) between 1 and 120),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.submission_links(id) on delete restrict,
  title text not null check (char_length(title) between 1 and 240),
  description text not null default '',
  contributor_name text not null check (char_length(contributor_name) between 1 and 120),
  contributor_contact text not null check (char_length(contributor_contact) between 1 and 200),
  -- State machine: DRAFT -> SUBMITTED -> PROCESSING -> READY_FOR_REVIEW -> (UNDER_REVIEW) ->
  -- APPROVED -> PUBLISHED, with REJECTED and ARCHIVED branches. The default DRAFT is never
  -- public; only PUBLISHED is publicly visible.
  state text not null default 'DRAFT' check (state in ('DRAFT','SUBMITTED','PROCESSING','READY_FOR_REVIEW','UNDER_REVIEW','APPROVED','REJECTED','PUBLISHED','ARCHIVED')),
  version integer not null default 1 check (version >= 1),
  -- Explicit consent, recorded before a submission is accepted.
  consent_accepted boolean not null default false,
  consent_text text,
  consent_version text,
  consent_at timestamptz,
  -- Original contributor file (never modified after upload).
  kind text check (kind in ('image','video')),
  mime_type text check (mime_type in ('image/jpeg','image/png','image/webp','video/mp4','video/quicktime')),
  original_storage_path text,
  file_size bigint check (file_size > 0 and file_size <= 536870912),
  sha256 text check (sha256 ~ '^[a-f0-9]{64}$'),
  width integer,
  height integer,
  duration_ms integer,
  -- Media optimization pipeline state.
  processing_status text not null default 'pending' check (processing_status in ('pending','processing','completed','failed')),
  processing_error text,
  processing_attempts integer not null default 0,
  processing_started_at timestamptz,
  processing_completed_at timestamptz,
  -- Optimized delivery version + thumbnail (immutable, versioned object keys).
  optimized_storage_path text,
  optimized_mime_type text check (optimized_mime_type in ('image/webp','video/mp4')),
  optimized_file_size bigint,
  optimized_sha256 text check (optimized_sha256 ~ '^[a-f0-9]{64}$'),
  thumbnail_storage_path text,
  thumbnail_mime_type text,
  thumbnail_file_size bigint,
  -- Review / final approval / publication. Only server-side admin actions set these.
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  review_notes text,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  approved_version integer,
  rejection_reason text,
  published_media_id uuid references public.media(id) on delete set null,
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  unpublished_at timestamptz,
  archived_at timestamptz,
  -- Security metadata: salted IP hash only (raw IPs are never stored).
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists submissions_state_created_idx on public.submissions(state, created_at desc);
create index if not exists submissions_link_idx on public.submissions(link_id, created_at desc);
create index if not exists submissions_created_idx on public.submissions(created_at desc);

create table if not exists public.submission_uploads (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.submissions(id) on delete cascade,
  storage_path text not null unique,
  multipart_id text not null,
  file_name text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 536870912),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp','video/mp4','video/quicktime')),
  status text not null default 'uploading' check (status in ('uploading','completed','aborted')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists submission_uploads_submission_idx on public.submission_uploads(submission_id, status);

-- Append-only audit trail: every consent, state transition, approval and publication.
create table if not exists public.submission_events (
  id bigint generated always as identity primary key,
  submission_id uuid not null references public.submissions(id) on delete cascade,
  event text not null check (event in ('CONSENT_ACCEPTED','SUBMITTED','PROCESSING_STARTED','PROCESSING_COMPLETED','PROCESSING_FAILED','REVIEW_STARTED','CHANGES_REQUESTED','APPROVED','REJECTED','PUBLISHED','UNPUBLISHED','ARCHIVED')),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_role text,
  state_after text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists submission_events_submission_idx on public.submission_events(submission_id, id);

-- The audit trail is immutable at the database level: no UPDATE or DELETE is possible, for any
-- role, including by accident. History can only be appended.
create or replace function public.submission_events_immutable()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'submission_events is append-only: audit history cannot be modified or deleted';
end;
$$;
drop trigger if exists submission_events_immutable_trigger on public.submission_events;
create trigger submission_events_immutable_trigger
  before update or delete on public.submission_events
  for each row execute procedure public.submission_events_immutable();

create table if not exists public.submission_rate_limits (
  key_hash text not null,
  bucket_start timestamptz not null,
  attempts integer not null default 0,
  primary key (key_hash, bucket_start)
);

-- Sliding-window rate limiter for public submission endpoints (per link+IP and per IP).
create or replace function public.consume_submission_rate_limit(
  p_key_hash text,
  p_bucket_start timestamptz,
  p_limit integer
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  attempt_count integer;
begin
  insert into public.submission_rate_limits(key_hash, bucket_start, attempts)
  values (p_key_hash, p_bucket_start, 1)
  on conflict (key_hash, bucket_start) do update set attempts = public.submission_rate_limits.attempts + 1
  returning attempts into attempt_count;
  delete from public.submission_rate_limits where bucket_start < p_bucket_start - interval '1 day';
  return attempt_count <= p_limit;
end;
$$;

-- Private tables: no RLS policies are created for anon/authenticated. All access goes through
-- Route Handlers with the service role.
alter table public.submission_links enable row level security;
alter table public.submissions enable row level security;
alter table public.submission_uploads enable row level security;
alter table public.submission_events enable row level security;
alter table public.submission_rate_limits enable row level security;

revoke all on function public.submission_events_immutable() from public, anon, authenticated;
revoke all on function public.consume_submission_rate_limit(text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.consume_submission_rate_limit(text, timestamptz, integer) to service_role;
