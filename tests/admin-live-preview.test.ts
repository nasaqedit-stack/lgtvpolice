import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getSignedUrl: vi.fn(),
  getS3Client: vi.fn(),
  storageConfig: vi.fn(),
}));

vi.mock('@/lib/server/http', () => ({
  requireAdmin: (...args: unknown[]) => mocks.requireAdmin(...args),
  HttpError: class HttpError extends Error { constructor(readonly status: number, message: string, readonly code: string) { super(message); } },
  errorResponse: (error: any) => new Response(JSON.stringify({ error: error?.message ?? 'error', code: error?.code }), {
    status: error?.status ?? 500, headers: { 'Content-Type': 'application/json' },
  }),
}));
vi.mock('@/lib/server/storage', () => ({ getS3Client: mocks.getS3Client, storageConfig: mocks.storageConfig }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: mocks.getSignedUrl }));

import { GET } from '../app/api/admin/live-preview/route';

const screenId = '00000000-0000-4000-8000-000000000001';
const playlistId = '00000000-0000-4000-8000-000000000002';
const itemId = '00000000-0000-4000-8000-000000000003';
const mediaId = '00000000-0000-4000-8000-000000000004';
const fresh = new Date().toISOString();
const screenRow = {
  id: screenId, name: 'Lobby', enabled: true, last_seen_at: fresh, last_sync_at: fresh,
  last_sync_status: 'ready', last_sync_error: null, current_playlist_id: playlistId,
  current_playlist_version: 2, current_item_id: itemId, cached_media_count: 3,
};
const revision = { manifest: { items: [{ id: itemId, mediaId }] } };
const media = { id: mediaId, storage_path: 'private/lobby.png', display_name: 'Lobby image', mime_type: 'image/png', kind: 'image', width: 1920, height: 1080 };

function request(search = `screenId=${screenId}`) {
  return new NextRequest(`https://app.test/api/admin/live-preview?${search}`);
}
function fakeDb(rows: Record<string, any>) {
  return { from(table: string) {
    const filters: Record<string, unknown> = {};
    const builder: any = {
      select: () => builder,
      eq: (key: string, value: unknown) => { filters[key] = value; return builder; },
      maybeSingle: async () => {
        if (table === 'screens') return { data: rows.screen ?? null, error: null };
        if (table === 'playlists') return { data: rows.playlist ?? null, error: null };
        if (table === 'playlist_versions') return { data: rows.revision ?? null, error: null };
        if (table === 'media') return { data: filters.id === rows.media?.id ? rows.media : null, error: null };
        return { data: null, error: null };
      },
    };
    return builder;
  } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockImplementation(async () => ({ db: fakeDb({ screen: screenRow, playlist: { id: playlistId, name: 'Welcome' }, revision, media }) }));
  mocks.getSignedUrl.mockResolvedValue('https://signed.example/private-media');
  mocks.getS3Client.mockReturnValue({});
  mocks.storageConfig.mockReturnValue({ bucket: 'private-bucket' });
});

describe('GET /api/admin/live-preview', () => {
  it('reconstructs the reported item from the selected published version and signs it privately', async () => {
    const response = await GET(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.online).toBe(true);
    expect(body.playbackState).toBe('playing');
    expect(body.playlist.name).toBe('Welcome');
    expect(body.media.name).toBe('Lobby image');
    expect(body.previewUrl).toBe('https://signed.example/private-media');
    expect(response.headers.get('Cache-Control')).toContain('private');
    expect(mocks.getSignedUrl).toHaveBeenCalledOnce();
  });

  it('marks a stale heartbeat offline and does not claim playback is live', async () => {
    const stale = { ...screenRow, last_seen_at: new Date(Date.now() - 6 * 60_000).toISOString() };
    mocks.requireAdmin.mockResolvedValue({ db: fakeDb({ screen: stale, playlist: { id: playlistId, name: 'Welcome' }, revision, media }) });
    const response = await GET(request());
    const body = await response.json();
    expect(body.online).toBe(false);
    expect(body.playbackState).toBe('offline');
  });

  it('rejects invalid screen IDs without querying private preview data', async () => {
    const response = await GET(request('screenId=not-a-uuid'));
    expect(response.status).toBe(400);
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
  });

  it('does not return a media URL when the heartbeat item is absent from the selected published snapshot', async () => {
    mocks.requireAdmin.mockResolvedValue({ db: fakeDb({ screen: screenRow, playlist: { id: playlistId, name: 'Welcome' }, revision: { manifest: { items: [] } }, media }) });
    const response = await GET(request());
    const body = await response.json();
    expect(body.media).toBeNull();
    expect(body.previewUrl).toBeNull();
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
  });

  it('does not issue signed URLs when admin authorization fails', async () => {
    mocks.requireAdmin.mockRejectedValue({ status: 401, code: 'unauthorized', message: 'Sign in required.' });
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(mocks.getSignedUrl).not.toHaveBeenCalled();
  });
});
