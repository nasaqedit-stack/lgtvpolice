import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ScreenManifest } from '../lib/shared';
import { getActiveManifest, getAssetBlob } from '../lib/player/storage';
import { synchronizePlayer } from '../lib/player/sync';

const screenId = '00000000-0000-4000-8000-000000000001';
const playlistId = '00000000-0000-4000-8000-000000000002';
const imageId = '00000000-0000-4000-8000-000000000003';
const videoId = '00000000-0000-4000-8000-000000000004';
const imageItemId = '00000000-0000-4000-8000-000000000005';
const videoItemId = '00000000-0000-4000-8000-000000000006';
const imageMime = 'image/png';
const videoMime = 'video/mp4';
const imageA = new TextEncoder().encode('offline-image-version-a');
const imageB = new TextEncoder().encode('offline-image-version-b');
const video = new TextEncoder().encode('local-video-bytes-no-streaming');
const digest = (value: Uint8Array) => bytesToHex(sha256(value));

function buildManifest(imageBytes: Uint8Array, version: number): ScreenManifest {
  const imageHash = digest(imageBytes);
  const videoHash = digest(video);
  return {
    schemaVersion: 1,
    screen: { id: screenId, name: 'Test screen', timezone: 'Asia/Riyadh' },
    manifestVersion: version, manifestHash: String(version).padStart(64, '0'), generatedAt: '2026-10-07T00:00:00.000Z',
    defaultPlaylistId: playlistId,
    playlists: [{ id: playlistId, name: 'Test', version, enabled: true, items: [
      { id: imageItemId, mediaId: imageId, name: 'notice.png', hash: imageHash, size: imageBytes.length, mimeType: imageMime, kind: 'image', durationMs: 10000, loop: false, position: 0 },
      { id: videoItemId, mediaId: videoId, name: 'welcome.mp4', hash: videoHash, size: video.length, mimeType: videoMime, kind: 'video', durationMs: null, loop: false, position: 1 },
    ] }],
    schedules: [],
    assets: [
      { mediaId: imageId, hash: imageHash, size: imageBytes.length, mimeType: imageMime, name: 'notice.png' },
      { mediaId: videoId, hash: videoHash, size: video.length, mimeType: videoMime, name: 'welcome.mp4' },
    ],
    commands: { syncVersion: 0, reloadVersion: 0 },
  };
}

