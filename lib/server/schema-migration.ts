import { Client } from 'pg';
import { probeSchema } from '@/lib/server/device-status';
import { resetScreenHealthColumnCache } from '@/lib/server/screen-health';

export const PLAYER_HEALTH_MIGRATION_SQL = `
alter table public.screens add column if not exists player_state text
  check (player_state is null or player_state in
    ('boot', 'register', 'sync', 'online', 'degraded', 'reconnecting', 'recovering',
     'controlled_reload', 'offline', 'auth_error', 'config_error'));
alter table public.screens add column if not exists player_state_since timestamptz;

alter table public.screens add column if not exists last_applied_sync_version integer not null default 0
  check (last_applied_sync_version >= 0);
alter table public.screens add column if not exists last_applied_reload_version integer not null default 0
  check (last_applied_reload_version >= 0);

alter table public.screens add column if not exists recovery_count integer not null default 0
  check (recovery_count >= 0);
alter table public.screens add column if not exists last_recovery_at timestamptz;
alter table public.screens add column if not exists last_recovery_reason text;
alter table public.screens add column if not exists last_recovery_state text;

alter table public.screens add column if not exists last_health_status text;
alter table public.screens add column if not exists last_health_checked_at timestamptz;

alter table public.screens add column if not exists last_boot_at timestamptz;
alter table public.screens add column if not exists boot_count integer not null default 0
  check (boot_count >= 0);

create index if not exists screens_player_state_idx on public.screens(player_state);

notify pgrst, 'reload schema';
`.trim();

const DB_URL_ENV_KEYS = [
  'SUPABASE_DB_URL',
  'DATABASE_URL',
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
] as const;

export function availableDbEnvKeys(env: Record<string, string | undefined> = process.env): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of DB_URL_ENV_KEYS) {
    out[key] = Boolean(typeof env[key] === 'string' && env[key]!.trim());
  }
  return out;
}

export function resolveDatabaseUrl(env: Record<string, string | undefined> = process.env): { key: string; url: string } | null {
  for (const key of DB_URL_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) {
      return { key, url: value.trim() };
    }
  }
  return null;
}

export type PlayerHealthMigrationResult = {
  status: 'already_applied' | 'applied' | 'missing_db_url' | 'failed';
  sourceKey: string | null;
  dbEnvPresent: Record<string, boolean>;
  deviceInfoFallbackActive: boolean;
  playerHealthColumnsPresent: number;
  playerHealthColumnsExpected: number;
  error: string | null;
};

export async function ensurePlayerHealthSchema(
  db: any,
  env: Record<string, string | undefined> = process.env,
): Promise<PlayerHealthMigrationResult> {
  const dbEnvPresent = availableDbEnvKeys(env);
  const initial = await probeSchema(db);
  if (initial.playerHealthColumnsPresent === initial.playerHealthColumnsExpected) {
    return {
      status: 'already_applied',
      sourceKey: null,
      dbEnvPresent,
      deviceInfoFallbackActive: true,
      playerHealthColumnsPresent: initial.playerHealthColumnsPresent,
      playerHealthColumnsExpected: initial.playerHealthColumnsExpected,
      error: null,
    };
  }

  const resolved = resolveDatabaseUrl(env);
  if (!resolved) {
    return {
      status: 'missing_db_url',
      sourceKey: null,
      dbEnvPresent,
      deviceInfoFallbackActive: true,
      playerHealthColumnsPresent: initial.playerHealthColumnsPresent,
      playerHealthColumnsExpected: initial.playerHealthColumnsExpected,
      error: 'No direct Postgres connection string (SUPABASE_DB_URL / DATABASE_URL / POSTGRES_URL) is configured in environment; device_info.telemetry fallback is active.',
    };
  }

  const client = new Client({
    connectionString: resolved.url,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });

  try {
    await client.connect();
    await client.query(PLAYER_HEALTH_MIGRATION_SQL);
    resetScreenHealthColumnCache();
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : 'migration query failed';
    return {
      status: 'failed',
      sourceKey: resolved.key,
      dbEnvPresent,
      deviceInfoFallbackActive: true,
      playerHealthColumnsPresent: initial.playerHealthColumnsPresent,
      playerHealthColumnsExpected: initial.playerHealthColumnsExpected,
      error: message,
    };
  } finally {
    try { await client.end(); } catch { /* ignore close error */ }
  }

  const after = await probeSchema(db);
  return {
    status: after.playerHealthColumnsPresent === after.playerHealthColumnsExpected ? 'applied' : 'failed',
    sourceKey: resolved.key,
    dbEnvPresent,
    deviceInfoFallbackActive: true,
    playerHealthColumnsPresent: after.playerHealthColumnsPresent,
    playerHealthColumnsExpected: after.playerHealthColumnsExpected,
    error: after.playerHealthColumnsPresent === after.playerHealthColumnsExpected
      ? null
      : 'DDL executed, waiting for PostgREST schema cache reload.',
  };
}
