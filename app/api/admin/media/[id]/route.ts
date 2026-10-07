import { NextRequest, NextResponse } from 'next/server';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { errorResponse, HttpError, requireAdmin, readJson } from '@/lib/server/http';
import { getS3Client, storageConfig } from '@/lib/server/storage';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
const schema = z.object({ displayName: z.string().trim().min(1).max(240) }).strict();
export async function PATCH(request: NextRequest, context: Context) {
  try {
    const { db } = await requireAdmin(request);
    const { id } = await context.params;
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'اسم الوسيط غير صالح.', 'validation_error');
    const { data, error } = await db.from('media').update({ display_name: parsed.data.displayName, updated_at: new Date().toISOString() }).eq('id', id).select('*').maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, 'الوسيط غير موجود.', 'not_found');
    return NextResponse.json({ media: data });
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: NextRequest, context: Context) {
  try {
    const { db } = await requireAdmin(request);
    const { id } = await context.params;
    const { data: media, error: loadError } = await db.from('media').select('id,storage_path').eq('id', id).maybeSingle();
    if (loadError) throw loadError;
    if (!media) throw new HttpError(404, 'الوسيط غير موجود.', 'not_found');
    const { data: usageRows, error: usageError } = await db.rpc('get_media_usage_counts', { p_media_ids: [id] });
    if (usageError) throw usageError;
    const count = Number(usageRows?.[0]?.usage_count ?? 0);
    if (count > 0) throw new HttpError(409, 'لا يمكن حذف وسيط مستخدم في مسودة أو نسخة منشورة. أزله من القائمة وانشر التغيير أولاً.', 'media_in_use');
    const { error: deleteError } = await db.from('media').delete().eq('id', id);
    if (deleteError) throw deleteError;
    const config = storageConfig();
    await getS3Client().send(new DeleteObjectCommand({ Bucket: config.bucket, Key: media.storage_path }));
    return NextResponse.json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
