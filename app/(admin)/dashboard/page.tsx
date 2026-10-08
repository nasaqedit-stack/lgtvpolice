'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/admin-common';

type Screen = { id: string; name: string; online: boolean; last_seen_at?: string | null; assignedPlaylist?: { name: string } | null };
type LiveState = {
  screen: { id: string; name: string };
  online: boolean;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  syncStatus: string;
  syncError: string | null;
  currentItemId: string | null;
  playbackState: string;
  playlist: { id: string; name: string | null; version: number | null } | null;
  media: { id: string; name: string; kind: 'image' | 'video'; mimeType: string; width: number | null; height: number | null } | null;
  previewUrl: string | null;
  cachedMediaCount: number;
  previewNote: string | null;
};

const dateTime = (value?: string | null) => value ? new Intl.DateTimeFormat('ar-SA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'لم تتصل بعد';

export default function DashboardPage() {
  const [summary, setSummary] = useState<any>(null);
  const [screens, setScreens] = useState<Screen[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [live, setLive] = useState<LiveState | null>(null);
  const [error, setError] = useState('');
  const [liveError, setLiveError] = useState('');
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewAsset = useRef<{ screenId: string; mediaId: string; itemId: string | null; url: string; refreshedAt: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const [counts, screenList] = await Promise.all([api('/api/admin/summary'), api('/api/admin/screens')]);
      const nextScreens = (screenList.screens ?? []) as Screen[];
      setSummary(counts);
      setScreens(nextScreens);
      setSelectedId(current => current && nextScreens.some(screen => screen.id === current) ? current : (nextScreens[0]?.id ?? ''));
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر تحميل الملخص.'); }
    finally { setLoading(false); }
  }, []);

  const loadLive = useCallback(async (screenId: string) => {
    if (!screenId) { setLive(null); return; }
    setPreviewLoading(true);
    try {
      const response = await api<LiveState>(`/api/admin/live-preview?screenId=${encodeURIComponent(screenId)}`);
      const prior = previewAsset.current;
      const sameItem = Boolean(response.media && response.previewUrl && prior
        && prior.screenId === screenId && prior.mediaId === response.media.id && prior.itemId === response.currentItemId);
      let state = response;
      if (sameItem && prior && Date.now() - prior.refreshedAt < 4 * 60_000) {
        state = { ...response, previewUrl: prior.url };
      } else if (response.media && response.previewUrl) {
        previewAsset.current = { screenId, mediaId: response.media.id, itemId: response.currentItemId, url: response.previewUrl, refreshedAt: Date.now() };
      } else {
        previewAsset.current = null;
      }
      setLive(state);
      setLiveError('');
    } catch (reason) {
      setLiveError(reason instanceof Error ? reason.message : 'تعذر تحديث معاينة الشاشة.');
    } finally { setPreviewLoading(false); }
  }, []);

  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30_000); return () => window.clearInterval(timer); }, [load]);
  useEffect(() => { if (selectedId) void loadLive(selectedId); else setLive(null); }, [loadLive, selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    const timer = window.setInterval(() => void loadLive(selectedId), 20_000);
    return () => window.clearInterval(timer);
  }, [loadLive, selectedId]);

  const statusLabel = useMemo(() => {
    if (!live) return 'جارٍ تحميل الحالة';
    if (!live.online) return 'غير متصلة';
    if (live.syncStatus === 'syncing') return 'تزامن جارٍ';
    if (live.syncStatus === 'failed') return 'تعذر التحديث';
    return live.playbackState === 'playing' ? 'متصلة · تعرض المحتوى' : 'متصلة';
  }, [live]);

  return <div className="page-content dashboard-content">
    <PageHeader title="مرحباً بك في لوحة الشاشات" description="حالة التشغيل ومزامنة المحتوى في لمحة." action={<Link href="/screens" className="button teal">＋ إضافة شاشة</Link>} />
    {error && <ErrorState message={error} retry={() => void load()} />}
    {loading && !summary ? <LoadingState /> : summary && <>
      <div className="stat-grid">
        <Stat icon="▣" label="إجمالي الشاشات" value={summary.totalScreens} foot="الشاشات المفعّلة" />
        <Stat icon="●" label="متصلة الآن" value={summary.onlineScreens} foot={`${summary.offlineScreens} شاشة غير متصلة`} />
        <Stat icon="⇅" label="مزامنة معلّقة" value={summary.pendingSync} foot="تُحدّث عند عودة الاتصال" />
        <Stat icon="▧" label="الوسائط" value={summary.mediaCount} foot={`${summary.activePlaylists} قائمة منشورة ونشطة`} />
      </div>

      <section className="card card-pad live-dashboard" aria-labelledby="live-title">
        <div className="section-title live-heading">
          <div><h3 id="live-title">معاينة الشاشة المباشرة</h3><span>الحالة والمحتوى من آخر نبضة فعلية</span></div>
          <div className="live-select-wrap">
            <label htmlFor="live-screen-select">الشاشة</label>
            <select id="live-screen-select" value={selectedId} onChange={event => setSelectedId(event.target.value)} disabled={!screens.length}>
              {screens.length ? screens.map(screen => <option key={screen.id} value={screen.id}>{screen.name}</option>) : <option value="">لا توجد شاشات</option>}
            </select>
          </div>
        </div>
        {!screens.length ? <EmptyState title="لا توجد شاشات لعرضها" description="أضف شاشة واربطها لتظهر حالتها هنا." action={<Link href="/screens" className="button small teal">إضافة شاشة</Link>} /> : <div className="live-layout">
          <div className={`screen-preview ${live && !live.online ? 'is-stale' : ''}`} aria-label="معاينة محتوى الشاشة بنسبة 16 إلى 9">
            {live?.media && live.previewUrl ? live.media.kind === 'video'
              ? <video key={live.media.id + live.previewUrl} src={live.previewUrl} autoPlay muted playsInline loop className="screen-preview-media" />
              : <img key={live.media.id + live.previewUrl} src={live.previewUrl} alt={live.media.name} className="screen-preview-media" />
              : <div className="preview-placeholder"><span aria-hidden="true">▣</span><strong>{live?.online ? 'لا يوجد وسيط حالي في نبضة الشاشة' : 'بانتظار اتصال الشاشة'}</strong><small>{previewLoading ? 'جارٍ تحديث الحالة…' : liveError || 'تعرض هنا معاينة المحتوى الذي أبلغ عنه المشغل.'}</small></div>}
            <span className={`preview-status ${live?.online ? 'online' : 'offline'}`}><i />{live?.online ? (live.syncStatus === 'syncing' ? 'تزامن جارٍ' : 'متصلة') : 'غير متصلة'}</span>
          </div>
          <div className="live-details">
            <div className="live-screen-title"><div><small>الشاشة المحددة</small><h4>{live?.screen.name ?? screens.find(screen => screen.id === selectedId)?.name ?? '—'}</h4></div><Badge tone={live?.online ? 'online' : 'offline'}>{statusLabel}</Badge></div>
            <dl>
              <div><dt>المحتوى الحالي</dt><dd>{live?.media?.name ?? 'غير متاح'}</dd></div>
              <div><dt>قائمة التشغيل</dt><dd>{live?.playlist?.name ?? (live?.playlist ? 'قائمة منشورة' : '—')}{live?.playlist?.version ? ` · الإصدار ${live.playlist.version}` : ''}</dd></div>
              <div><dt>حالة التشغيل</dt><dd>{live?.playbackState === 'playing' ? 'يعرض محتوى' : live?.playbackState === 'waiting' ? 'متصلة · بانتظار المحتوى' : 'غير متصلة'}</dd></div>
              <div><dt>آخر اتصال</dt><dd>{dateTime(live?.lastSeenAt)}</dd></div>
              <div><dt>آخر مزامنة ناجحة</dt><dd>{dateTime(live?.lastSyncAt)}</dd></div>
            </dl>
            {live?.previewNote && <p className="preview-disclaimer">{live.previewNote}</p>}
            {liveError && live?.media && <p className="preview-disclaimer">تعذر تحديث بيانات المعاينة؛ قد تكون الحالة المعروضة قديمة. {liveError}</p>}
            <div className="live-actions"><Link href="/screens" className="button secondary small">إدارة الشاشة</Link><span>{previewLoading ? 'جارٍ التحديث…' : `تحديث تلقائي كل 20 ثانية`}</span></div>
          </div>
        </div>}
      </section>

      <div className="grid-2 dashboard-lower">
        <section className="card card-pad">
          <div className="section-title"><h3>الشاشات الأخيرة</h3><Link href="/screens" className="section-link">عرض الكل ←</Link></div>
          {screens.length === 0 ? <EmptyState title="لا توجد شاشات بعد" description="أضف شاشة من صفحة إدارة الشاشات لبدء الاقتران." action={<Link className="button small teal" href="/screens">إضافة شاشة</Link>} /> : <div className="table-wrap"><table><thead><tr><th>الشاشة</th><th>الحالة</th><th>القائمة المعيّنة</th></tr></thead><tbody>
            {screens.slice(0, 7).map(screen => <tr key={screen.id}><td><span className="table-name">{screen.name}</span><span className="table-sub">{screen.id.slice(0, 8)}</span></td><td><Badge tone={screen.online ? 'online' : 'offline'}>{screen.online ? 'متصلة' : 'غير متصلة'}</Badge></td><td>{screen.assignedPlaylist?.name ?? '—'}</td></tr>)}
          </tbody></table></div>}
        </section>
        <section className="card card-pad">
          <div className="section-title"><h3>حالة المحتوى</h3><span>التشغيل دون اتصال</span></div>
          <div className="alert info" style={{ marginBottom: 15 }}><strong>الأولوية للتخزين المحلي</strong><br />ينزّل المشغل الملفات إلى IndexedDB ويتحقق من بصمتها قبل تفعيل أي تحديث. انقطاع الإنترنت لا يوقف قائمة التشغيل المفعّلة.</div>
          <div style={{ display: 'grid', gap: 11 }}>
            <QuickLink href="/media" icon="▧" title="رفع الوسائط" text="صور وملفات MP4 حتى 2 جيجابايت، برفع متعدد الأجزاء." />
            <QuickLink href="/playlists" icon="≡" title="إنشاء قائمة تشغيل" text="رتّب الصور والفيديو ثم انشر نسخة جديدة بأمان." />
            <QuickLink href="/schedule" icon="◷" title="إعداد الجدولة" text="تبديل القوائم حسب الوقت يعمل وفق ساعة الجهاز محلياً." />
          </div>
        </section>
      </div>
    </>}
  </div>;
}
function Stat({ icon, label, value, foot }: { icon: string; label: string; value: number; foot: string }) {
  return <section className="card stat-card"><div className="stat-top"><span>{label}</span><span className="stat-icon">{icon}</span></div><div className="stat-number">{new Intl.NumberFormat('ar').format(value ?? 0)}</div><div className="stat-foot">{foot}</div></section>;
}
function QuickLink({ href, icon, title, text }: { href: string; icon: string; title: string; text: string }) {
  return <Link href={href} className="quick-link"><span className="quick-icon">{icon}</span><span><strong>{title}</strong><small>{text}</small></span><span className="quick-arrow">←</span></Link>;
}
