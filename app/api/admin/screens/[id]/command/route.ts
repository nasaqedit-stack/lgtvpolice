import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, requireAdmin, readJson } from '@/lib/server/http';

type Context = { params: Promise<{ id: string }> };
const schema = z.object({ command: z.enum(['sync', 'reload']) }).strict();
export async function POST(request: NextRequest, context: Context) {
  try {
    const { db } = await requireAdmin(request);
    const { id } = await context.params;
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'نوع الأمر غير صالح.', 'validation_error');
    const column = parsed.data.command === 'sync' ? 'sync_command_version' : 'reload_command_version';
    const { data: screen, error } = await db.from('screens').select(column).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!screen) throw new HttpError(404, 'الشاشة غير موجودة.', 'not_found');
    const current = Number((screen as any)[column] ?? 0);
    const { error: updateError } = await db.from('screens').update({ [column]: current + 1, updated_at: new Date().toISOString() }).eq('id', id);
    if (updateError) throw updateError;
    return NextResponse.json({ ok: true, version: current + 1 });
  } catch (error) { return errorResponse(error); }
}
