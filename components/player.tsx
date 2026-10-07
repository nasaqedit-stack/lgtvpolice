'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ManifestItem, ScreenManifest, StorageStats } from '@/lib/shared';
import { scheduledPlaylistId } from '@/lib/player/schedule';
import {
  clearCredential, countCachedAssets, getActiveManifest, getAssetBlob, getLastSyncAt,
  getStorageStats, readCredential, requestPersistentStorage, setSeenReloadVersion, getSeenReloadVersion,
  storeCredential,
} from '@/lib/player/storage';
import { PlayerSyncError, synchronizePlayer, type SyncProgress } from '@/lib/player/sync';

type SyncState = 'ready' | 'syncing' | 'failed' | 'never';
type ScreenCredentialResponse = { credential: string; screen: { id: string; name: string; timezone: string } };

function deviceInfo() {
  return {
    userAgent: navigator.userAgent.slice(0, 500),
    platform: (navigator.platform || 'browser').slice(0, 120),
    screenWidth: window.screen?.width ?? 0,
    screenHeight: window.screen?.height ?? 0,
    language: navigator.language?.slice(0, 30),
  };
}
function getActiveItem(manifest: ScreenManifest | null, playlistId: string | null, index: number): { playlistId: string; playlistVersion: number; item: ManifestItem; count: number } | null {
  if (!manifest || !playlistId) return null;
  const playlist = manifest.playlists.find(candidate => candidate.id === playlistId && candidate.enabled);
  if (!playlist?.items.length) return null;
  const itemIndex = ((index % playlist.items.length) + playlist.items.length) % playlist.items.length;
  return { playlistId: playlist.id, playlistVersion: playlist.version, item: playlist.items[itemIndex], count: playlist.items.length };
}
function bytesLabel(value: number) {
  if (!Number.isFinite(value)) return '';
  const mb = value / 1024 / 1024;
  return `${new Intl.NumberFormat('ar', { maximumFractionDigits: 1 }).format(mb)} م.ب`;
}

