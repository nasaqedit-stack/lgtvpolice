'use client';

import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { api, ApiError, jsonBody, withRequestTimeout } from '@/lib/client/api';
import { buildPartManifest, uploadParts } from '@/lib/client/media-upload';
import { runUploadTask, type UploadProgress, type UploadUiState } from '@/lib/client/upload-state';
import { formatBytes } from '@/lib/shared';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/admin-common';

const COMPLETE_TIMEOUT_MS = 55_000;
type FileInfo = { mimeType: string; kind: 'image' | 'video'; width: number | null; height: number | null; durationMs: number | null; thumbnailData: string | null; compatibility: 'candidate' | 'warning' | 'unknown' };

export default function MediaPage() {
  const [media, setMedia] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [sort, setSort] = useState('newest');
  const [upload, setUpload] = useState<UploadUiState | null>(null);
  const [dragging, setDragging] = useState(false);
  const uploadRunning = useRef(false);
  const [preview, setPreview] = useState<any>(null);
  const [busyId, setBusyId] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (kind !== 'all') params.set('kind', kind);
      params.set('sort', sort === 'name' ? 'name' : sort === 'size' ? 'size' : 'newest');
      const result = await api(`/api/admin/media?${params.toString()}`);
      if (!Array.isArray(result.media)) throw new Error('أعاد الخادم قائمة وسائط غير صالحة.');
      setMedia(result.media);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر تحميل المكتبة.'); }
    finally { setLoading(false); }
  }, [query, kind, sort]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 180); return () => window.clearTimeout(timer); }, [load]);
  const processFile = async (file: File, report: UploadProgress) => {
    const info = detectType(file);
    if (!info) throw new Error(`${file.name}: الصيغ المدعومة JPG وPNG وWebP وMP4 فقط. لا يتم قبول SVG غير المنقّح أو HEIC.`);
    if (file.size <= 0 || file.size > 2 * 1024 * 1024 * 1024) throw new Error(`${file.name}: الحجم يجب أن يكون بين بايت واحد و2 جيجابايت.`);
    report('قراءة بيانات الملف…');
    let details: FileInfo;
    if (info.kind === 'image') details = await inspectImage(file, info.mimeType);
    else details = await inspectVideo(file, info.mimeType);
    if (details.compatibility === 'warning' && !window.confirm(`${file.name}: لم يستطع متصفح الإدارة تأكيد توافق الفيديو مع H.264/AAC. قد لا يعمل على طراز التلفاز. هل تريد رفعه مع تسجيل التحذير؟`)) return null;

    report('حساب بصمة SHA-256…');
    const hash = await hashFile(file, amount => report('حساب بصمة SHA-256…', amount));
    const duplicate = await api(`/api/admin/media?hash=${hash}`);
    if (duplicate.media?.length) throw new Error(`${file.name}: نسخة مطابقة موجودة باسم «${duplicate.media[0].display_name}»، لم يُعَد رفعها.`);

    report('تهيئة رفع متعدد الأجزاء…');
    const uploadKey = `signage-upload:${hash}`;
    let uploadId = sessionStorage.getItem(uploadKey) ?? '';
    let status: any = null;
    if (uploadId) {
      try {
        status = await api(`/api/admin/media/uploads/${uploadId}/status`);
      } catch (reason) {
        // Only discard a session the server confirms is gone/inactive. Do not hide an auth,
        // configuration, network, or timeout failure by silently creating another session.
        if (!(reason instanceof ApiError) || ![404, 409, 410].includes(reason.status)) throw reason;
        sessionStorage.removeItem(uploadKey);
        uploadId = '';
      }
      if (uploadId && !status?.upload) throw new Error('أعاد الخادم حالة جلسة رفع غير مكتملة.');
      if (uploadId && (status.upload.fileSize !== file.size || status.upload.mimeType !== info.mimeType || status.upload.fileName !== file.name)) {
        sessionStorage.removeItem(uploadKey);
        uploadId = '';
        status = null;
      }
    }
    if (!uploadId) {
      const session = await api('/api/admin/media/uploads', { method: 'POST', body: jsonBody({ fileName: file.name, fileSize: file.size, mimeType: info.mimeType }) });
      uploadId = session.uploadId;
      if (typeof uploadId !== 'string' || !uploadId) throw new Error('لم يُرجع الخادم معرّف جلسة الرفع.');
      sessionStorage.setItem(uploadKey, uploadId);
      status = await api(`/api/admin/media/uploads/${uploadId}/status`);
    }
    if (!status?.upload || !Array.isArray(status.parts) || !Number.isInteger(status.totalParts)) {
      throw new Error('أعاد الخادم حالة جلسة رفع غير مكتملة.');
    }
    const existingParts = new Map<number, number>((status.parts ?? []).map((part: any) => [Number(part.partNumber), Number(part.size)]));
    let completedBytes = [...existingParts.values()].reduce((sum, size) => sum + size, 0);
    report('رفع أجزاء الملف إلى تخزين الكائنات…', completedBytes);
    const partNumbers = Array.from({ length: status.totalParts }, (_, index) => index + 1).filter(partNumber => !existingParts.has(partNumber));
    const uploadedParts = await uploadParts(file, uploadId, partNumbers, completed => {
      completedBytes += completed;
      report('رفع أجزاء الملف إلى تخزين الكائنات…', completedBytes);
    });
    report('فحص الملف وإنشاء سجل الوسيط…', file.size);
    const result = await api(`/api/admin/media/uploads/${uploadId}/complete`, {
      method: 'POST',
      body: jsonBody({
        sha256: hash,
        width: details.width,
        height: details.height,
        durationMs: details.durationMs,
        thumbnailData: details.thumbnailData,
        compatibility: details.compatibility,
        // One entry per part: the byte length read off the Blob that was actually PUT, so the
        // server validates the sizes that were really sent instead of re-deriving them itself.
        parts: buildPartManifest(file.size, uploadedParts),
      }),
    }, COMPLETE_TIMEOUT_MS);
    if (!result?.media || typeof result.media.id !== 'string') {
      throw new Error('لم يُرجع الخادم سجل الوسيط بعد الإكمال؛ لم يتم تأكيد إضافته إلى المكتبة.');
    }
    sessionStorage.removeItem(uploadKey);
    if (result.duplicate) throw new Error(`${file.name}: الملف موجود مسبقاً ولم تتم إضافة نسخة ثانية.`);
    return result.media;
  };

  const handleFiles = async (files: FileList | File[]) => {
    if (uploadRunning.current) return;
    const list = Array.from(files);
    if (!list.length) return;
    uploadRunning.current = true;
    setError('');
    setUploadError('');
    try {
      for (const file of list) {
        try {
          await runUploadTask(file, setUpload, async report => {
            const created = await processFile(file, report);
            if (created) {
              // The complete endpoint returns the row only after its database INSERT has finished.
              // Reconcile that authoritative result immediately, then refresh usage counts/sort.
              setMedia(current => [{ ...created, usageCount: 0 }, ...current.filter(item => item.id !== created.id)]);
              await load();
            }
            return created;
          });
        } catch (reason) {
          setUploadError(reason instanceof Error ? reason.message : `تعذر رفع ${file.name}.`);
          // Continue through a multi-file selection; one failed file never cancels the others.
        }
      }
      await load();
    } finally {
      uploadRunning.current = false;
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const fileChange = (event: ChangeEvent<HTMLInputElement>) => { if (event.target.files) void handleFiles(event.target.files); };
  const onDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); void handleFiles(event.dataTransfer.files); };
  const previewMedia = async (item: any) => {
    setBusyId(item.id);
    try {
      if (item.kind === 'image' && item.thumbnail_data) { setPreview({ item, url: item.thumbnail_data }); return; }
      const result = await api(`/api/admin/media/${item.id}/preview`);
      setPreview({ item, url: result.url });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر فتح المعاينة.'); }
    finally { setBusyId(''); }
  };
  const rename = async (item: any) => {
    const displayName = window.prompt('الاسم الجديد للوسيط', item.display_name);
    if (!displayName?.trim() || displayName.trim() === item.display_name) return;
    setBusyId(item.id);
    try { await api(`/api/admin/media/${item.id}`, { method: 'PATCH', body: jsonBody({ displayName: displayName.trim() }) }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر إعادة التسمية.'); }
    finally { setBusyId(''); }
  };
  const remove = async (item: any) => {
    if (!window.confirm(item.usageCount ? `هذا الوسيط مستخدم ${item.usageCount} مرة. أزله من قوائم التشغيل المنشورة أولاً.` : `حذف «${item.display_name}» نهائياً من التخزين؟`)) return;
    setBusyId(item.id);
    try { await api(`/api/admin/media/${item.id}`, { method: 'DELETE' }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر حذف الوسيط.'); }
    finally { setBusyId(''); }
  };

  const isUploading = upload?.status === 'uploading';
  const chooseFiles = () => { if (!isUploading) inputRef.current?.click(); };

  return <div className="page-content">
    <PageHeader title="مكتبة الوسائط" description="ارفع الصور ومقاطع MP4 إلى تخزين الكائنات الخاص. يستخدم الرفع أجزاء قابلة للاستئناف، ويمنع تكرار الملف بالبصمة." action={<button className="button teal" onClick={chooseFiles} disabled={isUploading}>＋ رفع ملفات</button>} />
    {error && <ErrorState message={error} retry={() => void load()} />}
    {uploadError && <ErrorState message={uploadError} />}
    <input ref={inputRef} type="file" multiple disabled={isUploading} accept=".jpg,.jpeg,.png,.webp,.mp4,image/jpeg,image/png,image/webp,video/mp4" style={{ display: 'none' }} onChange={fileChange} />
    <div className={`upload-drop ${dragging ? 'dragging' : ''}`} role="button" aria-disabled={isUploading} tabIndex={isUploading ? -1 : 0} onClick={chooseFiles} onDragOver={event => { event.preventDefault(); if (!isUploading) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onKeyDown={event => { if (!isUploading && (event.key === 'Enter' || event.key === ' ')) chooseFiles(); }}>
      <div style={{ fontSize: 27, color: '#26998d' }}>⇧</div><strong>اسحب الملفات هنا أو اختر من جهازك</strong><small>JPG · PNG · WebP · MP4 · الحد الأقصى 2 جيجابايت للملف · SVG غير مدعوم حالياً لأنه يتطلب تنقية آمنة.</small>
    </div>
    {upload && <section className={`card card-pad upload-status ${upload.status}`} style={{ marginTop: 14 }} role={upload.status === 'error' ? 'alert' : 'status'} aria-live="polite">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><strong>{upload.name}</strong><span>{upload.phase}</span></div>
      <div className="progress-track" style={{ background: '#e9eef4' }}><div className="progress-fill" style={{ width: `${upload.percent}%` }} /></div>
      <small style={{ color: 'var(--muted)' }}>{upload.percent}% · {formatBytes(upload.uploaded)} / {formatBytes(upload.total)}</small>
      {upload.error && <p style={{ marginBottom: 0 }}><strong>تفاصيل الخطأ:</strong> {upload.error}</p>}
    </section>}
    <div className="toolbar" style={{ marginTop: 20 }}><div className="toolbar-start"><input className="search-input" placeholder="ابحث باسم الوسيط…" value={query} onChange={event => setQuery(event.target.value)} aria-label="البحث في الوسائط" /><select className="search-input" value={kind} onChange={event => setKind(event.target.value)} aria-label="تصفية النوع" style={{ width: 145 }}><option value="all">كل الأنواع</option><option value="image">صور</option><option value="video">فيديو</option></select></div><div className="toolbar-end"><select className="search-input" value={sort} onChange={event => setSort(event.target.value)} aria-label="ترتيب الوسائط" style={{ width: 150 }}><option value="newest">الأحدث أولاً</option><option value="name">الاسم</option><option value="size">الأكبر حجماً</option></select><span style={{ color: 'var(--muted)', fontSize: 12 }}>{media.length} عنصر</span></div></div>
    {loading && media.length === 0 ? <LoadingState /> : media.length === 0 ? <section className="card"><EmptyState title="مكتبتك فارغة" description="ارفع صوراً أو فيديو MP4؛ ستُخزن في Supabase Storage وليس داخل مستودع الكود." action={<button className="button teal" onClick={() => inputRef.current?.click()}>اختيار ملفات</button>} /></section> : <div className="media-grid">
      {media.map(item => <article className="card media-card" key={item.id}>
        <div className="media-thumb" onClick={() => void previewMedia(item)} role="button" tabIndex={0}>
          {item.thumbnail_data ? <img src={item.thumbnail_data} alt="" /> : <span style={{ fontSize: 34, color: '#8293a8' }}>{item.kind === 'video' ? '▶' : '▧'}</span>}
          <span className="media-type">{item.kind === 'video' ? 'فيديو MP4' : item.mime_type.split('/')[1]?.toUpperCase()}</span>
        </div>
        <div className="media-body"><strong title={item.display_name}>{item.display_name}</strong><div className="media-meta"><span>{formatBytes(Number(item.file_size))}</span><span>{item.width && item.height ? `${item.width}×${item.height}` : item.duration_ms ? formatDuration(item.duration_ms) : item.kind === 'video' ? 'مدة تُقرأ من الفيديو' : '—'}</span></div><div className="media-meta"><span>استخدام: {item.usageCount}</span><span>{new Date(item.created_at).toLocaleDateString('ar-SA')}</span></div>
          {item.kind === 'video' && <div className={`alert ${item.compatibility === 'warning' ? 'warning' : 'info'}`} style={{ padding: '6px 8px', marginTop: 8, fontSize: 10 }}>{item.compatibility === 'warning' ? 'تحذير: Codec غير مؤكد؛ اختبره على طراز التلفاز.' : 'مرشح MP4؛ يوصى بـ H.264 + AAC.'}</div>}
        </div>
        <div className="media-actions"><button className="icon-button" title="معاينة" onClick={() => void previewMedia(item)} disabled={busyId === item.id}>◉</button><button className="icon-button" title="إعادة تسمية" onClick={() => void rename(item)}>✎</button><button className="icon-button" title="حذف" onClick={() => void remove(item)}>×</button></div>
      </article>)}
    </div>}
    {preview && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setPreview(null); }}><section className="modal" role="dialog" aria-modal="true" style={{ width: 'min(900px,100%)' }}><div className="modal-header"><h3>{preview.item.display_name}</h3><button className="icon-button" onClick={() => setPreview(null)}>×</button></div><div style={{ background: '#07101d', display: 'grid', placeItems: 'center', minHeight: 280, maxHeight: '65vh', overflow: 'hidden' }}>{preview.item.kind === 'video' ? <video src={preview.url} controls muted playsInline style={{ maxWidth: '100%', maxHeight: '65vh' }} /> : <img src={preview.url} alt={preview.item.display_name} style={{ maxWidth: '100%', maxHeight: '65vh', objectFit: 'contain' }} />}</div><small style={{ display: 'block', marginTop: 10, color: 'var(--muted)' }}>تُحمّل المعاينة عبر رابط موقّع قصير العمر. التشغيل على الشاشة يستخدم نسخة IndexedDB المحلية.</small></section></div>}
  </div>;
}

function detectType(file: File): { mimeType: string; kind: 'image' | 'video' } | null {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const supported = extension === 'jpg' || extension === 'jpeg' ? { mimeType: 'image/jpeg', kind: 'image' as const }
    : extension === 'png' ? { mimeType: 'image/png', kind: 'image' as const }
    : extension === 'webp' ? { mimeType: 'image/webp', kind: 'image' as const }
    : extension === 'mp4' ? { mimeType: 'video/mp4', kind: 'video' as const } : null;
  if (!supported) return null;
  if (file.type && file.type !== supported.mimeType && !(supported.mimeType === 'image/jpeg' && file.type === 'image/jpg')) return null;
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
async function inspectImage(file: File, mimeType: string): Promise<FileInfo> {
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
  } catch { throw new Error(`${file.name}: تعذر فك ترميز الصورة في المتصفح.`); }
  finally { URL.revokeObjectURL(url); }
}
async function inspectVideo(file: File, mimeType: string): Promise<FileInfo> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.muted = true;
  video.src = url;
  const canPlay = video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
  let width: number | null = null;
  let height: number | null = null;
  let durationMs: number | null = null;
  let thumbnailData: string | null = null;
  let compatibility: FileInfo['compatibility'] = canPlay ? 'candidate' : 'warning';
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
    // A browser probe is advisory only; the TV's WebOS codec stack is the final authority.
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
function formatDuration(value: number) {
  const total = Math.floor(value / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