function installServer(manifest: ScreenManifest, files: Map<string, Uint8Array>, downloadIds: string[], corruptFor = new Set<string>()) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/player/manifest') {
      const headers = new Headers(init?.headers);
      if (headers.get('If-None-Match') === `"${manifest.manifestHash}"`) return new Response(null, { status: 304 });
      return Response.json(manifest);
    }
    if (url === '/api/player/media-urls') {
      const request = JSON.parse(String(init?.body ?? '{}')) as { mediaIds: string[] };
      downloadIds.push(...request.mediaIds);
      const urls = Object.fromEntries(request.mediaIds.map(id => [id, `https://objects.test/${id}`]));
      return Response.json({ urls });
    }
    if (url.startsWith('https://objects.test/')) {
      const id = url.split('/').pop()!;
      const bytes = files.get(id);
      if (!bytes) return new Response(null, { status: 404 });
      const range = new Headers(init?.headers).get('Range') ?? 'bytes=0-';
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      const start = Number(match?.[1] ?? 0);
      const end = Math.min(Number(match?.[2] ?? bytes.length - 1), bytes.length - 1);
      let chunk = bytes.slice(start, end + 1);
      if (corruptFor.has(id) && chunk.length) {
        chunk = chunk.slice();
        chunk[0] ^= 0xff;
      }
      return new Response(chunk, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
    }
    throw new Error(`Unexpected request ${url}`);
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('player synchronization and offline retention', () => {
  it('downloads once, skips unchanged video on an image-only update, and keeps active media when offline', async () => {
    const first = buildManifest(imageA, 1);
    const requested: string[] = [];
    const files = new Map([[imageId, imageA], [videoId, video]]);
    installServer(first, files, requested);
    const initial = await synchronizePlayer('screen-token', () => undefined);
    expect(initial.manifest.manifestHash).toBe(first.manifestHash);
    expect(requested.sort()).toEqual([imageId, videoId].sort());
    expect(await (await getAssetBlob(digest(video)))?.text()).toBe('local-video-bytes-no-streaming');

    const second = buildManifest(imageB, 2);
    installServer(second, new Map([[imageId, imageB], [videoId, video]]), requested);
    await synchronizePlayer('screen-token', () => undefined);
    expect(requested.slice(2)).toEqual([imageId]);
    expect((await getActiveManifest())?.manifestHash).toBe(second.manifestHash);
    expect(await (await getAssetBlob(digest(video)))?.text()).toBe('local-video-bytes-no-streaming');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network disconnected'); }));
    await expect(synchronizePlayer('screen-token', () => undefined)).rejects.toMatchObject({ code: 'network_offline' });
    expect((await getActiveManifest())?.manifestHash).toBe(second.manifestHash);
    expect(await (await getAssetBlob(digest(imageB)))?.text()).toBe('offline-image-version-b');
  });

  it('keeps the requested window when a gateway returns a longer 206 body', async () => {
    // Larger than the 4 MiB range chunk, so at least one request is a partial window.
    const bigImage = new Uint8Array(4 * 1024 * 1024 + 4096).map((_, index) => index % 251);
    // Revision 9 so the synthetic manifest hash stays distinct from the manifests of the other
    // cases in this file (the shared fake IndexedDB keeps the previously activated manifest).
    const manifest = buildManifest(bigImage, 9);
    const files = new Map([[imageId, bigImage], [videoId, video]]);
    const requested: string[] = [];
    installServer(manifest, files, requested);
    // Simulate an S3-compatible gateway that ignores the requested end bound and returns the rest
    // of the object with every 206 response. The player must store exactly the requested window and
    // still verify SHA-256 over the whole file.
    const inner = vi.mocked(globalThis.fetch).getMockImplementation()!;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://objects.test/')) {
        const bytes = files.get(url.split('/').pop()!)!;
        const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range') ?? 'bytes=0-');
        const start = Number(match?.[1] ?? 0);
        return new Response(bytes.slice(start), { status: 206, headers: { 'Content-Range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } });
      }
      return inner(input, init);
    }));
    const result = await synchronizePlayer('screen-token', () => undefined);
    expect(result.manifest.manifestHash).toBe(manifest.manifestHash);
    expect((await getAssetBlob(digest(bigImage)))?.size).toBe(bigImage.length);
  });

  it('falls back to the same-origin stream when the signed storage URL is unusable', async () => {
    // Unique bytes for both assets so this case always downloads (and never reuses the local
    // cache entries created by the earlier cases).
    const freshImage = new TextEncoder().encode('same-origin-fallback-image');
    const freshVideo = new TextEncoder().encode('same-origin-fallback-video');
    const base = buildManifest(freshImage, 21);
    const freshVideoHash = digest(freshVideo);
    const manifest: ScreenManifest = {
      ...base,
      playlists: [{ ...base.playlists[0], items: [base.playlists[0].items[0], { ...base.playlists[0].items[1], hash: freshVideoHash, size: freshVideo.length }] }],
      assets: [base.assets[0], { ...base.assets[1], hash: freshVideoHash, size: freshVideo.length }],
    };
    const files = new Map([[imageId, freshImage], [videoId, freshVideo]]);
    const requested: string[] = [];
    installServer(manifest, files, requested);
    const proxied: string[] = [];
    const inner = vi.mocked(globalThis.fetch).getMockImplementation()!;
    // The direct object-storage URL behaves like a TV that cannot use it: the browser throws
    // (CORS/blocked host) and an expired signature answers 403. Both must reach the app stream.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://objects.test/')) throw new TypeError('Failed to fetch');
      if (url.startsWith('/api/player/media/')) {
        const id = url.split('/').pop()!;
        proxied.push(id);
        const bytes = files.get(id)!;
        const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range') ?? 'bytes=0-');
        const start = Number(match?.[1] ?? 0);
        const end = Math.min(Number(match?.[2] ?? bytes.length - 1), bytes.length - 1);
        return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
      }
      return inner(input, init);
    }));
    const result = await synchronizePlayer('screen-token', () => undefined);
    expect(result.manifest.manifestHash).toBe(manifest.manifestHash);
    expect([...new Set(proxied)].sort()).toEqual([imageId, videoId].sort());
    expect(await (await getAssetBlob(digest(freshImage)))?.text()).toBe('same-origin-fallback-image');
  });

  it('does not activate a corrupted download and retains the previous working manifest', async () => {
    const first = buildManifest(imageA, 1);
    const ids: string[] = [];
    installServer(first, new Map([[imageId, imageA], [videoId, video]]), ids);
    await synchronizePlayer('screen-token', () => undefined);

    const third = buildManifest(imageB, 3);
    installServer(third, new Map([[imageId, imageB], [videoId, video]]), [], new Set([imageId]));
    await expect(synchronizePlayer('screen-token', () => undefined)).rejects.toMatchObject({ code: 'hash_mismatch' });
    expect((await getActiveManifest())?.manifestHash).toBe(first.manifestHash);
    expect(await (await getAssetBlob(digest(imageA)))?.text()).toBe('offline-image-version-a');
  });
});
