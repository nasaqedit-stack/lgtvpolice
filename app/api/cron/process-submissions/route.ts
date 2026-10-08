import { NextRequest, NextResponse } from 'next/server';
import { createSupabaseAdmin } from '@/lib/server/supabase';
import { getS3Client, storageConfig } from '@/lib/server/storage';
import { processSubmissionImage, processSubmissionVideo } from '@/lib/server/submission-processing';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const db = createSupabaseAdmin();
    const config = storageConfig();
    const client = getS3Client();

    const { data: submissions, error } = await db
      .from('submissions')
      .select('*')
      .eq('state', 'SUBMITTED')
      .order('created_at', { ascending: true })
      .limit(5);
    if (error) throw error;

    let processed = 0;
    let failed = 0;

    for (const submission of submissions ?? []) {
      const { error: startError } = await db.rpc('start_submission_processing', { p_submission_id: submission.id });
      if (startError) {
        console.error('Failed to start processing:', startError);
        failed++;
        continue;
      }

      try {
        if (!submission.original_media_id) {
          throw new Error('Original media not linked');
        }

        const { data: originalMedia, error: mediaError } = await db
          .from('media')
          .select('id, storage_path, mime_type, kind')
          .eq('id', submission.original_media_id)
          .maybeSingle();
        if (mediaError) throw mediaError;
        if (!originalMedia) throw new Error('Original media not found');

        let optimizedMediaId: string | null = null;
        let thumbnailMediaId: string | null = null;

        if (originalMedia.kind === 'image') {
          const { optimized, thumbnail } = await processSubmissionImage(client, config.bucket, originalMedia.storage_path, submission.id);

          const { data: optimizedMedia, error: optError } = await db.from('media').insert({
            storage_path: optimized.storagePath,
            display_name: `${submission.title} (مُحسّن)`,
            mime_type: optimized.mimeType,
            kind: optimized.kind,
            file_size: optimized.fileSize,
            sha256: optimized.sha256,
            width: optimized.width,
            height: optimized.height,
            thumbnail_data: optimized.thumbnailData,
            compatibility: 'candidate',
            metadata: { source: 'submission_optimized', submission_id: submission.id },
            uploaded_by: null,
          }).select('id').single();
          if (optError) throw optError;
          optimizedMediaId = optimizedMedia.id;

          const { data: thumbMedia, error: thumbError } = await db.from('media').insert({
            storage_path: thumbnail.storagePath,
            display_name: `${submission.title} (مصغرة)`,
            mime_type: thumbnail.mimeType,
            kind: thumbnail.kind,
            file_size: thumbnail.fileSize,
            sha256: thumbnail.sha256,
            width: thumbnail.width,
            height: thumbnail.height,
            compatibility: 'candidate',
            metadata: { source: 'submission_thumbnail', submission_id: submission.id },
            uploaded_by: null,
          }).select('id').single();
          if (thumbError) throw thumbError;
          thumbnailMediaId = thumbMedia.id;
        } else {
          const { optimized, thumbnail } = await processSubmissionVideo(client, config.bucket, originalMedia.storage_path, submission.id);

          const { data: optimizedMedia, error: optError } = await db.from('media').insert({
            storage_path: optimized.storagePath,
            display_name: `${submission.title} (مُحسّن)`,
            mime_type: optimized.mimeType,
            kind: optimized.kind,
            file_size: optimized.fileSize,
            sha256: optimized.sha256,
            width: optimized.width,
            height: optimized.height,
            duration_ms: optimized.durationMs,
            thumbnail_data: optimized.thumbnailData,
            compatibility: 'candidate',
            metadata: { source: 'submission_optimized', submission_id: submission.id },
            uploaded_by: null,
          }).select('id').single();
          if (optError) throw optError;
          optimizedMediaId = optimizedMedia.id;

          const { data: thumbMedia, error: thumbError } = await db.from('media').insert({
            storage_path: thumbnail.storagePath,
            display_name: `${submission.title} (مصغرة)`,
            mime_type: thumbnail.mimeType,
            kind: thumbnail.kind,
            file_size: thumbnail.fileSize,
            sha256: thumbnail.sha256,
            width: thumbnail.width,
            height: thumbnail.height,
            compatibility: 'candidate',
            metadata: { source: 'submission_thumbnail', submission_id: submission.id },
            uploaded_by: null,
          }).select('id').single();
          if (thumbError) throw thumbError;
          thumbnailMediaId = thumbMedia.id;
        }

        const { error: completeError } = await db.rpc('complete_submission_processing', {
          p_submission_id: submission.id,
          p_original_media_id: originalMedia.id,
          p_optimized_media_id: optimizedMediaId!,
          p_thumbnail_media_id: thumbnailMediaId!,
        });
        if (completeError) throw completeError;

        processed++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown processing error';
        console.error('Processing failed:', error);
        await db.rpc('fail_submission_processing', { p_submission_id: submission.id, p_error: errorMessage });
        failed++;
      }
    }

    return NextResponse.json({ ok: true, processed, failed });
  } catch (error) {
    console.error('Cron process submissions failed:', error);
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}