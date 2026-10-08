import { NextRequest, NextResponse } from 'next/server';
import { errorResponse, requireAdmin } from '@/lib/server/http';
import { deriveScreenHealth, isScreenOnline } from '@/lib/server/screen-health';

export async function GET(request: NextRequest) {
  try {
    const { db } = await requireAdmin(request);
    const [{ data: screens, error: screenError }, { count: mediaCount, error: mediaError }, { data: playlists, error: playlistError }] = await Promise.all([
      db.from('screens').select('*'),
      db.from('media').select('id', { count: 'exact', head: true }),
      db.from('playlists').select('id,enabled,published_version'),
    ]);
    if (screenError) throw screenError;
    if (mediaError) throw mediaError;
    if (playlistError) throw playlistError;
    const now = Date.now();
    const activeScreens = (screens ?? []).filter((screen: any) => screen.enabled);
    const healthByStatus = new Map<string, number>();
    let onlineScreens = 0;
    for (const screen of activeScreens) {
      const health = deriveScreenHealth(screen, now);
      healthByStatus.set(health.status, (healthByStatus.get(health.status) ?? 0) + 1);
      if (isScreenOnline(health)) onlineScreens += 1;
    }
    const pendingCommands = activeScreens.reduce((total: number, screen: any) => total + deriveScreenHealth(screen, now).pendingCommands, 0);
    return NextResponse.json({
      totalScreens: activeScreens.length,
      onlineScreens,
      offlineScreens: activeScreens.length - onlineScreens,
      pendingSync: activeScreens.filter((screen: any) => ['syncing', 'failed'].includes(screen.last_sync_status)).length,
      mediaCount: mediaCount ?? 0,
      activePlaylists: (playlists ?? []).filter((playlist: any) => playlist.enabled && playlist.published_version).length,
      // Operational breakdown used by the dashboard so it never claims "online" for a stale TV.
      health: {
        online: healthByStatus.get('online') ?? 0,
        degraded: healthByStatus.get('degraded') ?? 0,
        reconnecting: healthByStatus.get('reconnecting') ?? 0,
        recovering: healthByStatus.get('recovering') ?? 0,
        stale: healthByStatus.get('stale') ?? 0,
        offline: healthByStatus.get('offline') ?? 0,
        authError: healthByStatus.get('auth_error') ?? 0,
        configError: healthByStatus.get('config_error') ?? 0,
        pendingCommands,
      },
    });
  } catch (error) { return errorResponse(error); }
}
