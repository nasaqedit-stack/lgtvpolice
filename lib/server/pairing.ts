import { createHash, randomInt } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function normalizedPairingCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
export function hashHex(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
export function makePairingCode() {
  const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return { raw, display: `${raw.slice(0, 4)}-${raw.slice(4)}`, hash: hashHex(raw) };
}
export async function issuePairingCode(db: SupabaseClient, screenId: string, userId: string) {
  const { error: expireError } = await db.from('pairing_codes').update({ used_at: new Date().toISOString() }).eq('screen_id', screenId).is('used_at', null);
  if (expireError) throw expireError;
  const code = makePairingCode();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const { error } = await db.from('pairing_codes').insert({
    screen_id: screenId,
    code_hash: code.hash,
    expires_at: expiresAt,
    created_by: userId,
  });
  if (error) throw error;
  return { pairingCode: code.display, expiresAt };
}
