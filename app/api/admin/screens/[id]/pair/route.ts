import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, requireAdmin, readJson } from '@/lib/server/http';
import { issuePairingCode } from '@/lib/server/pairing';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };
const schema = z.object({ rotate: z.boolean().optional().default(false) }).strict();

export async function POST(request: NextRequest, context: Context) {
  try {
    const { db, user } = await requireAdmin(request);
    const { id } = await context.params;
    const body = schema.safeParse(await readJson(request));
    if (!body.success) throw new HttpError(400, 'بيانات الطلب غير صحيحة.', 'validation_error');
    const { data: screen, error } = await db.from('screens').select('id').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!screen) throw new HttpError(404, 'الشاشة غير موجودة.', 'not_found');
    if (body.data.rotate) {
      await db.from('screen_credentials').update({ revoked_at: new Date().toISOString() }).eq('screen_id', id).is('revoked_at', null);
    }
    const pairing = await issuePairingCode(db, id, user.id);
    return NextResponse.json(pairing);
  } catch (error) { return errorResponse(error); }
}
