import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, HttpError, requireAdmin } from '@/lib/server/http';

export const runtime = 'nodejs';
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  try {
    const { db, user } = await requireAdmin(request);
    if (user.role !== 'admin') throw new HttpError(403, 'يتطلب دور المدير.', 'admin_required');

    const { id } = await context.params;
    const { error } = await db.rpc('publish_submission', {
      p_submission_id: id,
      p_admin_id: user.id,
    });
    if (error) throw error;

    return NextResponse.json({ ok: true, message: 'تم نشر المشاركة.' });
  } catch (error) { return errorResponse(error); }
}