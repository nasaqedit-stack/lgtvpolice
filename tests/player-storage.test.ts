import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ScreenManifest } from '../lib/shared';
import {
  activateManifest, clearStalePartial, deleteUnreferencedAssets, finalizeAsset, getActiveManifest, getAssetBlob,
  getAudioEnabled, hasCompleteAsset, saveChunk, setAudioEnabled, storeCredential, readCredential,
} from '../lib/player/storage';

const mime = 'image/png';
function manifest(hash: string, bytes: number, version: number): ScreenManifest {
  const playlistId = '00000000-0000-4000-8000-000000000001';
  const mediaId = '00000000-0000-4000-8000-000000000002';
  return {
    schemaVersion: 1,
    screen: { id: '00000000-0000-4000-8000-000000000003', name: 'Test', timezone: 'Asia/Riyadh' },
    manifestVersion: version, manifestHash: `${String(version).padStart(64, '0')}`, generatedAt: '2026-10-07T00:00:00.000Z',
    defaultPlaylistId: playlistId,
    playlists: [{ id: playlistId, name: 'Test list', version, enabled: true, items: [{
      id: `00000000-0000-4000-8000-${String(version).padStart(12, '0')}`,
      mediaId, name: 'image.png', hash, size: bytes, mimeType: mime, kind: 'image', durationMs: 10000, loop: false, position: 0,
    }] }],
    schedules: [], assets: [{ mediaId, hash, size: bytes, mimeType: mime, name: 'image.png' }],
    commands: { syncVersion: 0, reloadVersion: 0 },
  };
}

async function cache(hash: string, content: Uint8Array) {
  const blobBytes = new Uint8Array(content.byteLength);
  blobBytes.set(content);
  const blob = new Blob([blobBytes], { type: mime });
  await saveChunk(hash, 0, blob, content.byteLength, mime, 4 * 1024 * 1024);
  await finalizeAsset(hash, content.byteLength, mime, 1);
}

describe('persistent player storage', () => {
  beforeAll(async () => {
    await storeCredential('screen-secret-kept-only-in-indexeddb');
  });

  it('stores the screen credential in IndexedDB and reconstructs cached media from chunks', async () => {
    expect(await readCredential()).toBe('screen-secret-kept-only-in-indexeddb');
    const content = new TextEncoder().encode('offline signage frame');
    const hash = bytesToHex(sha256(content));
    await cache(hash, content);
    expect(await hasCompleteAsset(hash, content.byteLength, mime)).toBe(true);
    expect(await (await getAssetBlob(hash))?.text()).toBe('offline signage frame');
  });

  it('persists the one-time audio activation preference in player metadata', async () => {
    expect(await getAudioEnabled()).toBe(false);
    await setAudioEnabled(true);
    expect(await getAudioEnabled()).toBe(true);
  });

  it('does not atomically activate a manifest until every referenced asset is complete', async () => {
    const oldBytes = new TextEncoder().encode('old playlist image');
    const oldHash = bytesToHex(sha256(oldBytes));
    await cache(oldHash, oldBytes);
    const oldManifest = manifest(oldHash, oldBytes.byteLength, 1);
    await activateManifest(oldManifest);

    const newBytes = new TextEncoder().encode('new playlist image');
    const newHash = bytesToHex(sha256(newBytes));
    const nextManifest = manifest(newHash, newBytes.byteLength, 2);
    await saveChunk(newHash, 0, new Blob([newBytes.slice(0, 5)], { type: mime }), newBytes.byteLength, mime, 4 * 1024 * 1024);
    await expect(activateManifest(nextManifest)).rejects.toThrow('غير مكتمل');
    expect((await getActiveManifest())?.manifestHash).toBe(oldManifest.manifestHash);

    // Remove the failed staged bytes, then mimic a successful retry of the whole object.
    await clearStalePartial(newHash);
    await cache(newHash, newBytes);
    await activateManifest(nextManifest);
    expect((await getActiveManifest())?.manifestHash).toBe(nextManifest.manifestHash);
    await deleteUnreferencedAssets([newHash]);
    expect(await hasCompleteAsset(oldHash, oldBytes.byteLength, mime)).toBe(false);
    expect(await hasCompleteAsset(newHash, newBytes.byteLength, mime)).toBe(true);
  });
});
