import { NextRequest, NextResponse } from 'next/server';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { errorResponse, HttpError, requireScreen } from '@/lib/server/http';
import { buildManifestBase } from '@/lib/server/manifest';
import { getS3Client, storageConfig } from '@/lib/server/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ mediaId: string }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Same-origin range stream for a screen's own media.
 *
 * The player normally downloads through short-lived signed object-storage URLs. Some TV browsers
 * cannot use those cross-origin requests (restricted CORS on the storage endpoint, an old webOS
 * network stack, an expired signature, a blocked host). This route serves the identical bytes from
 * the same origin the player is already talking to, so the local cache fills even when the direct
 * path is unusable. The bucket stays private: the caller must present a valid screen credential,
 * the media must still be referenced by the screen's published manifest (hash and size are
 * re-checked against the database on every request), and the object is read server-side with the
 * service credentials.
 */
export async function GET(request: NextRequest, context: Context) {
  try {
    const { db, screen } = await requireScreen(request);
    const { mediaId } = await context.params;
    if (!uuid.test(mediaId)) throw new HttpError(400, 'معرّف الوسيط غير صالح.', 'invalid_media_id');
    const { base } = await buildManifestBase(db, screen);
    const expected = base.assets.find(asset => asset.mediaId === mediaId);
    if (!expected) throw new HttpError(403, 'طلبت الشاشة وسيطاً غير مخصص لها.', 'media_not_assigned');
    const { data: media, error } = await db.from('media').select('storage_path,sha256,file_size,mime_type').eq('id', mediaId).maybeSingle();
    if (error) throw error;
    if (!media || expected.hash !== media.sha256 || Number(expected.size) !== Number(media.file_size)) {
      throw new HttpError(409, 'تغيرت الوسائط. أعد مزامنة القائمة.', 'manifest_changed');
    }
    const size = Number(media.file_size);
    const command: { Bucket: string; Key: string; Range?: string } = { Bucket: storageConfig().bucket, Key: media.storage_path };
    let start: number | null = null;
    let end: number | null = null;
    const requested = request.headers.get('range');
    if (requested) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(requested.trim());
      if (match) {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
        if (start >= size || start > end) {
          return new NextResponse(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' } });
        }
        end = Math.min(end, size - 1);
        command.Range = `bytes=${start}-${end}`;
      }
    }
    const object = await getS3Client().send(new GetObjectCommand(command));
    const body = object.Body ? Buffer.from(await object.Body.transformToByteArray()) : Buffer.alloc(0);
    const headers: Record<string, string> = {
      'Content-Type': media.mime_type,
      'Cache-Control': 'private, max-age=3600',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff',
    };
    if (start !== null && end !== null) {
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      return new NextResponse(body, { status: 206, headers });
    }
    return new NextResponse(body, { status: 200, headers });
  } catch (error) { return errorResponse(error); }
}
