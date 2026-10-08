-- 24/7 self-healing player: server-side player health, command acknowledgement and recovery state.
--
-- Apply with `supabase db push` (or paste into the SQL editor) exactly like the initial migration.
-- Until this migration is applied the application keeps working: every read of these columns goes
-- through `lib/server/screen-health.ts`, which falls back to the base columns when they are absent.

alter table public.screens add column if not exists player_state text
  check (player_state is null or player_state in
    ('boot', 'register', 'sync', 'online', 'degraded', 'reconnecting', 'recovering',
     'controlled_reload', 'offline', 'auth_error', 'config_error'));
alter table public.screens add column if not exists player_state_since timestamptz;

-- Command acknowledgement: the last command version the television actually executed and reported
-- back through an authenticated heartbeat. Never advanced by the server, only by the player.
alter table public.screens add column if not exists last_applied_sync_version integer not null default 0
  check (last_applied_sync_version >= 0);
alter table public.screens add column if not exists last_applied_reload_version integer not null default 0
  check (last_applied_reload_version >= 0);

-- Recovery bookkeeping: how often the player had to heal itself, when, and why.
alter table public.screens add column if not exists recovery_count integer not null default 0
  check (recovery_count >= 0);
alter table public.screens add column if not exists last_recovery_at timestamptz;
alter table public.screens add column if not exists last_recovery_reason text;
alter table public.screens add column if not exists last_recovery_state text;

-- Result of the player's daily self-check (operational code only; never a secret or a URL).
alter table public.screens add column if not exists last_health_status text;
alter table public.screens add column if not exists last_health_checked_at timestamptz;

-- Boot bookkeeping: distinguishes "the TV restarted" from "the player healed in place".
alter table public.screens add column if not exists last_boot_at timestamptz;
alter table public.screens add column if not exists boot_count integer not null default 0
  check (boot_count >= 0);

create index if not exists screens_player_state_idx on public.screens(player_state);
