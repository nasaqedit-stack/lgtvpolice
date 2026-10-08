'use client';

import { ChangeEvent, FormEvent, useRef, useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { api, jsonBody, withRequestTimeout } from '@/lib/client/api';
import { buildPartManifest, uploadParts } from '@/lib/client/media-upload';
import { formatBytes } from '@/lib/shared';
import {
  CONSENT_TEXT_AR,
  CONSENT_VERSION,
  SUBMISSION_ALLOWED_MIME_TYPES,
  SUBMISSION_MAX_FILE_SIZE,
  SUBMISSION_MIME_KIND,
  type SubmissionMimeType,
} from '@/lib/shared/submissions';

const COMPLETE_TIMEOUT_MS = 280_000;

type Props = { token: string; linkLabel: string; expiresAt: string | null };

type Phase = 'form' | 'review' | 'uploading' | 'done';

function detectType(file: File): { mimeType: SubmissionMimeType; kind: 'image' | 'video' } | null {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const byExtension = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
    : extension === 'png' ? 'image/png'
    : extension === 'webp' ? 'image/webp'
    : extension === 'mp4' ? 'video/mp4'
    : extension === 'mov' ? 'video/quicktime' : null;
  if (!byExtension || !(SUBMISSION_ALLOWED_MIME_TYPES as readonly string[]).includes(byExtension)) return null;
  if (file.type && file.type !== byExtension && !(byExtension === 'image/jpeg' && file.type === 'image/jpg')
    && !(byExtension === 'video/quicktime' && (file.type === 'video/x-quicktime' || file.type === 'application/octet-stream'))) return null;
  return { mimeType: byExtension as SubmissionMimeType, kind: SUBMISSION_MIME_KIND[byExtension as SubmissionMimeType] };
}

async function hashFile(file: File, progress: (value: number) => void): Promise<string> {
  const digest = sha256.create();
  const chunk = 8 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunk) {
    const bytes = await withRequestTimeout('قراءة جزء من الملف', 30_000, () => file.slice(offset, Math.min(offset + chunk, file.size)).arrayBuffer());
    digest.update(new Uint8Array(bytes));
    progress(Math.min(offset + chunk, file.size));
  }
  return bytesToHex(digest.digest());
}

/**
 * Public contribution form — mobile friendly, no account required.
 *
 * The page explains the purpose (security awareness / education / public awareness), warns
 * clearly that classified, secret, confidential or restricted information must NOT be uploaded,
 * requires an explicit consent checkbox before submission, and states that submission does not
 * mean publication: the responsible administrator reviews the material and publication happens
 * only after final approval.
 */
