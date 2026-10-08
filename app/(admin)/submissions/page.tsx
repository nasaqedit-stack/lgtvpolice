'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/client/api';
import { PageHeader, Badge, LoadingState, ErrorState, EmptyState } from '@/components/admin-common';
import {
  SUBMISSION_STATES,
  SUBMISSION_STATE_LABELS,
  SUBMISSION_STATE_TONES,
  type SubmissionState,
} from '@/lib/shared';

type StateFilter = 'all' | SubmissionState;

export default function SubmissionsPage() {
  const [submissions, setSubmissions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [selectedSubmission, setSelectedSubmission] = useState<any>(null);
  const [eventSubmission, setEventSubmission] = useState<any>(null);
  const [busyId, setBusyId] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<{ type: 'approve' | 'reject' | 'publish' | 'archive'; submission: any } | null>(null);
  const rejectReason = useRef('');
  const loadRef = useRef<() => Promise<void> | undefined>(undefined);

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams();
      if (stateFilter !== 'all') params.set('state', stateFilter);
      params.set('limit', '50');
      const result = await api(`/api/admin/submissions?${params.toString()}`);
      if (!Array.isArray(result.submissions)) throw new Error('أعاد الخادم قائمة مشاركات غير صالحة.');
      setSubmissions(result.submissions);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر تحميل المشاركات.');
    } finally {
      setLoading(false);
    }
  }, [stateFilter]);

  loadRef.current = load;
  useEffect(() => { const timer = window.setTimeout(() => void load(), 180); return () => window.clearTimeout(timer); }, [load]);

  const openDetail = async (sub: any) => {
    setBusyId(sub.id);
    try {
      const result = await api(`/api/admin/submissions/${sub.id}`);
      setSelectedSubmission(result.submission);
      setEventSubmission({ ...result.submission, events: result.events });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر تحميل تفاصيل المشاركة.');
    } finally {
      setBusyId('');
    }
  };

  const handleAction = async (type: 'approve' | 'reject' | 'publish' | 'archive', sub: any) => {
    if (type === 'reject') {
      const reason = window.prompt('أدخل سبب الرفض:');
      if (!reason?.trim()) return;
      rejectReason.current = reason.trim();
    }
    setConfirmDialog({ type, submission: sub });
  };

  const executeAction = async () => {
    if (!confirmDialog) return;
    const { type, submission } = confirmDialog;
    setBusyId(submission.id);
    try {
      if (type === 'approve') {
        await api(`/api/admin/submissions/${submission.id}/approve`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
      } else if (type === 'reject') {
        await api(`/api/admin/submissions/${submission.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: rejectReason.current }) });
      } else if (type === 'publish') {
        await api(`/api/admin/submissions/${submission.id}/publish`, { method: 'POST' });
      } else if (type === 'archive') {
        await api(`/api/admin/submissions/${submission.id}/archive`, { method: 'POST' });
      }
      setConfirmDialog(null);
      loadRef.current?.();
      if (selectedSubmission?.id === submission.id) {
        const updated = await api(`/api/admin/submissions/${submission.id}`);
        setSelectedSubmission(updated.submission);
        setEventSubmission({ ...updated.submission, events: updated.events });
      }
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'تعذر تنفيذ الإجراء.');
    } finally {
      setBusyId('');
    }
  };

  const formatDate = (dateStr: string | null) => dateStr ? new Date(dateStr).toLocaleString('ar-SA') : '—';

  const isUploading = busyId !== '';

  return <div className="page-content">
    <PageHeader title="مراجعة المشاركات" description="إدارة ومراجعة مشاركات الجمهور قبل الاعتماد والنشر." />

    {error && <ErrorState message={error} retry={load} />}

    <div className="toolbar" style={{ marginBottom: 16 }}>
      <div className="toolbar-start">
        <select className="search-input" value={stateFilter} onChange={e => setStateFilter(e.target.value as StateFilter)} aria-label="تصفية الحالة" style={{ width: 180 }}>
          <option value="all">كل الحالات</option>
          {SUBMISSION_STATES.map(s => <option key={s} value={s}>{SUBMISSION_STATE_LABELS[s]}</option>)}
        </select>
      </div>
      <div className="toolbar-end">
        <span style={{ color: 'var(--muted)', fontSize: 12 }}>{submissions.length} مشاركة</span>
      </div>
    </div>

    {loading && submissions.length === 0 ? <LoadingState /> : submissions.length === 0 ? <EmptyState title="لا توجد مشاركات" description={stateFilter !== 'all' ? `لا توجد مشاركات بحالة «${SUBMISSION_STATE_LABELS[stateFilter as SubmissionState]}»` : 'لم يتم استلام أي مشاركات عامة بعد.'} /> : <div className="submissions-table-container">
      <table className="submissions-table" role="grid">
        <thead>
          <tr>
            <th>العنوان</th>
            <th>المُساهم</th>
            <th>الحالة</th>
            <th>النوع</th>
            <th>التاريخ</th>
            <th>الإجراءات</th>
          </tr>
        </thead>
        <tbody>
          {submissions.map((sub: { id: string; title: string; description?: string; contributor_name?: string; contributor_email?: string; state: SubmissionState; original_media?: { kind: 'image' | 'video' }; created_at: string }) => (
            <tr key={sub.id} onClick={() => void openDetail(sub)} style={{ cursor: 'pointer' }}>
              <td><strong>{sub.title}</strong>{sub.description && <small style={{ display: 'block', color: 'var(--muted)' }}>{sub.description.slice(0, 80)}{sub.description.length > 80 ? '…' : ''}</small>}</td>
              <td>{sub.contributor_name || '—'}{sub.contributor_email && <small style={{ display: 'block', color: 'var(--muted)' }}>{sub.contributor_email}</small>}</td>
              <td><Badge tone={SUBMISSION_STATE_TONES[sub.state]}>{SUBMISSION_STATE_LABELS[sub.state]}</Badge></td>
              <td>{sub.original_media?.kind === 'video' ? 'فيديو' : 'صورة'}</td>
              <td>{formatDate(sub.created_at)}</td>
              <td>
                <div className="media-actions">
                  <button className="icon-button" title="تفاصيل" onClick={e => { e.stopPropagation(); void openDetail(sub); }} disabled={busyId === sub.id}>◉</button>
                  {sub.state === 'READY_FOR_REVIEW' && <button className="icon-button" title="بدء المراجعة" onClick={e => { e.stopPropagation(); void handleAction('approve', sub); }} disabled={busyId === sub.id}>✓</button>}
                  {sub.state === 'UNDER_REVIEW' && <button className="icon-button" title="اعتماد نهائي" onClick={e => { e.stopPropagation(); void handleAction('approve', sub); }} disabled={busyId === sub.id}>★</button>}
                  {sub.state === 'READY_FOR_REVIEW' && <button className="icon-button" title="رفض" onClick={e => { e.stopPropagation(); void handleAction('reject', sub); }} disabled={busyId === sub.id}>✕</button>}
                  {sub.state === 'UNDER_REVIEW' && <button className="icon-button" title="رفض" onClick={e => { e.stopPropagation(); void handleAction('reject', sub); }} disabled={busyId === sub.id}>✕</button>}
                  {sub.state === 'APPROVED' && <button className="icon-button" title="نشر" onClick={e => { e.stopPropagation(); void handleAction('publish', sub); }} disabled={busyId === sub.id}>⬆</button>}
                  {(sub.state === 'PUBLISHED' || sub.state === 'REJECTED') && <button className="icon-button" title="أرشفة" onClick={e => { e.stopPropagation(); void handleAction('archive', sub); }} disabled={busyId === sub.id}>⌐</button>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>}

    {confirmDialog && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setConfirmDialog(null); }}>
      <section className="modal" role="dialog" aria-modal="true" style={{ width: 'min(500px,100%)' }}>
        <div className="modal-header"><h3>{confirmDialog.type === 'approve' ? 'اعتماد نهائي' : confirmDialog.type === 'reject' ? 'رفض المشاركة' : confirmDialog.type === 'publish' ? 'نشر المشاركة' : 'أرشفة المشاركة'}</h3><button className="icon-button" onClick={() => setConfirmDialog(null)}>×</button></div>
        <div className="card card-pad" style={{ margin: 16 }}>
          {confirmDialog.type === 'approve' && <p>أنت على وشك اعتماد هذه المادة للنشر. بعد الاعتماد ستصبح المادة مؤهلة للنشر وفق صلاحيات النظام. هل تؤكد الاعتماد النهائي؟</p>}
          {confirmDialog.type === 'reject' && <p>سيتم رفض المشاركة مع السبب: <strong>{rejectReason.current}</strong></p>}
          {confirmDialog.type === 'publish' && <p>سيتم نشر المشاركة المعتمدة للعرض العام. هل تؤكد النشر؟</p>}
          {confirmDialog.type === 'archive' && <p>سيتم أرشفة المشاركة ولن تظهر في قوائم المراجعة. هل تؤكد الأرشفة؟</p>}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 16 }}>
          <button className="button secondary" onClick={() => setConfirmDialog(null)}>إلغاء</button>
          <button className="button teal" onClick={executeAction} disabled={isUploading}>{confirmDialog.type === 'approve' ? 'اعتماد نهائي' : confirmDialog.type === 'reject' ? 'رفض' : confirmDialog.type === 'publish' ? 'نشر' : 'أرشفة'}</button>
        </div>
      </section>
    </div>}

    {selectedSubmission && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) { setSelectedSubmission(null); setEventSubmission(null); } }}>
      <section className="modal" role="dialog" aria-modal="true" style={{ width: 'min(1000px,100%)', maxHeight: '90vh', overflow: 'auto' }}>
        <div className="modal-header"><h3>{selectedSubmission.title}</h3><button className="icon-button" onClick={() => { setSelectedSubmission(null); setEventSubmission(null); }}>×</button></div>
        <div className="card card-pad" style={{ margin: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            <div><label>المعرف</label><code style={{ display: 'block', fontSize: 11, wordBreak: 'break-all' }}>{selectedSubmission.id}</code></div>
            <div><label>الحالة</label><Badge tone={SUBMISSION_STATE_TONES[selectedSubmission.state as SubmissionState]}>{SUBMISSION_STATE_LABELS[selectedSubmission.state as SubmissionState]}</Badge></div>
            <div><label>المُساهم</label><div>{selectedSubmission.contributor_name || '—'}{selectedSubmission.contributor_email && <small style={{ display: 'block', color: 'var(--muted)' }}>{selectedSubmission.contributor_email}</small>}{selectedSubmission.contributor_phone && <small style={{ display: 'block', color: 'var(--muted)' }}>{selectedSubmission.contributor_phone}</small>}</div></div>
            <div><label>الإقرار</label><div>{selectedSubmission.consent_accepted ? <Badge tone="online">مقبول</Badge> : <Badge tone="failed">غير مقبول</Badge>}{selectedSubmission.consent_version && <small style={{ display: 'block', color: 'var(--muted)' }}>الإصدار: {selectedSubmission.consent_version}</small>}</div></div>
            <div><label>الرابط</label><code style={{ display: 'block', fontSize: 11 }}>{selectedSubmission.token?.name || '—'}</code></div>
            <div><label>تاريخ الإرسال</label><div>{formatDate(selectedSubmission.created_at)}</div></div>
            {selectedSubmission.approved_at && <div><label>تاريخ الاعتماد</label><div>{formatDate(selectedSubmission.approved_at)}</div></div>}
            {selectedSubmission.approver && <div><label>المعتمد من قبل</label><div>{selectedSubmission.approver.email}</div></div>}
            {selectedSubmission.reviewed_at && <div><label>تاريخ المراجعة</label><div>{formatDate(selectedSubmission.reviewed_at)}</div></div>}
            {selectedSubmission.reviewer && <div><label>راجع من قبل</label><div>{selectedSubmission.reviewer.email}</div></div>}
            {selectedSubmission.published_at && <div><label>تاريخ النشر</label><div>{formatDate(selectedSubmission.published_at)}</div></div>}
            {selectedSubmission.archived_at && <div><label>تاريخ الأرشفة</label><div>{formatDate(selectedSubmission.archived_at)}</div></div>}
            {selectedSubmission.rejection_reason && <div style={{ gridColumn: '1 / -1' }}><label>سبب الرفض</label><div className="alert error" style={{ padding: 10 }}>{selectedSubmission.rejection_reason}</div></div>}
            {selectedSubmission.processing_error && <div style={{ gridColumn: '1 / -1' }}><label>خطأ المعالجة</label><div className="alert error" style={{ padding: 10 }}>{selectedSubmission.processing_error}</div></div>}
          </div>

          <div style={{ marginTop: 16 }}>
            <label>الوصف</label>
            <p style={{ whiteSpace: 'pre-wrap', color: selectedSubmission.description ? 'inherit' : 'var(--muted)' }}>{selectedSubmission.description || '—'}</p>
          </div>

          <div style={{ marginTop: 16 }}>
            <label>نص الإقرار</label>
            <p style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--muted)', background: '#f5f7fa', padding: 12, borderRadius: 6 }}>{selectedSubmission.consent_text}</p>
          </div>

          <div style={{ marginTop: 16 }}>
            <label>الوسائط</label>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {selectedSubmission.original_media && <div style={{ flex: 1, minWidth: 200 }}><strong>الأصل</strong><div className="media-thumb" style={{ marginTop: 8 }}>{selectedSubmission.original_media.thumbnail_data ? <img src={selectedSubmission.original_media.thumbnail_data} alt="" style={{ maxWidth: '100%', height: 'auto' }} /> : <span style={{ fontSize: 34 }}>▧</span>}</div><small>{selectedSubmission.original_media.display_name} · {selectedSubmission.original_media.mime_type} · {selectedSubmission.original_media.file_size ? `${Math.round(selectedSubmission.original_media.file_size / 1024)} KB` : ''}</small></div>}
              {selectedSubmission.optimized_media && <div style={{ flex: 1, minWidth: 200 }}><strong>المُحسّن</strong><div className="media-thumb" style={{ marginTop: 8 }}>{selectedSubmission.optimized_media.thumbnail_data ? <img src={selectedSubmission.optimized_media.thumbnail_data} alt="" style={{ maxWidth: '100%', height: 'auto' }} /> : <span style={{ fontSize: 34 }}>▧</span>}</div><small>{selectedSubmission.optimized_media.display_name} · {selectedSubmission.optimized_media.mime_type} · {selectedSubmission.optimized_media.file_size ? `${Math.round(selectedSubmission.optimized_media.file_size / 1024)} KB` : ''}</small></div>}
              {selectedSubmission.thumbnail_media && <div style={{ flex: 1, minWidth: 200 }}><strong>المصغرة</strong><div className="media-thumb" style={{ marginTop: 8 }}>{selectedSubmission.thumbnail_media.thumbnail_data ? <img src={selectedSubmission.thumbnail_media.thumbnail_data} alt="" style={{ maxWidth: '100%', height: 'auto' }} /> : <span style={{ fontSize: 34 }}>▧</span>}</div><small>{selectedSubmission.thumbnail_media.display_name}</small></div>}
            </div>
          </div>

          {eventSubmission?.events?.length && <div style={{ marginTop: 16 }}>
            <label>سجل التدقيق</label>
            <div style={{ maxHeight: 300, overflow: 'auto' }}>
              <table className="submissions-table" style={{ fontSize: 12 }}>
                <thead><tr><th>الوقت</th><th>النوع</th><th>من</th><th>إلى</th><th>السبب</th><th>المُنفذ</th></tr></thead>
                <tbody>
                  {eventSubmission.events?.map((ev: { id: number; created_at: string; actor_type: string; from_state?: SubmissionState; to_state: SubmissionState; reason?: string; actor_profile?: { email: string } }) => (
                    <tr key={ev.id}>
                      <td>{formatDate(ev.created_at)}</td>
                      <td>{ev.actor_type}</td>
                      <td>{ev.from_state ? SUBMISSION_STATE_LABELS[ev.from_state] : '—'}</td>
                      <td>{SUBMISSION_STATE_LABELS[ev.to_state]}</td>
                      <td>{ev.reason || '—'}</td>
                      <td>{ev.actor_profile?.email || ev.actor_type}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>}
        </div>
      </section>
    </div>}
  </div>;
}