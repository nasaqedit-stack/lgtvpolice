import type { Metadata } from 'next';
import { createSupabaseAdmin } from '@/lib/server/supabase';
import { loadSubmissionLink } from '@/lib/server/submissions';
import SubmitForm from './submit-form';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'مشاركة محتوى توعوي',
  description: 'إرسال مادة توعوية أو تعليمية لمراجعتها والنشر بعد الاعتماد.',
  robots: { index: false, follow: false },
};

type Context = { params: Promise<{ token: string }> };

/**
 * Public submission page. The link token is the only authorization: no admin account, no admin
 * route and no storage credential is involved. The page only renders the contribution form for
 * awareness/educational material; it never lists other submissions.
 */
export default async function SubmitPage({ params }: Context) {
  const { token } = await params;
  let link: { id: string; label: string; expires_at: string | null } | null = null;
  let invalidReason = '';
  try {
    const db = createSupabaseAdmin();
    link = await loadSubmissionLink(db, token);
  } catch (error) {
    invalidReason = error instanceof Error ? error.message : 'رابط غير صالح.';
  }

  return (
    <main className="submit-page" dir="rtl">
      <div className="submit-card card">
        <div className="submit-card-body card-pad">
          <div className="brand" style={{ paddingBottom: 18 }}>
            <div className="brand-mark">ش</div>
            <div><strong>شاشات</strong><small>منصة العرض المؤسسي</small></div>
          </div>
          {link ? (
            <SubmitForm token={token} linkLabel={link.label} expiresAt={link.expires_at} />
          ) : (
            <div>
              <h2 style={{ fontSize: 22, margin: '0 0 8px' }}>رابط المشاركة غير متاح</h2>
              <p style={{ color: 'var(--muted)', lineHeight: 1.8, marginTop: 0 }}>
                {invalidReason || 'رابط المشاركة غير صالح أو منتهٍ أو تم إيقافه.'} تواصل مع المسؤول للحصول على رابط صالح.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
