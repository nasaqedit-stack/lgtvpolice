#!/usr/bin/env node
/**
 * Reads the LIVE state of every paired screen from a deployment and prints it for CI.
 *
 * This is the missing half of "does the fix work on the real television?". Unit tests exercise
 * mocks and the production E2E can only see HTTP endpoints; neither can tell you whether the
 * LG in the lobby downloaded its media, activated the manifest and is rendering it right now.
 * That evidence lives in the database, and the database is only reachable from the application.
 *
 * The script therefore calls `GET /api/diag/device` on the deployment and authenticates with the
 * OIDC identity token GitHub issues to this workflow run (no shared secret, nothing stored in the
 * repository). The route verifies the token against GitHub's public JWKS and refuses any caller
 * that is not this repository.
 *
 * Usage (inside GitHub Actions; needs `permissions: id-token: write`):
 *   APP_ORIGIN=https://lgtvpolice.vercel.app node scripts/device-status.mjs
 *
 * Locally it degrades: without the Actions OIDC environment it prints the instructions instead of
 * inventing credentials.
 */
const ORIGIN = (process.env.APP_ORIGIN || 'https://lgtvpolice.vercel.app').replace(/\/+$/, '');
const AUDIENCE = process.env.DEVICE_DIAG_AUDIENCE || process.env.DIAG_AUDIENCE || 'lgtvpolice-device-diag';

function annotate(title, text) {
  const escaped = String(text)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
  console.log(`::notice title=${title}::${escaped}`);
}

function chunkAnnotate(title, text, size = 2600) {
  const total = Math.max(1, Math.ceil(text.length / size));
  for (let index = 0; index < total; index += 1) {
    annotate(`${title} (${index + 1}/${total})`, text.slice(index * size, (index + 1) * size));
  }
}

function summarize(status) {
  const lines = [];
  const age = (ms) => {
    if (ms === null || ms === undefined) return 'never';
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
    if (minutes < 90) return `${minutes}m ago`;
    return `${Math.round(minutes / 60)}h ago`;
  };
  lines.push(`deployment: player=${status.deployment?.playerVersion} runtime=${status.deployment?.runtimeVersion} env=${status.deployment?.vercelEnv || '?'} sha=${String(status.deployment?.gitSha || '').slice(0, 7)}`);
  lines.push(`counts: screens=${status.counts?.screens} playlists=${status.counts?.playlists} media=${status.counts?.media}`);
  if (status.schema) {
    lines.push(`schema: player-health columns ${status.schema.playerHealthColumnsPresent}/${status.schema.playerHealthColumnsExpected} present` +
      (status.schema.complete ? '' : ` MISSING: ${Object.entries(status.schema.columns).filter(([, ok]) => !ok).map(([name]) => name).join(', ') || 'none'}` +
        ` | tables: ${Object.entries(status.schema.tables).map(([name, ok]) => `${name}=${ok ? 'yes' : 'NO'}`).join(' ')}`));
  }
  if (status.storage) {
    lines.push(`storage: bucket=${status.storage.bucket} objects=${status.storage.objectCount} bytes=${status.storage.totalBytes}${status.storage.error ? ` error=${status.storage.error}` : ''}`);
  }
  for (const screen of status.screens || []) {
    const h = screen.health || {};
    lines.push('');
    lines.push(`screen "${screen.name}" (${screen.id.slice(0, 8)}) enabled=${screen.enabled} pairedAt=${screen.pairedAt || 'never'}`);
    lines.push(`  status=${h.status} playerState=${h.playerState || '-'} heartbeat=${age(h.heartbeatAgeMs)} lastSync=${age(h.lastSyncAgeMs)}`);
    lines.push(`  syncStatus=${h.syncStatus} syncError=${h.syncError || '(none)'}`);
    lines.push(`  version: reported player=${screen.reportedPlayerVersion || 'unknown'} runtime=${screen.reportedRuntimeVersion || 'unknown'} | served player=${status.deployment?.playerVersion} runtime=${status.deployment?.runtimeVersion}`);
    lines.push(`  cachedMedia=${h.cachedMediaCount} storageBytes=${h.storageUsageBytes} playlist=${h.currentPlaylistId ? String(h.currentPlaylistId).slice(0, 8) + '@' + h.currentPlaylistVersion : 'none'} item=${h.currentItemId ? String(h.currentItemId).slice(0, 8) : 'none'}`);
    lines.push(`  commands pending=${h.commands?.pending} issued=${JSON.stringify(h.commands?.issued)} applied=${JSON.stringify(h.commands?.applied)}`);
    lines.push(`  credentials active=${screen.credentials?.active} revoked=${screen.credentials?.revoked} lastUsed=${screen.credentials?.lastUsedAt || 'never'}`);
    lines.push(`  manifest v${screen.manifest?.latestVersion ?? '-'} age=${age(screen.manifest?.ageMs)} assets=${screen.manifest?.assetCount ?? '-'}`);
    const device = screen.deviceInfo || {};
    lines.push(`  device: ${device.userAgent || 'unknown UA'} | ${device.screenWidth}x${device.screenHeight} ${device.language || ''}`);
    if (screen.heartbeatTotals) lines.push(`  heartbeats stored: total=${screen.heartbeatTotals.total} last24h=${screen.heartbeatTotals.last24h}`);
    for (const code of (screen.pairingCodes || []).slice(0, 5)) {
      lines.push(`  pairing code: created=${code.createdAt} used=${code.usedAt || 'not used'} attempts=${code.attempts}`);
    }
    for (const beat of (screen.heartbeats || []).slice(0, 5)) {
      lines.push(`  beat ${age(beat.ageMs)}: ${beat.syncStatus} err=${beat.syncError || '-'} cached=${beat.cachedMediaCount} item=${beat.currentItemId ? String(beat.currentItemId).slice(0, 8) : '-'} player=${beat.deviceInfo?.playerVersion || '?'}/${beat.deviceInfo?.runtimeVersion || '?'}`);
    }
  }
  return lines.join('\n');
}

