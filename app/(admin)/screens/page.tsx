'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, jsonBody } from '@/lib/client/api';
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/admin-common';

type PairingDialog = { screenName: string; code: string; expiresAt: string } | null;

export default function ScreensPage() {
  const [screens, setScreens] = useState<any[]>([]);
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('Asia/Riyadh');
  const [pairing, setPairing] = useState<PairingDialog>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const value = await api('/api/admin/screens');
      setScreens(value.screens);
      setPlaylists(value.playlists);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر تحميل الشاشات.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusyId('create'); setError('');
    try {
      const result = await api('/api/admin/screens', { method: 'POST', body: jsonBody({ name, timezone }) });
      setShowCreate(false); setName('');
      setPairing({ screenName: result.screen.name, code: result.pairingCode, expiresAt: result.expiresAt });
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر إنشاء الشاشة.'); }
    finally { setBusyId(''); }
  };
  const issueCode = async (screen: any, rotate = false) => {
    setBusyId(screen.id); setError('');
    try {
      const result = await api(`/api/admin/screens/${screen.id}/pair`, { method: 'POST', body: jsonBody({ rotate }) });
      setPairing({ screenName: screen.name, code: result.pairingCode, expiresAt: result.expiresAt });
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر إصدار رمز الربط.'); }
    finally { setBusyId(''); }
  };
  const update = async (screen: any, body: any, successMessage?: string) => {
    setBusyId(screen.id); setError('');
    try {
      await api(`/api/admin/screens/${screen.id}`, { method: 'PATCH', body: jsonBody(body) });
      if (successMessage) window.alert(successMessage);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر تحديث الشاشة.'); }
    finally { setBusyId(''); }
  };
  const command = async (screen: any, commandName: 'sync' | 'reload') => {
    setBusyId(screen.id); setError('');
    try { await api(`/api/admin/screens/${screen.id}/command`, { method: 'POST', body: jsonBody({ command: commandName }) }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر إرسال الأمر.'); }
    finally { setBusyId(''); }
  };
  const remove = async (screen: any) => {
    if (!window.confirm(`حذف الشاشة «${screen.name}»؟ سيُلغى اعتمادها وجدولها.`)) return;
    setBusyId(screen.id);
    try { await api(`/api/admin/screens/${screen.id}`, { method: 'DELETE' }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر حذف الشاشة.'); }
    finally { setBusyId(''); }
  };
  const rename = (screen: any) => {
    const value = window.prompt('اسم الشاشة الجديد', screen.name);
    if (value?.trim() && value.trim() !== screen.name) void update(screen, { name: value.trim() });
  };
  const copyCode = async () => {
    if (!pairing) return;
    try { await navigator.clipboard.writeText(pairing.code); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
    catch { setError('تعذر النسخ تلقائياً. حدّد الرمز وانسخه يدوياً.'); }
  };

  return <div className="page-content">
    <PageHeader title="الشاشات" description="أضف الشاشات، اربطها برمز مؤقت، وتابع آخر اتصال ومزامنة." action={<button className="button teal" onClick={() => setShowCreate(true)}>＋ إضافة شاشة</button>} />
    {error && <ErrorState message={error} retry={() => void load()} />}
    {loading ? <LoadingState /> : screens.length === 0 ? <section className="card"><EmptyState title="لا توجد شاشات مسجلة" description="أنشئ شاشة لعرض رمز اقتران مؤقت وإكمال الإعداد من التلفاز." action={<button className="button teal" onClick={() => setShowCreate(true)}>إضافة أول شاشة</button>} /></section> : <section className="card table-wrap">
      <table><thead><tr><th>الشاشة</th><th>الاتصال / الاقتران</th><th>القائمة الحالية</th><th>المزامنة</th><th>إجراءات</th></tr></thead><tbody>
        {screens.map(screen => <tr key={screen.id}>
          <td><span className="table-name">{screen.name}</span><span className="table-sub">{screen.id.slice(0, 8)} · {screen.device_info?.platform ?? 'متصفح'}</span></td>
          <td><Badge tone={screen.online ? 'online' : 'offline'}>{screen.online ? 'متصلة' : 'غير متصلة'}</Badge><span className="table-sub">{screen.pairingStatus === 'paired' ? 'مقترنة' : 'بانتظار الاقتران'} · {screen.last_seen_at ? new Date(screen.last_seen_at).toLocaleString('ar-SA') : 'لم تتصل بعد'}</span></td>
          <td><select aria-label={`قائمة تشغيل ${screen.name}`} value={screen.assigned_playlist_id ?? ''} disabled={busyId === screen.id} onChange={e => void update(screen, { assignedPlaylistId: e.target.value || null })} style={{ minWidth: 150, minHeight: 34, border: '1px solid var(--line)', borderRadius: 8, padding: '4px 7px' }}>
            <option value="">غير معيّنة</option>{playlists.filter((p: any) => p.enabled && p.published_version).map((playlist: any) => <option key={playlist.id} value={playlist.id}>{playlist.name}</option>)}
          </select><span className="table-sub">{screen.assigned_playlist_id ? '' : 'بدون تعيين: تُعرض الجدولة أو أحدث قائمة منشورة · '}{screen.current_playlist_version ? `الإصدار ${screen.current_playlist_version}` : '—'} · {screen.cached_media_count ?? 0} ملف محلي</span></td>
          <td><Badge tone={screen.last_sync_status === 'ready' ? 'online' : screen.last_sync_status === 'failed' ? 'failed' : screen.last_sync_status === 'syncing' ? 'pending' : 'neutral'}>{syncLabel(screen.last_sync_status)}</Badge><span className="table-sub">{screen.last_sync_at ? new Date(screen.last_sync_at).toLocaleString('ar-SA') : 'لم تزامن بعد'}</span>{screen.last_sync_error && <span className="table-sub" title={screen.last_sync_error}>{screen.last_sync_error.slice(0, 60)}</span>}</td>
          <td><div className="row-actions">
            <button className="button small secondary" onClick={() => void issueCode(screen)} disabled={busyId === screen.id}>رمز ربط</button>
            <button className="icon-button" title="مزامنة الآن" onClick={() => void command(screen, 'sync')} disabled={busyId === screen.id}>⇅</button>
            <button className="icon-button" title="إعادة تحميل المشغل" onClick={() => void command(screen, 'reload')} disabled={busyId === screen.id}>↻</button>
            <button className="icon-button" title="إعادة تسمية" onClick={() => rename(screen)}>✎</button>
            <button className="icon-button" title={screen.enabled ? 'تعطيل الشاشة' : 'تفعيل الشاشة'} onClick={() => void update(screen, { enabled: !screen.enabled })}>{screen.enabled ? '⏻' : '▶'}</button>
            <button className="icon-button" title="إلغاء الربط" onClick={() => { if (window.confirm('إلغاء اعتماد الشاشة؟ سيستمر تشغيل المحتوى الموجود محلياً حتى يتصل الجهاز مجدداً.')) void update(screen, { unpair: true }); }}>⛓</button>
            <button className="icon-button" title="تدوير الاعتماد" onClick={() => void issueCode(screen, true)}>⟳</button>
            <button className="icon-button" title="حذف الشاشة" onClick={() => void remove(screen)}>×</button>
          </div></td>
        </tr>)}
      </tbody></table>
    </section>}
    {showCreate && <div className="modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setShowCreate(false); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-screen-title">
      <div className="modal-header"><h3 id="create-screen-title">إضافة شاشة جديدة</h3><button className="icon-button" onClick={() => setShowCreate(false)} aria-label="إغلاق">×</button></div>
      <div className="form-grid"><div className="field full"><label htmlFor="screen-name">اسم الشاشة</label><input id="screen-name" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="مثال: الاستقبال الرئيسي" maxLength={120} /></div><div className="field full"><label htmlFor="screen-timezone">المنطقة الزمنية</label><select id="screen-timezone" value={timezone} onChange={e => setTimezone(e.target.value)}><option value="Asia/Riyadh">الرياض — Asia/Riyadh</option><option value="UTC">UTC</option></select><small>تُخزّن الجداول على الجهاز وتستمر وفق ساعة التلفاز حتى دون اتصال.</small></div></div>
      <div className="modal-actions"><button className="button teal" disabled={!name.trim() || busyId === 'create'} onClick={() => void create()}>{busyId === 'create' ? 'جارٍ الإنشاء…' : 'إنشاء وإصدار رمز'}</button><button className="button secondary" onClick={() => setShowCreate(false)}>إلغاء</button></div>
    </section></div>}
    {pairing && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
      <div className="modal-header"><h3 id="pairing-title">رمز اقتران الشاشة</h3><button className="icon-button" onClick={() => setPairing(null)} aria-label="إغلاق">×</button></div>
      <div className="alert info">افتح <strong dir="ltr">/player</strong> على التلفاز وأدخل الرمز. الرمز صالح حتى {new Date(pairing.expiresAt).toLocaleTimeString('ar-SA')} ويُستخدم مرة واحدة.</div>
      <div dir="ltr" style={{ textAlign: 'center', fontSize: 35, letterSpacing: 7, fontWeight: 700, padding: '28px 8px', color: '#152945' }}>{pairing.code}</div>
      <p style={{ textAlign: 'center', color: 'var(--muted)' }}>الشاشة: {pairing.screenName}</p>
      <div className="modal-actions"><button className="button teal" onClick={() => void copyCode()}>{copied ? 'تم النسخ ✓' : 'نسخ الرمز'}</button><button className="button secondary" onClick={() => setPairing(null)}>إغلاق</button></div>
    </section></div>}
  </div>;
}
function syncLabel(status: string) { return status === 'ready' ? 'جاهزة' : status === 'syncing' ? 'تزامن' : status === 'failed' ? 'تعذر' : 'لم تتم'; }
