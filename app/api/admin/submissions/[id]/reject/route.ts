import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, readJson, requireAdmin } from '@/lib/server/http';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

const schema = z.object({
  reason: z.string().trim().min(1).max(1000),
}).strict();

export async function POST(request: NextRequest, context: Context) {
  try {
    const { db, user } = await requireAdmin(request);
    const { id } = await context.params;
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'يجب تقديم سبب الرفض.', 'reason_required');

    const { error } = await db.rpc('reject_submission', {
      p_submission_id: id,
      p_admin_id: user.id,
      p_reason: parsed.data.reason,
    });
    if (error) throw error;

    return NextResponse.json({ ok: true, message: 'تم رفض المشاركة.' });
  } catch (error) { return errorResponse(error); }
}