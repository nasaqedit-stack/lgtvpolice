import { NextRequest, NextResponse } from 'next/server';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { errorResponse, HttpError, requireAdmin } from '@/lib/server/http';
import { getS3Client, storageConfig } from '@/lib/server/storage';
import { deriveScreenHealth, isScreenOnline } from '@/lib/server/screen-health';

export const runtime = 'nodejs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  try {
    const { db } = await requireAdmin(request);
    const screenId = request.nextUrl.searchParams.get('screenId') ?? '';
    if (!UUID.test(screenId)) throw new HttpError(400, 'معرّف الشاشة غير صالح.', 'validation_error');

    const { data: screen, error } = await db.from('screens')
      .select('*')
      .eq('id', screenId).maybeSingle();
    if (error) throw error;
    if (!screen) throw new HttpError(404, 'الشاشة غير موجودة.', 'not_found');

    let playlistName: string | null = null;
    let media: any = null;
    if (screen.current_playlist_id) {
      const [{ data: playlist, error: playlistError }, { data: revision, error: revisionError }] = await Promise.all([
        db.from('playlists').select('id,name').eq('id', screen.current_playlist_id).maybeSingle(),
        screen.current_playlist_version == null
          ? Promise.resolve({ data: null, error: null })
          : db.from('playlist_versions').select('manifest').eq('playlist_id', screen.current_playlist_id)
            .eq('version', screen.current_playlist_version).maybeSingle(),
      ]);
      if (playlistError) throw playlistError;
      if (revisionError) throw revisionError;
      playlistName = playlist?.name ?? null;
      const items = Array.isArray(revision?.manifest?.items) ? revision.manifest.items : [];
      const currentItem = items.find((item: any) => item?.id === screen.current_item_id);
      if (currentItem?.mediaId) {
        const { data: foundMedia, error: mediaError } = await db.from('media')
          .select('id,storage_path,display_name,mime_type,kind,width,height,duration_ms')
          .eq('id', currentItem.mediaId).maybeSingle();
        if (mediaError) throw mediaError;
        media = foundMedia ?? null;
      }
    }

    let previewUrl: string | null = null;
    if (media && screen.enabled) {
      const config = storageConfig();
      previewUrl = await getSignedUrl(getS3Client(), new GetObjectCommand({ Bucket: config.bucket, Key: media.storage_path }), { expiresIn: 5 * 60 });
    }
    const health = deriveScreenHealth(screen, Date.now());
    const lastSeenAt = health.lastHeartbeatAt;
    // Online only when the screen is enabled AND its last authenticated heartbeat is recent.
    const online = Boolean(screen.enabled) && isScreenOnline(health);
    return NextResponse.json({
      screen: { id: screen.id, name: screen.name, enabled: screen.enabled },
      online,
      health,
      lastSeenAt,
      lastSyncAt: health.lastSyncAt,
      syncStatus: online && screen.last_sync_status === 'syncing' ? 'syncing' : (screen.last_sync_status ?? 'never'),
      syncError: screen.last_sync_error,
      currentItemId: screen.current_item_id,
      playbackState: online && screen.current_item_id ? 'playing' : online ? 'waiting' : 'offline',
      playlist: screen.current_playlist_id ? { id: screen.current_playlist_id, name: playlistName, version: screen.current_playlist_version } : null,
      media: media ? {
        id: media.id, name: media.display_name, kind: media.kind, mimeType: media.mime_type,
        width: media.width, height: media.height, durationMs: media.duration_ms,
      } : null,
      previewUrl,
      cachedMediaCount: screen.cached_media_count,
      previewNote: media?.kind === 'video' ? 'معاينة المحتوى الحالي؛ الفيديو ليس بثاً مباشراً من التلفاز.' : null,
    }, { headers: { 'Cache-Control': 'no-store, private' } });
  } catch (error) { return errorResponse(error); }
}
