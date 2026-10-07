import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse, HttpError, requireAdmin, readJson } from '@/lib/server/http';
import { issuePairingCode } from '@/lib/server/pairing';

export const runtime = 'nodejs';

function validTimezone(value: string) {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}

export async function GET(request: NextRequest) {
  try {
    const { db } = await requireAdmin(request);
    const [{ data: screens, error }, { data: playlists, error: playlistError }, { data: credentials, error: credentialError }] = await Promise.all([
      db.from('screens').select('*').order('created_at', { ascending: false }),
      db.from('playlists').select('id,name,published_version,enabled').order('name'),
      db.from('screen_credentials').select('screen_id').is('revoked_at', null),
    ]);
    if (error) throw error;
    if (playlistError) throw playlistError;
    if (credentialError) throw credentialError;
    const playlistMap = new Map((playlists ?? []).map((p: any) => [p.id, p]));
    const credentialSet = new Set((credentials ?? []).map((c: any) => c.screen_id));
    const now = Date.now();
    return NextResponse.json({ screens: (screens ?? []).map((screen: any) => {
      const seenAt = screen.last_seen_at ? new Date(screen.last_seen_at).getTime() : 0;
      const playlist = screen.assigned_playlist_id ? playlistMap.get(screen.assigned_playlist_id) : null;
      return {
        ...screen,
        online: Boolean(screen.enabled) && seenAt > 0 && now - seenAt < 5 * 60_000,
        pairingStatus: credentialSet.has(screen.id) ? 'paired' : 'not_paired',
        assignedPlaylist: playlist ?? null,
      };
    }), playlists: playlists ?? [] });
  } catch (error) { return errorResponse(error); }
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z.string().default('Asia/Riyadh'),
}).strict();

export async function POST(request: NextRequest) {
  try {
    const { db, user } = await requireAdmin(request);
    const parsed = createSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, 'اسم الشاشة أو المنطقة الزمنية غير صالح.', 'validation_error');
    if (!validTimezone(parsed.data.timezone)) throw new HttpError(400, 'المنطقة الزمنية غير معروفة.', 'invalid_timezone');
    const { data: screen, error } = await db.from('screens').insert({ name: parsed.data.name, timezone: parsed.data.timezone }).select('*').single();
    if (error) throw error;
    try {
      const pairing = await issuePairingCode(db, screen.id, user.id);
      return NextResponse.json({ screen, ...pairing }, { status: 201 });
    } catch (pairError) {
      await db.from('screens').delete().eq('id', screen.id);
      throw pairError;
    }
  } catch (error) { return errorResponse(error); }
}
