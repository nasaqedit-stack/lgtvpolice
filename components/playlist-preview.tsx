'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/client/api';

type Props = { playlist: any; onClose: () => void };
export default function PlaylistPreview({ playlist, onClose }: Props) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [index, setIndex] = useState(0);
  const [error, setError] = useState('');
  const items = useMemo(() => playlist.items ?? [], [playlist.items]);
  const entry = items[index];
  const item = entry?.media;
  useEffect(() => {
    let cancelled = false;
    Promise.all(items.map(async (entry: any) => {
      if (!entry.media?.id) return null;
      const response = await api(`/api/admin/media/${entry.media.id}/preview`);
      return [entry.media.id, response.url] as const;
    })).then(results => {
      if (!cancelled) setUrls(Object.fromEntries(results.filter(Boolean) as Array<[string, string]>));
    }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'تعذر تحميل المعاينة.'); });
    return () => { cancelled = true; };
  }, [items, playlist.id]);
  useEffect(() => {
    if (!entry || item?.kind !== 'image') return;
    const duration = Math.max(1000, entry.duration_ms ?? 10000);
    const timer = window.setTimeout(() => setIndex(value => (value + 1) % items.length), duration);
    return () => window.clearTimeout(timer);
  }, [index, entry, item, items.length]);

  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={`معاينة ${playlist.name}`} style={{ width: 'min(1000px,100%)' }}>
    <div className="modal-header"><h3>معاينة: {playlist.name}</h3><button className="icon-button" onClick={onClose}>×</button></div>
    <div style={{ background: '#050a12', minHeight: 'min(62vh,540px)', display: 'grid', placeItems: 'center', position: 'relative' }}>
      {error ? <p style={{ color: 'white' }}>{error}</p> : !item ? <p style={{ color: 'white' }}>القائمة لا تحتوي وسائط.</p> : !urls[item.id] ? <p style={{ color: '#cad5e2' }}>جارٍ تحميل المعاينة…</p> : item.kind === 'video' ? <video key={item.id} src={urls[item.id]} autoPlay playsInline controls loop={Boolean(entry.loop_video)} onEnded={() => setIndex(value => (value + 1) % items.length)} style={{ maxWidth: '100%', maxHeight: '62vh', objectFit: 'contain' }} onError={() => setError('تعذر تشغيل هذا الملف في متصفح الإدارة.')} /> : <img key={item.id} src={urls[item.id]} alt={item.display_name} onError={() => setError('تعذر عرض الصورة.')} style={{ maxWidth: '100%', maxHeight: '62vh', objectFit: 'contain' }} />}
      {items.length > 1 && <><button className="icon-button" onClick={() => setIndex(value => (value + items.length - 1) % items.length)} style={{ position: 'absolute', right: 12, top: '50%' }}>›</button><button className="icon-button" onClick={() => setIndex(value => (value + 1) % items.length)} style={{ position: 'absolute', left: 12, top: '50%' }}>‹</button></>}
    </div>
    <div className="alert warning" style={{ marginTop: 12 }}>هذه معاينة إدارية عبر الإنترنت؛ تشغيل التلفاز بعد المزامنة يتم من IndexedDB المحلي ولا يعتمد على هذا الرابط.</div>
    {item && <small style={{ display: 'block', marginTop: 8, color: 'var(--muted)' }}>{index + 1} / {items.length} · {item.display_name}{item.kind === 'image' ? ` · ${Math.round((entry.duration_ms ?? 10000) / 1000)} ث` : ` · ${entry.loop_video ? 'تكرار' : 'المدة الفعلية للفيديو'}`}</small>}
  </section></div>;
}
