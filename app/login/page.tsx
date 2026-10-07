'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowser } from '@/lib/client/supabase';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { error: authError } = await createSupabaseBrowser().auth.signInWithPassword({ email, password });
      if (authError) throw authError;
      router.replace('/dashboard');
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر تسجيل الدخول. تحقق من البيانات.');
    } finally {
      setBusy(false);
    }
  };
  return <main className="login-wrap">
    <section className="login-aside" dir="rtl">
      <div className="brand"><div className="brand-mark">ش</div><div><strong>شاشات</strong><small>إدارة العرض المؤسسي</small></div></div>
      <h1>محتواك مستمر، حتى بدون إنترنت.</h1>
      <p>أدر الشاشات وقوائم التشغيل من مكان واحد. تتم مزامنة الوسائط إلى ذاكرة الجهاز المحلية لتستمر العروض عند انقطاع الاتصال.</p>
      <div className="login-features"><div>✓ تشغيل الصور والفيديو محلياً بعد المزامنة</div><div>✓ تحديث آمن لا يستبدل القائمة العاملة قبل اكتمال التنزيل</div><div>✓ جداول عرض تعمل وفق توقيت الرياض</div></div>
    </section>
    <section className="login-form-side" dir="rtl">
      <form className="login-form" onSubmit={submit}>
        <h2>تسجيل الدخول</h2>
        <p>أدخل حساب مشرف المنصة للمتابعة.</p>
        {error && <div className="alert error" style={{ marginBottom: 15 }}>{error}</div>}
        <div className="field"><label htmlFor="email">البريد الإلكتروني</label><input id="email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor="password">كلمة المرور</label><input id="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></div>
        <button className="button teal" disabled={busy}>{busy ? 'جارٍ التحقق…' : 'دخول آمن'}</button>
        <small style={{ display: 'block', textAlign: 'center', color: 'var(--muted)', marginTop: 18, lineHeight: 1.7 }}>تُدار الحسابات عبر Supabase Auth. لا تُخزّن بيانات المدير على جهاز التلفاز.</small>
      </form>
    </section>
  </main>;
}
