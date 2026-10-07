'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, jsonBody } from '@/lib/client/api';
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/admin-common';

const days = [{ id: 1, label: 'الإثنين' }, { id: 2, label: 'الثلاثاء' }, { id: 3, label: 'الأربعاء' }, { id: 4, label: 'الخميس' }, { id: 5, label: 'الجمعة' }, { id: 6, label: 'السبت' }, { id: 7, label: 'الأحد' }];
type ScheduleDraft = { id?: string; screenId: string; playlistId: string; weekdays: number[]; startTime: string; endTime: string; timezone: string; enabled: boolean };

export default function SchedulePage() {
  const [schedules, setSchedules] = useState<any[]>([]);
  const [screens, setScreens] = useState<any[]>([]);
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<ScheduleDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [scheduleResult, screenResult] = await Promise.all([api('/api/admin/schedules'), api('/api/admin/screens')]);
      setSchedules(scheduleResult.schedules);
      setScreens(screenResult.screens);
      setPlaylists(screenResult.playlists.filter((item: any) => item.enabled && item.published_version));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر تحميل الجدولة.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const newSchedule = () => setEditor({ screenId: screens[0]?.id ?? '', playlistId: playlists[0]?.id ?? '', weekdays: [1, 2, 3, 4, 5, 6, 7], startTime: '08:00', endTime: '12:00', timezone: 'Asia/Riyadh', enabled: true });
  const edit = (row: any) => setEditor({ id: row.id, screenId: row.screen_id, playlistId: row.playlist_id, weekdays: row.weekdays, startTime: row.start_time, endTime: row.end_time, timezone: row.timezone, enabled: row.enabled });
  const toggleDay = (day: number) => editor && setEditor({ ...editor, weekdays: editor.weekdays.includes(day) ? editor.weekdays.filter(value => value !== day) : [...editor.weekdays, day].sort((a, b) => a - b) });
  const save = async () => {
    if (!editor) return;
    setError(''); setBusy(true);
    const payload = { screenId: editor.screenId, playlistId: editor.playlistId, weekdays: editor.weekdays, startTime: editor.startTime, endTime: editor.endTime, timezone: editor.timezone, enabled: editor.enabled };
    try {
      if (editor.id) await api(`/api/admin/schedules/${editor.id}`, { method: 'PATCH', body: jsonBody(payload) });
      else await api('/api/admin/schedules', { method: 'POST', body: jsonBody(payload) });
      setEditor(null); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر حفظ الجدولة.'); }
    finally { setBusy(false); }
  };
  const remove = async (row: any) => {
    if (!window.confirm(`حذف جدول «${row.screenName} — ${row.playlistName}»؟`)) return;
    setBusy(true);
    try { await api(`/api/admin/schedules/${row.id}`, { method: 'DELETE' }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر حذف الجدولة.'); }
    finally { setBusy(false); }
  };
  const changeEnabled = async (row: any) => {
    setBusy(true);
    try { await api(`/api/admin/schedules/${row.id}`, { method: 'PATCH', body: jsonBody({ enabled: !row.enabled }) }); await load(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'تعذر تغيير حالة الجدولة.'); }
    finally { setBusy(false); }
  };

  return <div className="page-content">
    <PageHeader title="الجدولة" description="حدد قائمة لكل شاشة وأيام ووقت التشغيل. يُنزّل المشغل كل القوائم المطلوبة مسبقاً ويبدّل بينها حسب ساعة الجهاز وتوقيت الرياض، حتى دون إنترنت." action={<button className="button teal" onClick={newSchedule} disabled={!screens.length || !playlists.length}>＋ إضافة جدول</button>} />
    {error && <ErrorState message={error} retry={() => void load()} />}
    <div className="alert info" style={{ marginBottom: 15 }}>تُطبّق أوقات الجدولة على المنطقة الزمنية المحفوظة داخل القاعدة، ويفضّل إبقاؤها <strong dir="ltr">Asia/Riyadh</strong>. تأكد من ضبط ساعة التلفاز والمنطقة الزمنية بشكل صحيح.</div>
    {loading ? <LoadingState /> : schedules.length === 0 ? <section className="card"><EmptyState title="لا توجد جداول حالياً" description="أنشئ جدولاً لتبديل قوائم التشغيل تلقائياً وفق الوقت المحلي." action={<button className="button teal" disabled={!screens.length || !playlists.length} onClick={newSchedule}>إضافة جدول</button>} /></section> : <section className="card card-pad"><div className="schedule-grid">
      {schedules.map(row => <article className="schedule-row" key={row.id}>
        <div><strong>{row.screenName}</strong><span className="table-sub">{row.playlistName}</span></div>
        <div><span dir="ltr" style={{ display: 'inline-block', fontWeight: 700 }}>{row.start_time} – {row.end_time}</span><span className="table-sub">{row.timezone}</span></div>
        <div className="day-pills">{row.weekdays.map((day: number) => <span className="day-pill" key={day}>{days.find(item => item.id === day)?.label.slice(0, 2)}</span>)}</div>
        <div><Badge tone={row.enabled ? 'online' : 'offline'}>{row.enabled ? 'مفعّل' : 'متوقف'}</Badge></div>
        <div className="row-actions"><button className="icon-button" title="تحرير" onClick={() => edit(row)}>✎</button><button className="icon-button" title={row.enabled ? 'إيقاف' : 'تفعيل'} disabled={busy} onClick={() => void changeEnabled(row)}>{row.enabled ? '⏸' : '▶'}</button><button className="icon-button" title="حذف" disabled={busy} onClick={() => void remove(row)}>×</button></div>
      </article>)}
    </div></section>}
    {(!screens.length || !playlists.length) && <div className="alert warning" style={{ marginTop: 14 }}>{!screens.length ? 'أضف شاشة أولاً.' : 'انشر قائمة تشغيل مفعّلة قبل إعداد الجدولة.'}</div>}
    {editor && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="schedule-title"><div className="modal-header"><h3 id="schedule-title">{editor.id ? 'تحرير جدول' : 'إضافة جدول تشغيل'}</h3><button className="icon-button" onClick={() => setEditor(null)}>×</button></div>
      <div className="form-grid">
        <div className="field"><label htmlFor="schedule-screen">الشاشة</label><select id="schedule-screen" value={editor.screenId} onChange={e => setEditor({ ...editor, screenId: e.target.value })}>{screens.map(screen => <option key={screen.id} value={screen.id}>{screen.name}</option>)}</select></div>
        <div className="field"><label htmlFor="schedule-playlist">قائمة التشغيل</label><select id="schedule-playlist" value={editor.playlistId} onChange={e => setEditor({ ...editor, playlistId: e.target.value })}>{playlists.map(playlist => <option key={playlist.id} value={playlist.id}>{playlist.name} · v{playlist.published_version}</option>)}</select></div>
        <div className="field"><label htmlFor="schedule-start">من الساعة</label><input id="schedule-start" type="time" dir="ltr" value={editor.startTime} onChange={e => setEditor({ ...editor, startTime: e.target.value })} /></div>
        <div className="field"><label htmlFor="schedule-end">إلى الساعة</label><input id="schedule-end" type="time" dir="ltr" value={editor.endTime} onChange={e => setEditor({ ...editor, endTime: e.target.value })} /></div>
        <div className="field full"><label>أيام الأسبوع</label><div className="day-pills">{days.map(day => <button type="button" key={day.id} className="day-pill" onClick={() => toggleDay(day.id)} style={{ border: 0, opacity: editor.weekdays.includes(day.id) ? 1 : .42 }}>{day.label}</button>)}</div></div>
        <div className="field"><label htmlFor="schedule-timezone">المنطقة الزمنية</label><select id="schedule-timezone" value={editor.timezone} onChange={e => setEditor({ ...editor, timezone: e.target.value })}><option value="Asia/Riyadh">Asia/Riyadh</option><option value="UTC">UTC</option></select></div>
        <div className="field"><label htmlFor="schedule-enabled">الحالة</label><select id="schedule-enabled" value={String(editor.enabled)} onChange={e => setEditor({ ...editor, enabled: e.target.value === 'true' })}><option value="true">مفعّل</option><option value="false">متوقف</option></select></div>
      </div>
      <div className="alert warning" style={{ marginTop: 14 }}>يمنع النظام تداخل الجداول النشطة على الشاشة نفسها وفي المنطقة الزمنية نفسها، مع دعم الفترات العابرة لمنتصف الليل. التبديل يستخدم ساعة الجهاز عند انقطاع الشبكة.</div>
      <div className="modal-actions"><button className="button teal" onClick={() => void save()} disabled={busy || !editor.screenId || !editor.playlistId || !editor.weekdays.length}>{busy ? 'جارٍ الحفظ…' : 'حفظ الجدول'}</button><button className="button secondary" onClick={() => setEditor(null)}>إلغاء</button></div>
    </section></div>}
  </div>;
}