async function actionsToken() {
  const raw = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!raw || !requestToken) return null;
  // The audience is requested by adding it to the URL GitHub hands the job; the route only accepts
  // tokens whose `aud` claim is exactly this value, so a token minted for another purpose is refused.
  const url = new URL(raw);
  url.searchParams.set('audience', AUDIENCE);
  const response = await fetch(url, { headers: { Authorization: `bearer ${requestToken}` } });
  if (!response.ok) throw new Error(`OIDC token request failed: HTTP ${response.status}`);
  const body = await response.json();
  if (!body || typeof body.value !== 'string') throw new Error('OIDC token response had no value');
  return body.value;
}

async function main() {
  const token = await actionsToken();
  if (!token) {
    console.log('No GitHub Actions OIDC environment found. Run this from a workflow with');
    console.log('`permissions: id-token: write`, or call the route with a token of your own:');
    console.log(`  curl -H "Authorization: Bearer <oidc-token>" ${ORIGIN}/api/diag/device`);
    process.exitCode = 2;
    return;
  }
  const url = `${ORIGIN}/api/diag/device`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, accept: 'application/json' } });
  const raw = await response.text();
  let status = null;
  try { status = raw ? JSON.parse(raw) : null; } catch { status = null; }

  console.log(`GET ${url} -> HTTP ${response.status}`);
  if (!response.ok) {
    console.log(raw.slice(0, 2000));
    annotate('Device status request failed', `HTTP ${response.status} ${raw.slice(0, 1200)}`);
    process.exitCode = 1;
    return;
  }

  const report = summarize(status);
  console.log(report);
  if (status.errors) console.log(`\ncollection errors:\n- ${status.errors.join('\n- ')}`);
  annotate('Device status summary', report);
  chunkAnnotate('Device status JSON', JSON.stringify(status, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['```', report, '```', ''].join('\n'));
  }
}

main().catch((error) => {
  console.error(error);
  annotate('Device status script failed', String(error && error.message ? error.message : error).slice(0, 1000));
  process.exitCode = 1;
});
