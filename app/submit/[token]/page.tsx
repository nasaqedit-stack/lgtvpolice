'use client';

import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { api, ApiError, jsonBody, withRequestTimeout } from '@/lib/client/api';
import { buildPartManifest, uploadParts } from '@/lib/client/media-upload';
import { runUploadTask, type UploadProgress, type UploadUiState } from '@/lib/client/upload-state';
import { formatBytes } from '@/lib/shared';
import { ErrorState, LoadingState, PageHeader } from '@/components/admin-common';
import { CONSENT_VERSION, CONSENT_TEXT, SUBMISSION_MAX_FILE_SIZE } from '@/lib/shared';

export default function SubmitPage({ params }: { params: Promise<{ token: string }> }) {
  const [tokenData, setTokenData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [upload, setUpload] = useState<UploadUiState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [contributorName, setContributorName] = useState('');
  const [contributorEmail, setContributorEmail] = useState('');
  const [contributorPhone, setContributorPhone] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [mediaInfo, setMediaInfo] = useState<any>(null);
  const [mediaId, setMediaId] = useState('');
  const [step, setStep] = useState<'info' | 'upload' | 'review' | 'complete'>('info');
  const uploadRunning = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadToken = useCallback(async () => {
    const { token } = await params;
    try {
      const result = await api(`/api/submit/${token}`);
      setTokenData(result);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'تعذر تحميل رابط المشاركة.');
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    loadToken();
  }, [loadToken]);

  const processFile = async (file: File, report: UploadProgress) => {
    const info = detectType(file);
    if (!info) throw new Error(`${file.name}: الصيغ المدعومة JPG وPNG وWebP وMP4 وMOV المتوافق فقط.`);
    if (file.size <= 0 || file.size > SUBMISSION_MAX_FILE_SIZE) throw new Error(`${file.name}: الحجم يجب أن يكون بين بايت واحد و2 جيجابايت.`);

    report('قراءة بيانات الملف…');
    let details: any;
    if (info.kind === 'image') details = await inspectImage(file, info.mimeType);
    else details = await inspectVideo(file, info.mimeType);

    report('حساب بصمة SHA-256…');
    const fileHash = await hashFile(file, amount => report('حساب بصمة SHA-256…', amount));

    // Check for duplicate
    const duplicate = await api(`/api/admin/media?hash=${fileHash}`);
    if (duplicate.media?.length) {
      setMediaId(duplicate.media[0].id);
      setMediaInfo({ ...details, duplicate: true, mediaId: duplicate.media[0].id });
      return { duplicate: true, mediaId: duplicate.media[0].id, details };
    }

    // Create upload session
    report('تهيئة رفع متعدد الأجزاء…');
    const session = await api('/api/admin/media/uploads', {
      method: 'POST',
      body: jsonBody({ fileName: file.name, fileSize: file.size, mimeType: info.mimeType }),
    });
    const uploadId = session.uploadId;
    const status = await api(`/api/admin/media/uploads/${uploadId}/status`);

    const existingParts = new Map<number, number>((status.parts ?? []).map((part: any) => [Number(part.partNumber), Number(part.size)]));
    let completedBytes = [...existingParts.values()].reduce((sum, size) => sum + size, 0);
    const partNumbers = Array.from({ length: status.totalParts }, (_, index) => index + 1).filter(partNumber => !existingParts.has(partNumber));

    report('رفع أجزاء الملف إلى تخزين الكائنات…', completedBytes);
    const uploadedParts = await uploadParts(file, uploadId, partNumbers, completed => {
      completedBytes += completed;
      report('رفع أجزاء الملف إلى تخزين الكائنات…', completedBytes);
    });

    report('فحص الملف وإنشاء سجل الوسيط…', file.size);
    const result = await api(`/api/admin/media/uploads/${uploadId}/complete`, {
      method: 'POST',
      body: jsonBody({
        sha256: fileHash,
        width: details.width,
        height: details.height,
        durationMs: details.durationMs,
        thumbnailData: details.thumbnailData,
        compatibility: details.compatibility,
        parts: buildPartManifest(file.size, uploadedParts),
      }),
    }, 55_000);

    if (!result?.media || typeof result.media.id !== 'string') {
      throw new Error('لم يُرجع الخادم سجل الوسيط بعد الإكمال.');
    }
    setMediaId(result.media.id);
    setMediaInfo({ ...details, mediaId: result.media.id });
    return { duplicate: false, mediaId: result.media.id, details };
  };

  const handleFiles = async (files: FileList | File[]) => {
    if (uploadRunning.current) return;
    const list = Array.from(files);
    if (!list.length) return;
    uploadRunning.current = true;
    setError('');
    setUploadError('');
    try {
      const file = list[0];
      setSelectedFile(file);
      await runUploadTask(file, setUpload, async report => {
        const result = await processFile(file, report);
        setMediaInfo(result.details);
        return result;
      });
      setStep('review');
    } catch (reason) {
      setUploadError(reason instanceof Error ? reason.message : `تعذر رفع ${list[0]?.name}.`);
    } finally {
      uploadRunning.current = false;
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const submitForm = async () => {
    if (!mediaId || !consentAccepted) return;
    setError('');
    setUploadError('');
    try {
      const { token } = await params;
      await api(`/api/submit/${token}`, {
        method: 'POST',
        body: jsonBody({
          title,
          description,
          contributorName,
          contributorEmail,
          contributorPhone,
          consentAccepted: true,
          consentVersion: CONSENT_VERSION,
          mediaId,
        }),
      });
      setStep('complete');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'تعذر إرسال المشاركة.');
    }
  };

  const canSubmit = title.trim().length > 0 && mediaId && consentAccepted;

  const isUploading = upload?.status === 'uploading';
  const chooseFiles = () => { if (!isUploading) inputRef.current?.click(); };

  const fileChange = (event: ChangeEvent<HTMLInputElement>) => { if (event.target.files) void handleFiles(event.target.files); };
  const onDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); void handleFiles(event.dataTransfer.files); };

  if (loading) return <LoadingState label="جارٍ تحميل نموذج المشاركة…" />;

  if (error && !tokenData) {
    return <ErrorState message={error} />;
  }

  return <div className="page-content" style={{ maxWidth: 720, margin: '0 auto' }}>
    <PageHeader title="إرسال مشاركة عامة" description="هذا النموذج مخصص للمحتوى الأمني والتوعوي والتعليمي للنشر العام بعد المراجعة والاعتماد." />

    {error && <ErrorState message={error} />}
    {uploadError && <ErrorState message={uploadError} />}

    {step === 'info' && <div className="card card-pad">
      <h3 style={{ marginTop: 0 }}>معلومات المشاركة</h3>
      <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 16 }}>
        <strong>تنبيه مهم:</strong> هذا النظام مخصص للمحتوى الأمني والتوعوي والتعليمي والنشر العام فقط.
        <strong>لا ترفع أي معلومات سرية أو مصنفة أو مقيدة أو بيانات لا تملك حق مشاركتها.</strong>
        المشاركة لا تعني النشر التلقائي — ستمر المادة بمراجعة واعتماد من المدير المسؤول.
      </p>
      <div style={{ display: 'grid', gap: 12 }}>
        <div><label>عنوان المشاركة *</label><input className="search-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="مثال: حملة توعية حول السلامة المرورية" required aria-required="true" /></div>
        <div><label>وصف مختصر</label><textarea className="search-input" value={description} onChange={e => setDescription(e.target.value)} placeholder="وصف موجز للمحتوى…" rows={3} style={{ resize: 'vertical' }} /></div>
        <div><label>اسم المُساهم (اختياري)</label><input className="search-input" value={contributorName} onChange={e => setContributorName(e.target.value)} placeholder="الاسم الثلاثي" /></div>
        <div><label>البريد الإلكتروني (اختياري)</label><input className="search-input" type="email" value={contributorEmail} onChange={e => setContributorEmail(e.target.value)} placeholder="email@example.com" /></div>
        <div><label>رقم الهاتف (اختياري)</label><input className="search-input" value={contributorPhone} onChange={e => setContributorPhone(e.target.value)} placeholder="+966 5X XXX XXXX" /></div>
      </div>
      <button className="button teal" style={{ marginTop: 16 }} onClick={() => setStep('upload')}>التالي: رفع الملف</button>
    </div>}

    {step === 'upload' && tokenData && <div className="card card-pad">
      <h3 style={{ marginTop: 0 }}>رفع الملف</h3>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>
        الأنواع المدعومة: JPG · PNG · WebP · MP4 · MOV (H.264/AAC) · الحد الأقصى 2 جيجابايت
      </p>
      <input ref={inputRef} type="file" disabled={isUploading} accept=".jpg,.jpeg,.png,.webp,.mp4,.mov,image/jpeg,image/png,image/webp,video/mp4,video/quicktime" style={{ display: 'none' }} onChange={fileChange} />
      <div className={`upload-drop ${dragging ? 'dragging' : ''}`} role="button" aria-disabled={isUploading} tabIndex={isUploading ? -1 : 0} onClick={chooseFiles} onDragOver={event => { event.preventDefault(); if (!isUploading) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onKeyDown={event => { if (!isUploading && (event.key === 'Enter' || event.key === ' ')) chooseFiles(); }}>
        <div style={{ fontSize: 27, color: '#26998d' }}>⇧</div><strong>اسحب الملف هنا أو اختر من جهازك</strong>
      </div>
      {upload && <section className={`card card-pad upload-status ${upload.status}`} style={{ marginTop: 14 }} role={upload.status === 'error' ? 'alert' : 'status'} aria-live="polite">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><strong>{upload.name}</strong><span>{upload.phase}</span></div>
        <div className="progress-track" style={{ background: '#e9eef4' }}><div className="progress-fill" style={{ width: `${upload.percent}%` }} /></div>
        <small style={{ color: 'var(--muted)' }}>{upload.percent}% · {formatBytes(upload.uploaded)} / {formatBytes(upload.total)}</small>
        {upload.error && <p style={{ marginBottom: 0 }}><strong>تفاصيل الخطأ:</strong> {upload.error}</p>}
      </section>}
      {mediaInfo && !mediaInfo.duplicate && <div className="alert info" style={{ marginTop: 14, padding: 12 }}>
        <strong>تم رفع الملف بنجاح.</strong> اضغط «التالي: مراجعة وإرسال» للمتابعة.
      </div>}
      {mediaInfo?.duplicate && <div className="alert warning" style={{ marginTop: 14, padding: 12 }}>
        <strong>هذا الملف موجود مسبقاً في المكتبة.</strong> سيتم استخدام النسخة الموجودة.
      </div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="button secondary" onClick={() => setStep('info')}>رجوع</button>
        {mediaInfo && <button className="button teal" onClick={() => setStep('review')}>التالي: مراجعة وإرسال</button>}
      </div>
    </div>}

    {step === 'review' && tokenData && mediaInfo && <div className="card card-pad">
      <h3 style={{ marginTop: 0 }}>مراجعة وإرسال</h3>
      <div style={{ marginBottom: 16 }}>
        <strong>{title}</strong>
        {description && <p style={{ margin: '4px 0 0', color: 'var(--muted)' }}>{description}</p>}
        <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 13 }}>
          الملف: {selectedFile?.name} · {formatBytes(selectedFile?.size ?? 0)} · {mediaInfo.kind === 'video' ? 'فيديو' : 'صورة'}
          {mediaInfo.width && mediaInfo.height && ` · ${mediaInfo.width}×${mediaInfo.height}`}
          {mediaInfo.durationMs && ` · ${Math.round(mediaInfo.durationMs / 1000)}ث`}
        </p>
      </div>
      <div style={{ marginBottom: 16, padding: 12, background: '#f5f7fa', borderRadius: 6 }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={consentAccepted} onChange={e => setConsentAccepted(e.target.checked)} required />
          <span style={{ fontSize: 13, lineHeight: 1.5 }}>{CONSENT_TEXT}</span>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="button secondary" onClick={() => setStep('upload')}>رجوع</button>
        <button className="button teal" onClick={submitForm} disabled={!canSubmit || isUploading}>{isUploading ? 'جاري الإرسال…' : 'إرسال المشاركة'}</button>
      </div>
    </div>}

    {step === 'complete' && <div className="card card-pad empty-state" style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
      <h3 style={{ marginTop: 0 }}>تم إرسال المشاركة بنجاح</h3>
      <p style={{ color: 'var(--muted)' }}>شكراً لمساهمتك. ستتم مراجعة مشاركتك من قبل المدير المسؤول، وسيتم التواصل معك في حال الحاجة لمعلومات إضافية.</p>
      <p style={{ color: 'var(--muted)', fontSize: 13 }}>المشاركة لا تظهر علناً إلا بعد الاعتماد والنشر النهائي.</p>
    </div>}
  </div>;
}

function detectType(file: File): { mimeType: string; kind: 'image' | 'video' } | null {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const supported = extension === 'jpg' || extension === 'jpeg' ? { mimeType: 'image/jpeg', kind: 'image' as const }
    : extension === 'png' ? { mimeType: 'image/png', kind: 'image' as const }
    : extension === 'webp' ? { mimeType: 'image/webp', kind: 'image' as const }
    : extension === 'mp4' ? { mimeType: 'video/mp4', kind: 'video' as const }
    : extension === 'mov' ? { mimeType: 'video/quicktime', kind: 'video' as const } : null;
  if (!supported) return null;
  const alternateJpeg = supported.mimeType === 'image/jpeg' && file.type === 'image/jpg';
  const alternateQuickTime = supported.mimeType === 'video/quicktime' && (file.type === 'video/x-quicktime' || file.type === 'application/octet-stream');
  if (file.type && file.type !== supported.mimeType && !alternateJpeg && !alternateQuickTime) return null;
  return supported;
}

async function hashFile(file: File, progress: (value: number) => void) {
  const digest = sha256.create();
  const chunk = 8 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunk) {
    const bytes = await withRequestTimeout('قراءة جزء من الملف', 30_000, () => file.slice(offset, Math.min(offset + chunk, file.size)).arrayBuffer());
    digest.update(new Uint8Array(bytes));
    progress(Math.min(offset + chunk, file.size));
  }
  return bytesToHex(digest.digest());
}

