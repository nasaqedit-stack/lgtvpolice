'use client';

import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { api, jsonBody } from '@/lib/client/api';
import { formatBytes } from '@/lib/shared';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/admin-common';

const PART_SIZE = 8 * 1024 * 1024;
type FileInfo = { mimeType: string; kind: 'image' | 'video'; width: number | null; height: number | null; durationMs: number | null; thumbnailData: string | null; compatibility: 'candidate' | 'warning' | 'unknown' };
type UploadState = { name: string; phase: string; percent: number; uploaded: number; total: number } | null;

export default function MediaPage() {
  const [media, setMedia] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [sort, setSort] = useState('newest');
  const [upload, setUpload] = useState<UploadState>(null);
  const [dragging, setDragging] = useState(false);
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
      setMedia(result.media);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر تحميل المكتبة.'); }
    finally { setLoading(false); }
  }, [query, kind, sort]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 180); return () => window.clearTimeout(timer); }, [load]);
  const setFileProgress = (file: File, phase: string, uploaded = 0) => setUpload({ name: file.name, phase, percent: file.size ? Math.min(100, Math.round(uploaded / file.size * 100)) : 0, uploaded, total: file.size });

  const processFile = async (file: File) => {
    const info = detectType(file);
    if (!info) throw new Error(`${file.name}: الصيغ المدعومة JPG وPNG وWebP وMP4 فقط. لا يتم قبول SVG غير المنقّح أو HEIC.`);
    if (file.size <= 0 || file.size > 2 * 1024 * 1024 * 1024) throw new Error(`${file.name}: الحجم يجب أن يكون بين بايت واحد و2 جيجابايت.`);
    let details: FileInfo;
    if (info.kind === 'image') details = await inspectImage(file, info.mimeType);
    else details = await inspectVideo(file, info.mimeType);
    if (details.compatibility === 'warning' && !window.confirm(`${file.name}: لم يستطع متصفح الإدارة تأكيد توافق الفيديو مع H.264/AAC. قد لا يعمل على طراز التلفاز. هل تريد رفعه مع تسجيل التحذير؟`)) return;

    setFileProgress(file, 'حساب بصمة SHA-256…');
    const hash = await hashFile(file, amount => setFileProgress(file, 'حساب بصمة SHA-256…', amount));
    const duplicate = await api(`/api/admin/media?hash=${hash}`);
    if (duplicate.media?.length) throw new Error(`${file.name}: نسخة مطابقة موجودة باسم «${duplicate.media[0].display_name}»، لم يُعَد رفعها.`);

    setFileProgress(file, 'تهيئة رفع متعدد الأجزاء…');
    const uploadKey = `signage-upload:${hash}`;
    let uploadId = '';
    let status: any = null;
    try {
      uploadId = sessionStorage.getItem(uploadKey) ?? '';
      if (uploadId) {
        status = await api(`/api/admin/media/uploads/${uploadId}/status`);
        if (status.upload.fileSize !== file.size || status.upload.mimeType !== info.mimeType || status.upload.fileName !== file.name) {
          throw new Error('ملف مختلف عن جلسة الرفع السابقة.');
        }
      }
    } catch {
      if (uploadId) sessionStorage.removeItem(uploadKey);
      uploadId = '';
      status = null;
    }
    if (!uploadId) {
      const session = await api('/api/admin/media/uploads', { method: 'POST', body: jsonBody({ fileName: file.name, fileSize: file.size, mimeType: info.mimeType }) });
      uploadId = session.uploadId;
      sessionStorage.setItem(uploadKey, uploadId);
      status = await api(`/api/admin/media/uploads/${uploadId}/status`);
    }
    const existingParts = new Map<number, number>((status.parts ?? []).map((part: any) => [Number(part.partNumber), Number(part.size)]));
    let completedBytes = [...existingParts.values()].reduce((sum, size) => sum + size, 0);
    setFileProgress(file, 'رفع أجزاء الملف إلى تخزين الكائنات…', completedBytes);
    const partNumbers = Array.from({ length: status.totalParts }, (_, index) => index + 1).filter(partNumber => !existingParts.has(partNumber));
    await uploadParts(file, uploadId, partNumbers, completed => {
      completedBytes += completed;
      setFileProgress(file, 'رفع أجزاء الملف إلى تخزين الكائنات…', completedBytes);
    });
    setFileProgress(file, 'فحص الملف وإضافته إلى المكتبة…', file.size);
    const result = await api(`/api/admin/media/uploads/${uploadId}/complete`, {
      method: 'POST',
      body: jsonBody({
        sha256: hash,
        width: details.width,
        height: details.height,
        durationMs: details.durationMs,
        thumbnailData: details.thumbnailData,
        compatibility: details.compatibility,
      }),
    });
    sessionStorage.removeItem(uploadKey);
    if (result.duplicate) throw new Error(`${file.name}: الملف موجود مسبقاً ولم تتم إضافة نسخة ثانية.`);
  };

  const handleFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setError('');
    for (const file of list) {
      try { await processFile(file); }
      catch (reason) {
        setError(reason instanceof Error ? reason.message : `تعذر رفع ${file.name}.`);
        // Continue through a multi-file selection; one failed file never cancels the others.
      }
    }
    setUpload(null);
    if (inputRef.current) inputRef.current.value = '';
    await load();
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

  return <div className="page-content">
    <PageHeader title="مكتبة الوسائط" description="ارفع الصور ومقاطع MP4 إلى تخزين الكائنات الخاص. يستخدم الرفع أجزاء قابلة للاستئناف، ويمنع تكرار الملف بالبصمة." action={<button className="button teal" onClick={() => inputRef.current?.click()} disabled={Boolean(upload)}>＋ رفع ملفات</button>} />
    {error && <ErrorState message={error} retry={() => void load()} />}
    <input ref={inputRef} type="file" multiple accept=".jpg,.jpeg,.png,.webp,.mp4,image/jpeg,image/png,image/webp,video/mp4" style={{ display: 'none' }} onChange={fileChange} />
    <div className={`upload-drop ${dragging ? 'dragging' : ''}`} role="button" tabIndex={0} onClick={() => inputRef.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click(); }}>
      <div style={{ fontSize: 27, color: '#26998d' }}>⇧</div><strong>اسحب الملفات هنا أو اختر من جهازك</strong><small>JPG · PNG · WebP · MP4 · الحد الأقصى 2 جيجابايت للملف · SVG غير مدعوم حالياً لأنه يتطلب تنقية آمنة.</small>
    </div>
    {upload && <section className="card card-pad" style={{ marginTop: 14 }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><strong>{upload.name}</strong><span>{upload.phase}</span></div><div className="progress-track" style={{ background: '#e9eef4' }}><div className="progress-fill" style={{ width: `${upload.percent}%` }} /></div><small style={{ color: 'var(--muted)' }}>{upload.percent}% · {formatBytes(upload.uploaded)} / {formatBytes(upload.total)}</small></section>}
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
    digest.update(new Uint8Array(await file.slice(offset, Math.min(offset + chunk, file.size)).arrayBuffer()));
    progress(Math.min(offset + chunk, file.size));
  }
  return bytesToHex(digest.digest());
}
async function inspectImage(file: File, mimeType: string): Promise<FileInfo> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
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
async function uploadParts(file: File, uploadId: string, partNumbers: number[], onPartComplete: (bytes: number) => void) {
  const queue = [...partNumbers];
  const run = async () => {
    while (queue.length) {
      const partNumber = queue.shift()!;
      const start = (partNumber - 1) * PART_SIZE;
      const blob = file.slice(start, Math.min(start + PART_SIZE, file.size));
      let done = false;
      for (let attempt = 0; attempt < 3 && !done; attempt += 1) {
        try {
          const ticket = await api(`/api/admin/media/uploads/${uploadId}/parts`, { method: 'POST', body: jsonBody({ partNumbers: [partNumber] }) });
          const response = await fetch(ticket.urls[partNumber], { method: 'PUT', body: blob });
          if (!response.ok) throw new Error(`رفض التخزين الجزء ${partNumber} (${response.status}).`);
          done = true;
          onPartComplete(blob.size);
        } catch (error) {
          if (attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => run()));
}
function formatDuration(value: number) {
  const total = Math.floor(value / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
