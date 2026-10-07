'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/admin-common';

export default function DashboardPage() {
  const [summary, setSummary] = useState<any>(null);
  const [screens, setScreens] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setError('');
    try {
      const [counts, screenList] = await Promise.all([api('/api/admin/summary'), api('/api/admin/screens')]);
      setSummary(counts);
      setScreens(screenList.screens.slice(0, 7));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر تحميل الملخص.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return <div className="page-content">
    <PageHeader title="مرحباً بك في لوحة الشاشات" description="حالة تشغيل منظومة العرض ومزامنة المحتوى في لمحة." action={<Link href="/screens" className="button teal">＋ إضافة شاشة</Link>} />
    {error && <ErrorState message={error} retry={() => void load()} />}
    {loading && !summary ? <LoadingState /> : summary && <>
      <div className="stat-grid">
        <Stat icon="▣" label="إجمالي الشاشات" value={summary.totalScreens} foot="الشاشات المفعّلة" />
        <Stat icon="●" label="متصلة الآن" value={summary.onlineScreens} foot={`${summary.offlineScreens} شاشة غير متصلة`} />
        <Stat icon="⇅" label="مزامنة معلّقة" value={summary.pendingSync} foot="تُحدّث عند عودة الاتصال" />
        <Stat icon="▧" label="الوسائط" value={summary.mediaCount} foot={`${summary.activePlaylists} قائمة منشورة ونشطة`} />
      </div>
      <div className="grid-2">
        <section className="card card-pad">
          <div className="section-title"><h3>الشاشات الأخيرة</h3><Link href="/screens" style={{ color: '#238d81', fontSize: 12 }}>عرض الكل ←</Link></div>
          {screens.length === 0 ? <EmptyState title="لا توجد شاشات بعد" description="أضف شاشة من صفحة إدارة الشاشات لبدء الاقتران." action={<Link className="button small teal" href="/screens">إضافة شاشة</Link>} /> : <div className="table-wrap"><table><thead><tr><th>الشاشة</th><th>الحالة</th><th>القائمة المعيّنة</th></tr></thead><tbody>
            {screens.map(screen => <tr key={screen.id}><td><span className="table-name">{screen.name}</span><span className="table-sub">{screen.id.slice(0, 8)}</span></td><td><Badge tone={screen.online ? 'online' : 'offline'}>{screen.online ? 'متصلة' : 'غير متصلة'}</Badge></td><td>{screen.assignedPlaylist?.name ?? '—'}</td></tr>)}
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
  return <Link href={href} style={{ padding: 12, background: '#f8fafc', borderRadius: 11, display: 'flex', gap: 11, alignItems: 'center' }}><span style={{ fontSize: 20, color: '#26998d' }}>{icon}</span><span><strong style={{ display: 'block', fontSize: 12 }}>{title}</strong><small style={{ display: 'block', color: 'var(--muted)', marginTop: 3, lineHeight: 1.5 }}>{text}</small></span><span style={{ marginRight: 'auto', color: '#90a0b2' }}>←</span></Link>;
}
