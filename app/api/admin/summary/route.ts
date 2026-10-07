import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, requireAdmin } from '@/lib/server/http';

export async function GET(request: NextRequest) {
  try {
    const { db } = await requireAdmin(request);
    const [{ data: screens, error: screenError }, { count: mediaCount, error: mediaError }, { data: playlists, error: playlistError }] = await Promise.all([
      db.from('screens').select('id,last_seen_at,last_sync_status,enabled'),
      db.from('media').select('id', { count: 'exact', head: true }),
      db.from('playlists').select('id,enabled,published_version'),
    ]);
    if (screenError) throw screenError;
    if (mediaError) throw mediaError;
    if (playlistError) throw playlistError;
    const now = Date.now();
    const activeScreens = (screens ?? []).filter((screen: any) => screen.enabled);
    const onlineScreens = activeScreens.filter((screen: any) => screen.last_seen_at && now - new Date(screen.last_seen_at).getTime() < 5 * 60_000).length;
    return NextResponse.json({
      totalScreens: activeScreens.length,
      onlineScreens,
      offlineScreens: activeScreens.length - onlineScreens,
      pendingSync: activeScreens.filter((screen: any) => ['syncing', 'failed'].includes(screen.last_sync_status)).length,
      mediaCount: mediaCount ?? 0,
      activePlaylists: (playlists ?? []).filter((playlist: any) => playlist.enabled && playlist.published_version).length,
    });
  } catch (error) { return errorResponse(error); }
}