async function inspectImage(file: File, mimeType: string) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await withRequestTimeout('فك ترميز الصورة', 30_000, () => image.decode());
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 480 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { mimeType, kind: 'image', width: image.naturalWidth, height: image.naturalHeight, durationMs: null, thumbnailData: canvas.toDataURL('image/jpeg', 0.75), compatibility: 'candidate' };
  } catch { throw new Error(`${file.name}: تعذر فك ترميز الصورة.`); }
  finally { URL.revokeObjectURL(url); }
}

async function inspectVideo(file: File, mimeType: string) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.src = url;
  let width: number | null = null;
  let height: number | null = null;
  let durationMs: number | null = null;
  let thumbnailData: string | null = null;
  let compatibility: 'candidate' | 'warning' = 'candidate';
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('انتهت مهلة قراءة بيانات الفيديو.')), 12_000);
      video.onloadedmetadata = () => { window.clearTimeout(timeout); resolve(); };
      video.onerror = () => { window.clearTimeout(timeout); reject(new Error('تعذر قراءة بيانات الفيديو.')); };
    });
    width = video.videoWidth || null;
    height = video.videoHeight || null;
    durationMs = Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : null;
    try {
      await new Promise<void>(resolve => {
        if (durationMs && durationMs > 1200) {
          video.currentTime = Math.min(1, video.duration / 3);
          video.onseeked = () => resolve();
          window.setTimeout(resolve, 2000);
        } else resolve();
      });
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
      thumbnailData = canvas.toDataURL('image/jpeg', 0.72);
    } catch { thumbnailData = null; }
    if (!durationMs || !width || !height) compatibility = 'warning';
  } catch {
    compatibility = 'warning';
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
  return { mimeType, kind: 'video', width, height, durationMs, thumbnailData, compatibility };
}