export default function SubmitForm({ token, linkLabel, expiresAt }: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [contributorName, setContributorName] = useState('');
  const [contributorContact, setContact] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [reviewConfirm, setReviewConfirm] = useState(false);
  const [phase, setPhase] = useState<Phase>('form');
  const [progress, setProgress] = useState(0);
  const [progressPhase, setProgressPhase] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ id: string; state: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pickFile = (event: ChangeEvent<HTMLInputElement>) => {
    setError('');
    const selected = event.target.files?.[0] ?? null;
    if (!selected) { setFile(null); return; }
    const info = detectType(selected);
    if (!info) {
      setFile(null);
      setError('نوع الملف غير مدعوم. الصيغ المقبولة: JPG وPNG وWebP وMP4 وMOV. لا يتم قبول SVG أو HTML أو أي ملفات تنفيذية.');
      return;
    }
    if (selected.size <= 0 || selected.size > SUBMISSION_MAX_FILE_SIZE) {
      setFile(null);
      setError(`حجم الملف يجب أن يكون بين بايت واحد و${Math.round(SUBMISSION_MAX_FILE_SIZE / 1024 / 1024)} ميجابايت.`);
      return;
    }
    setFile(selected);
  };

  const canReview = Boolean(
    file && title.trim().length >= 3 && contributorName.trim().length >= 2
    && contributorContact.trim().length >= 5 && consent,
  );

  const submit = async () => {
    if (!file || !canReview) return;
    setError('');
    setPhase('uploading');
    setProgress(0);
    try {
      setProgressPhase('حساب بصمة الملف…');
      const hash = await hashFile(file, value => setProgress(Math.round(value / file.size * 40)));
      setProgressPhase('تهيئة جلسة الرفع…');
      const session = await api(`/api/submit/${token}/uploads`, {
        method: 'POST',
        body: jsonBody({
          fileName: file.name,
          fileSize: file.size,
          mimeType: detectType(file)!.mimeType,
          title: title.trim(),
          description: description.trim(),
          contributorName: contributorName.trim(),
          contributorContact: contributorContact.trim(),
          consentAccepted: true,
          consentVersion: CONSENT_VERSION,
          consentText: CONSENT_TEXT_AR,
        }),
      });
      const uploadId = session.uploadId as string;
      const totalParts = Number(session.totalParts);
      setProgressPhase('رفع الملف…');
      const uploadedParts = await uploadParts(file, uploadId, Array.from({ length: totalParts }, (_, index) => index + 1), bytes => {
        setProgress(40 + Math.round(bytes / file.size * 50));
      }, `/api/submit/${token}/uploads/${uploadId}/parts`);
      setProgressPhase('معالجة الوسائط… قد تستغرق دقائق للفيديو');
      const completed = await api(`/api/submit/${token}/uploads/${uploadId}/complete`, {
        method: 'POST',
        body: jsonBody({ sha256: hash, parts: buildPartManifest(file.size, uploadedParts) }),
      }, COMPLETE_TIMEOUT_MS);
      setResult({ id: completed.submission.id, state: completed.submission.state });
      setProgress(100);
      setPhase('done');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر إرسال المشاركة.');
      setPhase('form');
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: 22, margin: '0 0 6px' }}>مشاركة مادة توعوية</h2>
      <p style={{ color: 'var(--muted)', marginTop: 0, lineHeight: 1.8 }}>
        {linkLabel} — هذه الاستمارة لتقديم مواد <strong>للتوعية الأمنية والتعليمية والإعلامية</strong> المقصود منها للنشر العام بعد المراجعة.
      </p>

      <div className="alert info">
        <strong>قبل الرفع — اقرأ هذا أولًا:</strong>
        <ul style={{ margin: '6px 0 0', paddingRight: 18, lineHeight: 1.9 }}>
          <li>المادة يجب أن تكون <strong>للتوعية الأمنية أو التعليم أو التوعية العامة</strong>، وهدفها النشر العام بعد المراجعة.</li>
          <li><strong>يمنع منعًا باتًا رفع أي معلومات سرية أو مصنفة أو مقيّدة أو محظورة</strong>، أو أي بيانات لا تملك حق مشاركتها. هذه الاستمارة ليست قناة آمنة للمعلومات الأمنية الحساسة.</li>
          <li>الإرسال لا يعني النشر تلقائيًا.</li>
          <li>يحدث النشر فقط بعد <strong>الاعتماد النهائي</strong> من المسؤول.</li>
        </ul>
      </div>

      {phase === 'done' && result && (
        <div className="alert success" style={{ marginTop: 14 }}>
          <strong>تم استلام مشاركتك بنجاح.</strong>
          <div style={{ marginTop: 6, lineHeight: 1.9 }}>
            رقم المشاركة: <code dir="ltr">{result.id}</code>
            <br />الحالة: <span className="badge pending">قيد المراجعة</span>
            <br />ستُراجع من المسؤول، ولا تُنشر إلا بعد الاعتماد النهائي.
          </div>
        </div>
      )}

      {phase !== 'done' && phase !== 'review' && phase !== 'uploading' && (
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); if (canReview) { setPhase('review'); setReviewConfirm(false); } else { setError('أكمل الحقول المطلوبة ووافق على الإقرار أولًا.'); } }}>
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="title">عنوان المادة *</label>
            <input id="title" required minLength={3} maxLength={240} value={title} onChange={event => setTitle(event.target.value)} placeholder="مثال: حملة توعية أمنية للمدارس" />
          </div>
          <div className="field">
            <label htmlFor="description">وصف مختصر (اختياري)</label>
            <textarea id="description" maxLength={2000} value={description} onChange={event => setDescription(event.target.value)} placeholder="اشرح الغرض والفئة المستهدفة من المادة" />
          </div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="name">اسمك *</label>
              <input id="name" required minLength={2} maxLength={120} value={contributorName} onChange={event => setContributorName(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="contact">البريد الإلكتروني أو رقم الهاتف *</label>
              <input id="contact" required maxLength={200} dir="auto" value={contributorContact} onChange={event => setContact(event.target.value)} placeholder="you@example.org" />
            </div>
          </div>

          <div className="field">
            <label>الملف (صورة أو فيديو) *</label>
            <div className="upload-drop" onClick={() => inputRef.current?.click()}>
              <strong>{file ? file.name : 'اضغط لاختيار ملف'}</strong>
              <small>{file ? `${formatBytes(file.size)} · ${detectType(file)?.kind === 'video' ? 'فيديو' : 'صورة'}` : `JPG · PNG · WebP · MP4 · MOV — بحد أقصى ${Math.round(SUBMISSION_MAX_FILE_SIZE / 1024 / 1024)} ميجابايت`}</small>
            </div>
            <input ref={inputRef} type="file" accept=".jpg,.jpeg,.png,.webp,.mp4,.mov" style={{ display: 'none' }} onChange={pickFile} />
          </div>

          <label style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10, alignItems: 'start', margin: '16px 0', padding: 14, border: '1px solid var(--line)', borderRadius: 12, background: consent ? '#f2fbf9' : 'white', cursor: 'pointer' }}>
            <input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} style={{ marginTop: 4, width: 18, height: 18 }} />
            <span style={{ fontSize: 13, lineHeight: 1.9 }}>{CONSENT_TEXT_AR}</span>
          </label>

          {error && <div className="alert error" style={{ marginBottom: 12 }}>{error}</div>}

          <button className="button teal" type="submit" disabled={!canReview} style={{ width: '100%' }}>
            مراجعة المشاركة ←
          </button>
          {expiresAt && <small style={{ display: 'block', textAlign: 'center', color: 'var(--muted)', marginTop: 10 }}>ينتهي رابط المشاركة في {new Date(expiresAt).toLocaleString('ar-SA')}</small>}
        </form>
      )}

      {phase === 'review' && file && (
        <div className="card" style={{ border: '1px solid var(--line)', marginTop: 14, padding: 16 }}>
          <div className="section-title"><h3>مراجعة المشاركة قبل الإرسال</h3><span>الخطوة 2 من 2</span></div>
          <div style={{ display: 'grid', gap: 8, fontSize: 13, lineHeight: 1.8 }}>
            <div><strong>العنوان:</strong> {title}</div>
            {description && <div><strong>الوصف:</strong> {description}</div>}
            <div><strong>المساهم:</strong> {contributorName} — <span dir="auto">{contributorContact}</span></div>
            <div><strong>الملف:</strong> {file.name} ({formatBytes(file.size)})</div>
            <div><strong>الإقرار:</strong> <span className="badge online">تمت الموافقة</span> — version {CONSENT_VERSION}</div>
          </div>
          <label style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10, alignItems: 'start', marginTop: 12, padding: 12, border: '1px solid #f0d9a8', borderRadius: 10, background: '#fffaf0', cursor: 'pointer', fontSize: 13, lineHeight: 1.9 }}>
            <input type="checkbox" checked={reviewConfirm} onChange={event => setReviewConfirm(event.target.checked)} style={{ marginTop: 4, width: 18, height: 18 }} />
            <span>أؤكد أن المادة مخصصة للتوعية والتعليم والنشر بعد المراجعة، وأني أملك حق تقديمها، <strong>وألا تحتوي على أي معلومات سرية أو مصنفة أو مقيدة</strong>.</span>
          </label>
          {error && <div className="alert error" style={{ marginTop: 12 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="button secondary" onClick={() => { setPhase('form'); setError(''); }}>رجوع للتعديل</button>
            <button className="button teal" onClick={submit} disabled={!reviewConfirm} style={{ flex: 1 }}>تأكيد الإرسال</button>
          </div>
        </div>
      )}

      {phase === 'uploading' && (
        <div className="card" style={{ border: '1px solid var(--line)', marginTop: 14, padding: 16 }}>
          <div className="section-title"><h3>{progressPhase || 'جارٍ الإرسال…'}</h3><span>{progress}%</span></div>
          <div style={{ height: 8, borderRadius: 99, background: '#edf2f8', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress}%`, background: 'var(--teal)', transition: 'width .2s' }} />
          </div>
          {error && <div className="alert error" style={{ marginTop: 12 }}>{error}</div>}
        </div>
      )}
    </div>
  );
}
