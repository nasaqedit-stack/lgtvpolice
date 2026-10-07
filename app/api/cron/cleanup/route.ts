import { NextRequest, NextResponse } from 'next/server';
import { AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { createSupabaseAdmin } from '@/lib/server/supabase';
import { getS3Client, storageConfig } from '@/lib/server/storage';

export const runtime = 'nodejs';
export const maxDuration = 60;
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const db = createSupabaseAdmin();
    const config = storageConfig();
    const now = new Date().toISOString();
    const { data: expiredUploads, error } = await db.from('media_uploads').select('id,storage_path,multipart_id').eq('status', 'uploading').lt('expires_at', now).limit(100);
    if (error) throw error;
    let aborted = 0;
    for (const upload of expiredUploads ?? []) {
      await getS3Client().send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: upload.storage_path, UploadId: upload.multipart_id })).catch(() => undefined);
      const { error: updateError } = await db.from('media_uploads').update({ status: 'aborted' }).eq('id', upload.id);
      if (updateError) throw updateError;
      aborted += 1;
    }
    const { data: pruned, error: pruneError } = await db.rpc('prune_screen_heartbeats');
    if (pruneError) throw pruneError;
    await db.from('pairing_codes').delete().lt('created_at', new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString());
    return NextResponse.json({ ok: true, abortedUploads: aborted, prunedHeartbeats: Number(pruned ?? 0) });
  } catch (error) {
    console.error('Scheduled cleanup failed:', error);
    return NextResponse.json({ error: 'Cleanup failed' }, { status: 500 });
  }
}