export default function Player() {
  const [booted, setBooted] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const [manifest, setManifest] = useState<ScreenManifest | null>(null);
  const manifestRef = useRef<ScreenManifest | null>(null);
  const [screenName, setScreenName] = useState('');
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(null);
  const activePlaylistRef = useRef<string | null>(null);
  const [index, setIndex] = useState(0);
  const [syncState, setSyncState] = useState<SyncState>('never');
  const syncStateRef = useRef<SyncState>('never');
  const [progress, setProgress] = useState<SyncProgress>({ phase: 'manifest', message: 'جارٍ استعادة المحتوى المحلي…', totalBytes: 0, downloadedBytes: 0 });
  const [syncError, setSyncError] = useState('');
  const [online, setOnline] = useState(true);
  const [pairCode, setPairCode] = useState('');
  const [pairError, setPairError] = useState('');
  const [pairing, setPairing] = useState(false);
  const [showPairForm, setShowPairForm] = useState(false);
  const [mediaUrl, setMediaUrl] = useState<{ hash: string; url: string } | null>(null);
  const [mediaError, setMediaError] = useState(false);
  const [storage, setStorage] = useState<StorageStats>({ usage: null, quota: null, persisted: null });
  const [cachedCount, setCachedCount] = useState(0);
  const [lastSyncAt, setLastSyncAtState] = useState<string | null>(null);
  const [fullscreenAttempted, setFullscreenAttempted] = useState(false);
  const syncLock = useRef(false);
  const heartbeatLock = useRef(false);
  const currentItemIdRef = useRef<string | null>(null);
  const lastReloadRef = useRef(0);

  const selectedPlaylistId = useMemo(() => manifest ? scheduledPlaylistId(manifest) : null, [manifest]);
  const playlistId = activePlaylistId ?? selectedPlaylistId;
  const current = getActiveItem(manifest, playlistId, index);
  const currentItem = current?.item ?? null;

  const updateManifest = useCallback((next: ScreenManifest) => {
    const prior = manifestRef.current;
    const priorPlaylist = activePlaylistRef.current ?? (prior ? scheduledPlaylistId(prior) : null);
    const priorItems = prior?.playlists.find(value => value.id === priorPlaylist)?.items ?? [];
    const priorItemId = currentItemIdRef.current ?? priorItems[0]?.id ?? null;
    const nextPlaylist = scheduledPlaylistId(next);
    const nextItems = next.playlists.find(value => value.id === nextPlaylist)?.items ?? [];
    const samePlaylist = priorPlaylist === nextPlaylist;
    const nextIndex = samePlaylist && priorItemId ? Math.max(0, nextItems.findIndex(item => item.id === priorItemId)) : 0;
    manifestRef.current = next;
    activePlaylistRef.current = nextPlaylist;
    setManifest(next);
    setActivePlaylistId(nextPlaylist);
    setIndex(nextIndex < 0 ? 0 : nextIndex);
  }, []);

  const reportProgress = useCallback((value: SyncProgress) => {
    setProgress(value);
  }, []);

  const runSync = useCallback(async (requestedToken?: string | null) => {
    const screenToken = requestedToken ?? tokenRef.current;
    if (!screenToken || syncLock.current || document.visibilityState === 'hidden') return;
    syncLock.current = true;
    syncStateRef.current = 'syncing';
    setSyncState('syncing');
    setSyncError('');
    try {
      const result = await synchronizePlayer(screenToken, reportProgress);
      updateManifest(result.manifest);
      setLastSyncAtState(result.lastSyncAt);
      setCachedCount(await countCachedAssets());
      setStorage(await getStorageStats());
      setOnline(true);
      syncStateRef.current = 'ready';
      setSyncState('ready');
      setSyncError('');
      const seen = await getSeenReloadVersion();
      const requested = result.manifest.commands.reloadVersion;
      if (requested > seen && requested > lastReloadRef.current) {
        lastReloadRef.current = requested;
        await setSeenReloadVersion(requested);
        window.location.reload();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'تعذرت المزامنة.';
      const code = error instanceof PlayerSyncError ? error.code : 'sync_failed';
      setSyncError(message);
      if (code === 'network_offline' || !navigator.onLine) setOnline(false);
      if (code === 'screen_unauthorized') {
        await clearCredential().catch(() => undefined);
        tokenRef.current = null;
        setToken(null);
        setShowPairForm(!manifestRef.current);
      }
      if (code === 'screen_disabled') setOnline(false);
      syncStateRef.current = 'failed';
      setSyncState('failed');
      setStorage(await getStorageStats());
    } finally {
      syncLock.current = false;
    }
  }, [reportProgress, updateManifest]);

  useEffect(() => {
    let active = true;
    const registerShell = async () => {
      try { if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { /* Offline playback does not depend on successful SW installation after initial load. */ }
      try { await requestPersistentStorage(); } catch { /* Best effort; IndexedDB remains the primary store. */ }
    };
    void registerShell();
    Promise.all([readCredential(), getActiveManifest(), getStorageStats(), getLastSyncAt(), countCachedAssets()])
      .then(([savedToken, savedManifest, stats, syncedAt, count]) => {
        if (!active) return;
        tokenRef.current = savedToken;
        setToken(savedToken);
        if (savedManifest) {
          manifestRef.current = savedManifest;
          setManifest(savedManifest);
          const selected = scheduledPlaylistId(savedManifest);
          activePlaylistRef.current = selected;
          setActivePlaylistId(selected);
          currentItemIdRef.current = savedManifest.playlists.find(value => value.id === selected)?.items[0]?.id ?? null;
        }
        setStorage(stats);
        setLastSyncAtState(syncedAt);
        setCachedCount(count);
        setShowPairForm(!savedToken && !savedManifest);
        setBooted(true);
      })
      .catch(error => {
        if (!active) return;
        setSyncError(error instanceof Error ? error.message : 'تعذر فتح التخزين المحلي.');
        setShowPairForm(true);
        setBooted(true);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!booted || !token) return;
    void runSync(token);
    const syncTimer = window.setInterval(() => void runSync(tokenRef.current), 60_000);
    const heartbeat = async () => {
      if (!tokenRef.current || heartbeatLock.current || !navigator.onLine) return;
      heartbeatLock.current = true;
      try {
        const stats = await getStorageStats();
        const item = currentItemIdRef.current;
        const activeManifest = manifestRef.current;
        const selected = activePlaylistRef.current;
        const activeList = activeManifest?.playlists.find(value => value.id === selected);
        const response = await fetch('/api/player/heartbeat', {
          method: 'POST', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenRef.current}` },
          body: JSON.stringify({
            currentPlaylistId: selected,
            currentPlaylistVersion: activeList?.version ?? null,
            currentItemId: item,
            syncStatus: syncStateRef.current === 'never' ? 'ready' : syncStateRef.current,
            syncError: syncStateRef.current === 'failed' ? syncError.slice(0, 300) : null,
            cachedMediaCount: await countCachedAssets(),
            storageUsageBytes: stats.usage,
            storageQuotaBytes: stats.quota,
            lastSyncAt: await getLastSyncAt(),
            deviceInfo: deviceInfo(),
          }),
        });
        if (response.status === 401) {
          await clearCredential().catch(() => undefined);
          tokenRef.current = null;
          setToken(null);
          setShowPairForm(!manifestRef.current);
        } else if (response.ok) setOnline(true);
        else if (response.status >= 500) setOnline(false);
      } catch { setOnline(false); }
      finally { heartbeatLock.current = false; }
    };
    void heartbeat();
    const heartbeatTimer = window.setInterval(() => void heartbeat(), 60_000);
    return () => { window.clearInterval(syncTimer); window.clearInterval(heartbeatTimer); };
  }, [booted, token, runSync, syncError]);

  useEffect(() => {
    const updateOnline = () => {
      if (!navigator.onLine) setOnline(false);
      else { setOnline(true); void runSync(tokenRef.current); }
    };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', onOffline);
    return () => { window.removeEventListener('online', updateOnline); window.removeEventListener('offline', onOffline); };
  }, [runSync]);

  useEffect(() => {
    if (!manifest) return;
    const tick = () => {
      const next = scheduledPlaylistId(manifest, new Date());
      if (activePlaylistRef.current !== next) {
        activePlaylistRef.current = next;
        setActivePlaylistId(next);
        setIndex(0);
      }
    };
    tick();
    const timer = window.setInterval(tick, 15_000);
    return () => window.clearInterval(timer);
  }, [manifest]);

  useEffect(() => {
    currentItemIdRef.current = currentItem?.id ?? null;
  }, [currentItem?.id]);

  useEffect(() => {
    if (!currentItem) { setMediaError(false); return; }
    let cancelled = false;
    let createdUrl: string | null = null;
    let skipTimer: number | null = null;
    setMediaError(false);
    getAssetBlob(currentItem.hash).then(blob => {
      if (!blob) throw new Error('تعذر قراءة نسخة الوسيط من التخزين المحلي.');
      createdUrl = URL.createObjectURL(blob);
      if (!cancelled) setMediaUrl({ hash: currentItem.hash, url: createdUrl });
    }).catch(() => {
      if (!cancelled) {
        setMediaError(true);
        skipTimer = window.setTimeout(() => setIndex(value => value + 1), 1200);
      }
    });
    return () => {
      cancelled = true;
      if (skipTimer !== null) window.clearTimeout(skipTimer);
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [currentItem]);

  useEffect(() => {
    if (!currentItem || currentItem.kind !== 'image' || mediaUrl?.hash !== currentItem.hash) return;
    const duration = Math.min(Math.max(currentItem.durationMs ?? 10_000, 1_000), 24 * 60 * 60 * 1000);
    const timer = window.setTimeout(() => setIndex(value => value + 1), duration);
    return () => window.clearTimeout(timer);
  }, [currentItem, mediaUrl?.hash]);

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = pairCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (normalized.length !== 8) { setPairError('أدخل الرمز المكوّن من 8 أحرف.'); return; }
    setPairing(true);
    setPairError('');
    try {
      if (!fullscreenAttempted) {
        setFullscreenAttempted(true);
        document.documentElement.requestFullscreen?.().catch(() => undefined);
      }
      const response = await fetch('/api/player/pair', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: normalized, deviceInfo: deviceInfo() }),
      });
      const value = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(value.error || 'تعذر ربط الشاشة. تحقق من الرمز والاتصال.');
      const result = value as ScreenCredentialResponse;
      await storeCredential(result.credential);
      tokenRef.current = result.credential;
      setToken(result.credential);
      setScreenName(result.screen.name);
      setPairCode('');
      setShowPairForm(false);
      setOnline(true);
      await runSync(result.credential);
    } catch (error) {
      setPairError(error instanceof Error ? error.message : 'تعذر ربط الشاشة.');
    } finally { setPairing(false); }
  };

  const advance = useCallback(() => setIndex(value => value + 1), []);
  const attemptFullscreen = () => {
    if (fullscreenAttempted) return;
    setFullscreenAttempted(true);
    document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  const isReadyToPlay = Boolean(currentItem && mediaUrl?.hash === currentItem.hash && !mediaError);
  const hasLocalPlaylist = Boolean(manifest && currentItem);
  const percent = progress.totalBytes > 0 ? Math.min(100, Math.round(progress.downloadedBytes / progress.totalBytes * 100)) : 0;
  const showInitialPairing = !hasLocalPlaylist;

  return <main className="player-root" onClick={attemptFullscreen} aria-label="مشغل الشاشة">
    <div className="player-stage">
      {isReadyToPlay && currentItem?.kind === 'image' && <img className="player-media" src={mediaUrl?.url} alt="" draggable={false} onError={() => { setMediaError(true); window.setTimeout(advance, 1000); }} />}
      {isReadyToPlay && currentItem?.kind === 'video' && <video
        key={`${currentItem.hash}-${currentItem.id}`}
        className="player-video"
src={mediaUrl?.url}
        autoPlay
        muted
        playsInline
        loop={currentItem.loop}
        preload="auto"
        onEnded={advance}
        onError={() => { setMediaError(true); window.setTimeout(advance, 1200); }}
        onCanPlay={event => { void event.currentTarget.play().catch(() => undefined); }}
        aria-label={currentItem.name}
      />}
      {!isReadyToPlay && hasLocalPlaylist && <div className="player-fallback" aria-hidden="true" />}
      {showInitialPairing && <div className="player-ui">
        <section className="player-panel">
          <div className="player-logo">ش</div>
          {!token ? <>
            <h1>اربط هذه الشاشة</h1>
            <p>من لوحة الإدارة أنشئ شاشة، ثم أدخل رمز الربط المؤقت أدناه. بعد الربط ستُنزل الوسائط وتحفظ محلياً.</p>
            {pairError && <div className="alert error">{pairError}</div>}
            <form onSubmit={pair}>
              <div className="field"><label htmlFor="pair-code">رمز الربط</label><input id="pair-code" inputMode="text" autoComplete="one-time-code" autoCapitalize="characters" maxLength={9} value={pairCode} onChange={event => setPairCode(event.target.value.toUpperCase())} placeholder="ABCD-EFGH" autoFocus /></div>
              <button className="button teal" type="submit" disabled={pairing}>{pairing ? 'جارٍ الربط…' : 'ربط الشاشة'}</button>
            </form>
            <p className="player-footnote" style={{ marginTop: 15 }}>يُستخدم الرمز مرة واحدة وينتهي خلال 15 دقيقة. لا تدخل بيانات حساب المدير على التلفاز.</p>
          </> : <>
            <h1>{syncState === 'failed' ? 'المحتوى المحلي محفوظ' : 'مزامنة المحتوى'}</h1>
            <p>{progress.message || syncError || 'يتم تنزيل الوسائط المطلوبة إلى التخزين المحلي.'}</p>
            {syncError && <div className="alert warning">{syncError}</div>}
            {progress.totalBytes > 0 && <><div className="progress-track"><div className="progress-fill" style={{ width: `${percent}%` }} /></div><div className="player-footnote">{percent}% · {bytesLabel(progress.downloadedBytes)} من {bytesLabel(progress.totalBytes)}{progress.currentName ? ` · ${progress.currentName}` : ''}</div></>}
            <p className="player-footnote" style={{ marginTop: 14 }}>تأكد من بقاء التلفاز متصلاً حتى اكتمال التنزيل والتحقق. سيُفعّل المحتوى الجديد بعد اكتمال جميع الملفات فقط.</p>
          </>}
        </section>
      </div>}
      {hasLocalPlaylist && showPairForm && <div className="player-ui" style={{ background: 'rgba(3,8,14,.58)' }}>
        <section className="player-panel">
          <div className="player-logo">ش</div><h1>إعادة ربط الشاشة</h1>
          <p>يستمر المحتوى المخزّن محلياً أثناء إعادة الربط.</p>
          {pairError && <div className="alert error">{pairError}</div>}
          <form onSubmit={pair}>
            <div className="field"><label htmlFor="re-pair-code">رمز الربط المؤقت</label><input id="re-pair-code" autoComplete="one-time-code" maxLength={9} value={pairCode} onChange={event => setPairCode(event.target.value.toUpperCase())} placeholder="ABCD-EFGH" /></div>
            <button className="button teal" type="submit" disabled={pairing}>{pairing ? 'جارٍ الربط…' : 'تأكيد الربط'}</button>
            <button className="button secondary" type="button" style={{ marginRight: 8 }} onClick={() => setShowPairForm(false)}>العودة إلى العرض</button>
          </form>
        </section>
      </div>}
      {hasLocalPlaylist && !showPairForm && (token ? <div className="player-status" aria-live="polite">
        <span style={{ color: online ? '#2dd4bf' : '#c4cbd5' }}>●</span>
        <span>{online ? 'تشغيل محلي' : 'تشغيل محلي دون اتصال'}</span>
        <span>·</span><span>{screenName || manifest?.screen.name || 'الشاشة'}</span>
      </div> : <button className="player-status" style={{ border: 0, background: 'transparent', color: 'white' }} onClick={() => setShowPairForm(true)} aria-label="إعادة ربط الشاشة">● تشغيل محلي · إعادة الربط</button>)}
      {hasLocalPlaylist && mediaError && <div className="player-status" role="status">تعذر قراءة وسيط محلي؛ الانتقال إلى العنصر التالي…</div>}
      {!hasLocalPlaylist && token && !showInitialPairing && <div className="player-ui"><section className="player-panel"><h1>لا يوجد محتوى منشور</h1><p>عيّن قائمة تشغيل منشورة لهذه الشاشة أو أضف جدولاً زمنياً من لوحة الإدارة.</p><button className="button secondary" onClick={() => void runSync(token)}>إعادة التحقق</button></section></div>}
      {booted && storage.persisted === false && <span className="player-footnote" style={{ position: 'absolute', bottom: 15, right: 15 }}>تنبيه: المتصفح لم يؤكد الاحتفاظ الدائم بالتخزين.</span>}
      {!booted && <div className="player-ui"><section className="player-panel"><div className="player-logo">ش</div><p>جارٍ استعادة القائمة المحفوظة…</p></section></div>}
      {booted && !hasLocalPlaylist && token && (progress.phase === 'downloading' || progress.phase === 'checking') && <div className="player-status">{cachedCount} وسائط محلية · آخر مزامنة {lastSyncAt ? new Date(lastSyncAt).toLocaleString('ar-SA') : 'لم تتم بعد'}</div>}
    </div>
  </main>;
}
