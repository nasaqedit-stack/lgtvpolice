import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, readJson, requireAdmin } from '@/lib/server/http';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

const schema = z.object({
  confirm: z.literal(true),
}).strict();

export async function POST(request: NextRequest, context: Context) {
  try {
    const { db, user } = await requireAdmin(request);
    if (user.role !== 'admin') throw new HttpError(403, 'يتطلب دور المدير.', 'admin_required');

    const { id } = await context.params;
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'يجب تأكيد الاعتماد.', 'confirm_required');

    const { error } = await db.rpc('approve_submission', {
      p_submission_id: id,
      p_admin_id: user.id,
      p_confirm: true,
    });
    if (error) throw error;

    return NextResponse.json({ ok: true, message: 'تم اعتماد المشاركة نهائيًا.' });
  } catch (error) { return errorResponse(error); }
}