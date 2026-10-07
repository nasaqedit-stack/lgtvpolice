import { createHash, randomInt } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

// Shared between the pairing and heartbeat endpoints. Unknown keys are stripped (not rejected)
// so new client-side device metadata can never invalidate a pairing request; the request body
// itself stays strict. This previously rejected the player's `language` field and made every
// fresh pairing code fail with `invalid_pairing_code` before it ever reached the database.
export const deviceInfoSchema = z.object({
  userAgent: z.string().max(500).optional(),
  platform: z.string().max(120).optional(),
  screenWidth: z.number().int().min(0).max(20000).optional(),
  screenHeight: z.number().int().min(0).max(20000).optional(),
  language: z.string().max(30).optional(),
});
export const pairRequestSchema = z.object({
  code: z.string().min(6).max(16),
  deviceInfo: deviceInfoSchema.optional(),
}).strict();

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
