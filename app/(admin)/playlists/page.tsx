'use client';

import { DragEvent, useCallback, useEffect, useState } from 'react';
import { api, jsonBody } from '@/lib/client/api';
import { formatBytes } from '@/lib/shared';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/admin-common';
import PlaylistPreview from '@/components/playlist-preview';

type DraftItem = { key: string; mediaId: string; durationMs: number | null; loop: boolean; media: any };
type Editor = { id: string | null; name: string; enabled: boolean; items: DraftItem[] };

export default function PlaylistsPage() {
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [media, setMedia] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [mediaSearch, setMediaSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const [playlistData, mediaData] = await Promise.all([api('/api/admin/playlists'), api('/api/admin/media')]);
      setPlaylists(playlistData.playlists);
      setMedia(mediaData.media);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر تحميل قوائم التشغيل.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const newPlaylist = () => { setNotice(''); setError(''); setEditor({ id: null, name: '', enabled: true, items: [] }); };
  const edit = (playlist: any) => {
    setNotice(''); setError('');
    setEditor({ id: playlist.id, name: playlist.name, enabled: playlist.enabled, items: playlist.items.map((entry: any) => ({
      key: entry.id, mediaId: entry.media_id, durationMs: entry.duration_ms, loop: entry.loop_video, media: entry.media,
    })) });
  };
  const add = (asset: any) => {
    if (!editor) return;
    setEditor({ ...editor, items: [...editor.items, {
      key: crypto.randomUUID(), mediaId: asset.id, durationMs: asset.kind === 'image' ? 10_000 : null, loop: false, media: asset,
    }] });
  };
  const removeItem = (key: string) => editor && setEditor({ ...editor, items: editor.items.filter(item => item.key !== key) });
  const updateItem = (key: string, patch: Partial<DraftItem>) => editor && setEditor({ ...editor, items: editor.items.map(item => item.key === key ? { ...item, ...patch } : item) });
  const move = (from: number, to: number) => {
    if (!editor || to < 0 || to >= editor.items.length || from === to) return;
    const items = [...editor.items];
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item);
    setEditor({ ...editor, items });
  };
  const onDrop = (event: DragEvent, target: number) => {
    event.preventDefault();
    if (dragIndex !== null) move(dragIndex, target);
    setDragIndex(null);
  };

  const save = async (publish: boolean) => {
    if (!editor) return;
    if (!editor.name.trim()) { setError('أدخل اسماً لقائمة التشغيل.'); return; }
    if (publish && editor.items.length === 0) { setError('أضف وسيطاً واحداً على الأقل قبل النشر.'); return; }
    const unsupported = editor.items.find(item => item.media?.kind === 'video' && item.media.compatibility === 'warning');
    if (publish && unsupported && !window.confirm(`يوجد فيديو «${unsupported.media.display_name}» تحذير توافق. النظام يوصي بـ MP4/H.264/AAC، ولا يمكن ضمان دعمه على جميع طرازات webOS. هل تريد النشر على مسؤوليتك؟`)) return;
    setBusy(true); setError(''); setNotice('');
    const payload = {
      name: editor.name.trim(), enabled: editor.enabled,
      items: editor.items.map(item => ({ mediaId: item.mediaId, durationMs: item.media?.kind === 'image' ? item.durationMs : null, loop: item.media?.kind === 'video' && item.loop })),
      publish,
    };
    try {
      if (editor.id) {
        const result = await api(`/api/admin/playlists/${editor.id}`, { method: 'PATCH', body: jsonBody(payload) });
        setNotice(publish ? `نُشرت القائمة بإصدار ${result.version}.` : 'حُفظت المسودة فقط؛ لم تتغير الشاشات حتى النشر.');
      } else {
        const result = await api('/api/admin/playlists', { method: 'POST', body: jsonBody(payload) });
        setEditor(value => value ? { ...value, id: result.playlist.id } : value);
        setNotice(publish ? `أُنشئت ونُشرت القائمة بإصدار ${result.version}.` : 'أُنشئت مسودة القائمة.');
      }
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر حفظ قائمة التشغيل.'); }
    finally { setBusy(false); }
  };
  const duplicate = async (playlist: any) => {
    const name = window.prompt('اسم النسخة', `نسخة من ${playlist.name}`);
    if (!name?.trim()) return;
    setBusy(true);
    try { await api(`/api/admin/playlists/${playlist.id}/duplicate`, { method: 'POST', body: jsonBody({ name: name.trim() }) }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر نسخ القائمة.'); }
    finally { setBusy(false); }
  };
  const deletePlaylist = async (playlist: any) => {
    if (!window.confirm(`حذف قائمة «${playlist.name}»؟`)) return;
    setBusy(true);
    try { await api(`/api/admin/playlists/${playlist.id}`, { method: 'DELETE' }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر حذف القائمة.'); }
    finally { setBusy(false); }
  };
  const filteredMedia = media.filter(asset => !mediaSearch.trim() || asset.display_name.toLocaleLowerCase('ar').includes(mediaSearch.trim().toLocaleLowerCase('ar')));

  return <div className="page-content">
    <PageHeader title="قوائم التشغيل" description="رتّب صوراً وفيديوهات، اضبط مدة الصور وتكرار الفيديو، ثم انشر نسخة جديدة. لا تُفعّل النسخة على الشاشة قبل اكتمال كل تنزيلاتها." action={<button className="button teal" onClick={newPlaylist}>＋ قائمة جديدة</button>} />
    {error && <ErrorState message={error} />}{notice && <div className="alert success" style={{ marginBottom: 14 }}>{notice}</div>}
    {editor ? <section className="card card-pad">
      <div className="section-title"><div><h3>{editor.id ? 'تحرير قائمة التشغيل' : 'إنشاء قائمة تشغيل'}</h3><span>{editor.id ? `المعرّف ${editor.id.slice(0, 8)}` : 'إعداد جديد'}</span></div><button className="button secondary small" onClick={() => setEditor(null)}>العودة للقوائم</button></div>
      <div className="form-grid" style={{ marginBottom: 16 }}><div className="field"><label htmlFor="playlist-name">اسم القائمة</label><input id="playlist-name" value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} maxLength={120} placeholder="مثال: إعلانات الاستقبال" /></div><div className="field"><label htmlFor="playlist-enabled">الحالة</label><select id="playlist-enabled" value={String(editor.enabled)} onChange={e => setEditor({ ...editor, enabled: e.target.value === 'true' })}><option value="true">مفعّلة</option><option value="false">معطّلة</option></select></div></div>
      <div className="playlist-editor">
        <section><div className="section-title"><h3>المكتبة</h3><span>{filteredMedia.length} وسيط</span></div><input className="search-input" value={mediaSearch} onChange={e => setMediaSearch(e.target.value)} placeholder="ابحث لإضافة وسيط…" />
          <div style={{ maxHeight: 520, overflow: 'auto', marginTop: 10 }}>
            {filteredMedia.map(asset => <button key={asset.id} type="button" onClick={() => add(asset)} className="playlist-item" style={{ width: '100%', textAlign: 'right', cursor: 'pointer' }}>
              <div className="playlist-thumb">{asset.thumbnail_data ? <img src={asset.thumbnail_data} alt="" /> : asset.kind === 'video' ? '▶' : '▧'}</div><span style={{ minWidth: 0, flex: 1 }}><strong>{asset.display_name}</strong><small>{asset.kind === 'video' ? 'فيديو' : 'صورة'} · {formatBytes(Number(asset.file_size))}</small></span><span style={{ color: '#238d81', fontSize: 19 }}>＋</span>
            </button>)}
            {filteredMedia.length === 0 && <EmptyState title="لا توجد وسائط مطابقة" description="ارفع الملفات من صفحة مكتبة الوسائط أولاً." />}
          </div>
        </section>
        <section><div className="section-title"><h3>ترتيب العرض</h3><span>{editor.items.length} عنصر</span></div>
          <div style={{ maxHeight: 570, overflow: 'auto' }}>
            {editor.items.map((item, index) => <div key={item.key} className={`playlist-item ${dragIndex === index ? 'dragging' : ''}`} draggable onDragStart={() => setDragIndex(index)} onDragOver={event => event.preventDefault()} onDrop={event => onDrop(event, index)} onDragEnd={() => setDragIndex(null)}>
              <span style={{ color: '#8190a5', width: 22, textAlign: 'center' }}>{index + 1}</span><div className="playlist-thumb">{item.media?.thumbnail_data ? <img src={item.media.thumbnail_data} alt="" /> : item.media?.kind === 'video' ? '▶' : '▧'}</div>
              <div style={{ minWidth: 0, flex: 1 }}><strong title={item.media?.display_name}>{item.media?.display_name ?? 'وسيط محذوف'}</strong><small>{item.media?.kind === 'video' ? `فيديو · ${item.media.duration_ms ? `${Math.round(item.media.duration_ms / 1000)} ث` : 'المدة حسب الفيديو'}` : 'صورة'}</small>
                {item.media?.kind === 'video' && item.media.compatibility === 'warning' && <small style={{ display: 'block', color: '#a5701e' }}>تحذير توافق codec — تحقق على التلفاز</small>}
                {item.media?.kind === 'image' ? <label style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6, fontSize: 11 }}>مدة الصورة <input type="number" min="1" max="86400" value={Math.max(1, Math.round((item.durationMs ?? 10000) / 1000))} onChange={e => updateItem(item.key, { durationMs: Math.max(1000, Number(e.target.value || 1) * 1000) })} style={{ width: 70, padding: '4px 6px', border: '1px solid var(--line)', borderRadius: 6 }} /> ثانية</label> : <label style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 6, fontSize: 11 }}><input type="checkbox" checked={item.loop} onChange={e => updateItem(item.key, { loop: e.target.checked })} /> تكرار الفيديو</label>}
              </div>
              <div style={{ display: 'grid', gap: 4 }}><button className="icon-button" aria-label="تحريك للأعلى" disabled={index === 0} onClick={() => move(index, index - 1)}>↑</button><button className="icon-button" aria-label="تحريك للأسفل" disabled={index === editor.items.length - 1} onClick={() => move(index, index + 1)}>↓</button><button className="icon-button" aria-label="إزالة" onClick={() => removeItem(item.key)}>×</button></div>
            </div>)}
            {editor.items.length === 0 && <EmptyState title="أضف عناصر إلى القائمة" description="اختر صورة أو فيديو من المكتبة، واسحب العناصر لتغيير ترتيبها." />}
          </div>
        </section>
      </div>
      <div className="alert info" style={{ marginTop: 15 }}>يُشغّل الفيديو من التخزين المحلي بالمدة الفعلية للملف. الصيغة الموصى بها MP4 مع H.264/AAC؛ لا يوجد تحويل ترميز آلي.</div>
      <div className="modal-actions" style={{ justifyContent: 'flex-start' }}><button className="button teal" disabled={busy} onClick={() => void save(true)}>{busy ? 'جارٍ الحفظ…' : 'حفظ ونشر'}</button><button className="button secondary" disabled={busy} onClick={() => void save(false)}>حفظ مسودة فقط</button><button className="button secondary" onClick={() => setEditor(null)}>إلغاء</button></div>
    </section> : loading ? <LoadingState /> : playlists.length === 0 ? <section className="card"><EmptyState title="ابدأ بقائمة تشغيل" description="أضف وسائط ثم انشر النسخة الأولى لتعيينها على الشاشة." action={<button className="button teal" onClick={newPlaylist}>إنشاء قائمة تشغيل</button>} /></section> : <section className="card table-wrap"><table><thead><tr><th>القائمة</th><th>المحتوى</th><th>الإصدار المنشور</th><th>الاستخدام</th><th>إجراءات</th></tr></thead><tbody>
      {playlists.map(playlist => <tr key={playlist.id}><td><span className="table-name">{playlist.name}</span><span className="table-sub">{playlist.enabled ? 'مفعّلة' : 'معطّلة'}</span></td><td>{playlist.items.length} عنصر<span className="table-sub">{playlist.items.filter((item: any) => item.media?.kind === 'video').length} فيديو · {playlist.items.filter((item: any) => item.media?.kind === 'image').length} صورة</span></td><td>{playlist.published_version ? `v${playlist.published_version}` : 'مسودة غير منشورة'}</td><td>{playlist.scheduledCount ? `مستخدمة في ${playlist.scheduledCount} جدولة` : 'غير مجدولة'}</td><td><div className="row-actions"><button className="button small secondary" onClick={() => edit(playlist)}>تحرير</button><button className="button small secondary" disabled={!playlist.items.length} onClick={() => setPreview(playlist)}>معاينة</button><button className="icon-button" title="نسخ القائمة" disabled={busy} onClick={() => void duplicate(playlist)}>⧉</button><button className="icon-button" title="حذف" disabled={busy} onClick={() => void deletePlaylist(playlist)}>×</button></div></td></tr>)}
    </tbody></table></section>}
    {preview && <PlaylistPreview playlist={preview} onClose={() => setPreview(null)} />}
  </div>;
}
