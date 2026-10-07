import { NextRequest, NextResponse } from 'next/server';
import { randomBytes, createHash } from 'node:crypto';
import { errorResponse, HttpError, readJson } from '@/lib/server/http';
import { createSupabaseAdmin } from '@/lib/server/supabase';
import { hashHex, normalizedPairingCode, pairRequestSchema } from '@/lib/server/pairing';

export const runtime = 'nodejs';
const schema = pairRequestSchema;

export async function POST(request: NextRequest) {
  try {
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'أدخل رمز ربط صالحاً.', 'invalid_pairing_code');
    const db = createSupabaseAdmin();
    const address = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim().slice(0, 120)
      || request.headers.get('x-real-ip')?.slice(0, 120) || 'unknown';
    const salt = process.env.PAIRING_RATE_LIMIT_SALT || process.env.SUPABASE_SERVICE_ROLE_KEY || 'local-only';
    const ipHash = createHash('sha256').update(`${salt}:${address}`).digest('hex');
    const { data: allowed, error: rateError } = await db.rpc('consume_pairing_rate_limit', { p_key_hash: ipHash });
    if (rateError) throw rateError;
    if (!allowed) throw new HttpError(429, 'محاولات كثيرة. انتظر عشر دقائق ثم حاول مجدداً.', 'rate_limited');

    const normalized = normalizedPairingCode(parsed.data.code);
    if (normalized.length !== 8) throw new HttpError(400, 'رمز الربط غير صالح أو منتهي.', 'invalid_pairing_code');
    const token = randomBytes(32).toString('base64url');
    const deviceInfo = {
      userAgent: parsed.data.deviceInfo?.userAgent ?? request.headers.get('user-agent')?.slice(0, 500) ?? 'unknown',
      platform: parsed.data.deviceInfo?.platform ?? 'browser',
      screenWidth: parsed.data.deviceInfo?.screenWidth ?? null,
      screenHeight: parsed.data.deviceInfo?.screenHeight ?? null,
    };
    const { data: screenId, error } = await db.rpc('consume_pairing_code', {
      p_code_hash: hashHex(normalized),
      p_token_hash: hashHex(token),
      p_device_info: deviceInfo,
    });
    if (error) throw error;
    if (!screenId) throw new HttpError(400, 'رمز الربط غير صالح أو منتهي أو تم استخدامه.', 'invalid_pairing_code');
    const { data: screen, error: screenError } = await db.from('screens').select('id,name,timezone').eq('id', screenId).single();
    if (screenError) throw screenError;
    return NextResponse.json({ credential: token, screen }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
