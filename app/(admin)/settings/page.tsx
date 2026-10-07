'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { formatBytes } from '@/lib/shared';
import { ErrorState, LoadingState, PageHeader } from '@/components/admin-common';

export default function SettingsPage() {
  const [settings, setSettings] = useState<any>(null);
  const [error, setError] = useState('');
  const [origin, setOrigin] = useState('');
  const load = useCallback(async () => {
    setError('');
    try { setSettings(await api('/api/admin/settings')); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر قراءة الإعدادات.'); }
  }, []);
  useEffect(() => { void load(); setOrigin(window.location.origin); }, [load]);
  return <div className="page-content">
    <PageHeader title="الإعدادات" description="حالة ربط الخدمات ومتطلبات التشغيل. مفاتيح الإدارة والتخزين لا تُرسل إلى المتصفح." />
    {error && <ErrorState message={error} retry={() => void load()} />}
    {!settings && !error ? <LoadingState /> : settings && <div className="grid-2" style={{ marginTop: 0 }}>
      <section className="card card-pad"><div className="section-title"><h3>الخدمات الخلفية</h3><span>معلومات آمنة فقط</span></div><div style={{ display: 'grid', gap: 13 }}>
        <Setting label="قاعدة البيانات والمصادقة" value="Supabase Auth + PostgreSQL" status="متصل" />
        <Setting label="تخزين الكائنات" value={settings.objectStorageConfigured ? `Supabase Storage · ${settings.bucket}` : 'غير مكتمل الإعداد'} status={settings.objectStorageConfigured ? 'جاهز' : 'يتطلب مفاتيح خادم'} warning={!settings.objectStorageConfigured} />
        <Setting label="حد الملف" value={formatBytes(settings.maxMediaBytes)} />
        <Setting label="النشر" value={settings.deployment} />
      </div><div className="alert warning" style={{ marginTop: 15 }}>لا تضع مفتاح الخدمة أو مفاتيح S3 في متغيرات <code>NEXT_PUBLIC_</code>. مفاتيح S3 تبقى في الخادم فقط.</div></section>
      <section className="card card-pad"><div className="section-title"><h3>إعداد مشغل التلفاز</h3><span>Offline-first</span></div><div style={{ display: 'grid', gap: 11 }}>
        <Setting label="مسار المشغل" value={`${origin}/player`} dir="ltr" />
        <Setting label="المنطقة الافتراضية" value={settings.timezone} dir="ltr" />
        <Setting label="التخزين الدائم" value={settings.playerStorage} />
        <div className="alert info">عند أول زيارة يطلب المشغل الاحتفاظ الدائم بالتخزين، ويحفظ ملفات الوسائط وأجزاءها في IndexedDB. تحفظ Service Worker واجهة المشغل فقط، ولا تُستخدم لتخزين ملفات الفيديو الكبيرة.</div>
        <div className="alert warning">تُفضّل الملفات MP4 ذات ترميز H.264 للفيديو وAAC للصوت. لا ينفّذ النظام تحويل ترميز؛ اختبر الملفات على طراز webOS الفعلي قبل النشر المؤسسي.</div>
      </div></section>
      <section className="card card-pad"><div className="section-title"><h3>أمان البيانات</h3></div><ul style={{ lineHeight: 2, color: 'var(--muted)', paddingRight: 20, margin: 0 }}>
        <li>اعتماد كل شاشة سر عشوائي عالي الانتروبيا؛ قاعدة البيانات تحتفظ ببصمته فقط.</li>
        <li>رموز الاقتران مؤقتة، أحادية الاستخدام، ومحدودة المحاولات.</li>
        <li>الوسائط خاصة وتصل إليها الشاشة عبر روابط تنزيل موقعة قصيرة العمر.</li>
        <li>لا توجد بيانات اعتماد إدارية على التلفاز.</li>
        <li>إلغاء الاعتماد يحتاج اتصالاً لاحقاً ليُبلّغ اللاعب؛ التخزين المحلي يواصل التشغيل عند الانقطاع.</li>
      </ul></section>
      <section className="card card-pad"><div className="section-title"><h3>الروابط</h3></div><div style={{ display: 'grid', gap: 10 }}><a className="button secondary" href="/player" target="_blank" rel="noreferrer">فتح مشغل التلفاز ↗</a><a className="button secondary" href="/tv-setup">دليل إعداد التلفاز ↗</a></div></section>
    </div>}
  </div>;
}
function Setting({ label, value, status, warning, dir }: { label: string; value: string; status?: string; warning?: boolean; dir?: 'ltr' | 'rtl' }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', paddingBottom: 10, borderBottom: '1px solid var(--line)' }}><span style={{ color: 'var(--muted)' }}>{label}</span><span style={{ textAlign: 'left' }} dir={dir}>{value}{status && <small style={{ display: 'block', color: warning ? '#a5701e' : '#238d81', marginTop: 3 }}>{status}</small>}</span></div>;
}
