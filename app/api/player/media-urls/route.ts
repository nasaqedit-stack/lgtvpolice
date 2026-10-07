import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { errorResponse, HttpError, readJson, requireScreen } from '@/lib/server/http';
import { buildManifestBase } from '@/lib/server/manifest';
import { getS3Client, storageConfig } from '@/lib/server/storage';

export const runtime = 'nodejs';
const schema = z.object({ mediaIds: z.array(z.string().uuid()).min(1).max(100) }).strict();

export async function POST(request: NextRequest) {
  try {
    const { db, screen } = await requireScreen(request);
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'قائمة الوسائط غير صالحة.', 'invalid_media_list');
    const { base } = await buildManifestBase(db, screen);
    const allowed = new Map(base.assets.map(asset => [asset.mediaId, asset]));
    const ids = [...new Set(parsed.data.mediaIds)];
    if (ids.some(id => !allowed.has(id))) throw new HttpError(403, 'طلبت الشاشة وسيطاً غير مخصص لها.', 'media_not_assigned');
    const { data: mediaRows, error } = await db.from('media').select('id,storage_path,sha256,file_size,mime_type').in('id', ids);
    if (error) throw error;
    const config = storageConfig();
    const client = getS3Client();
    const urls: Record<string, string> = {};
    for (const media of mediaRows ?? []) {
      const expected = allowed.get(media.id);
      if (!expected || expected.hash !== media.sha256 || Number(expected.size) !== Number(media.file_size)) {
        throw new HttpError(409, 'تغيرت الوسائط. أعد مزامنة القائمة.', 'manifest_changed');
      }
      urls[media.id] = await getSignedUrl(client, new GetObjectCommand({
        Bucket: config.bucket,
        Key: media.storage_path,
        ResponseCacheControl: 'private, max-age=3600',
      }), { expiresIn: 60 * 60 });
    }
    return NextResponse.json({ urls, expiresIn: 3600 }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return errorResponse(error); }
}
