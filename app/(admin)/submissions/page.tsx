'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, jsonBody } from '@/lib/client/api';
import { formatBytes } from '@/lib/shared';
import {
  SUBMISSION_AUDIT_EVENT_LABELS,
  SUBMISSION_PROCESSING_LABELS,
  SUBMISSION_QUEUE_FILTERS,
  SUBMISSION_STATE_LABELS,
  submissionProcessingTone,
  submissionStateTone,
  type SubmissionQueueFilter,
  type SubmissionState,
} from '@/lib/shared/submissions';
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/admin-common';
import { useAdminRole } from '@/components/admin-shell';

const APPROVE_CONFIRMATION =
  'أنت على وشك اعتماد هذه المادة للنشر. بعد الاعتماد ستصبح المادة مؤهلة للنشر وفق صلاحيات النظام. هل تؤكد الاعتماد النهائي؟';
const PUBLISH_CONFIRMATION =
  'أنت على وشك نشر هذه المادة للعامة. ستصبح مرئية على رابط النشر العام. هل تؤكد النشر؟';
const UNPUBLISH_CONFIRMATION =
  'أنت على وشك إلغاء نشر هذه المادة. لن تعود متاحة للعامة. هل تؤكد إلغاء النشر؟';

type Submission = any;
type SubmissionEvent = any;

/**
 * Admin submissions queue: public contributions awaiting review, final approval and
 * publication. The FINAL APPROVER (admin role) sees the approval/publish actions; reviewers
 * (operator) see review actions. Every action is enforced server-side.
 */
export default function SubmissionsPage() {
  const role = useAdminRole();
  const isApprover = role === 'admin';
  const [filter, setFilter] = useState<SubmissionQueueFilter>('new');
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ submission: Submission; events: SubmissionEvent[]; mediaUsage: number } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');
  const [confirm, setConfirm] = useState<null | { kind: 'approve' | 'publish' | 'unpublish'; text: string }>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectOpen, setRejectOpen] = useState(false);
  const [changesNotes, setChangesNotes] = useState('');
  const [changesOpen, setChangesOpen] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [links, setLinks] = useState<any[]>([]);
  const [newLinkLabel, setNewLinkLabel] = useState('');
  const [createdLink, setCreatedLink] = useState<{ url: string; label: string } | null>(null);
  const [linksOpen, setLinksOpen] = useState(false);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 5000);
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await api(`/api/admin/submissions?filter=${filter}`);
      setSubmissions(result.submissions ?? []);
      setCounts(result.filterCounts ?? {});
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذر تحميل المشاركات.');
    } finally {
      setLoading(false);
    }
  }, [filter]);
  useEffect(() => { setLoading(true); void load(); }, [load]);

  const loadLinks = useCallback(async () => {
    try { setLinks((await api('/api/admin/submission-links')).links ?? []); }
    catch { /* links panel is optional */ }
  }, []);
  useEffect(() => { if (linksOpen) void loadLinks(); }, [linksOpen, loadLinks]);

  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setPreviews({});
    setDetailLoading(true);
    try {
      const result = await api(`/api/admin/submissions/${id}`);
      setDetail(result);
      const submission = result.submission as Submission;
      const entries = (['original', 'optimized', 'thumbnail'] as const)
        .filter(kind => (kind === 'original' ? submission.original_storage_path : kind === 'optimized' ? submission.optimized_storage_path : submission.thumbnail_storage_path));
      const loaded = await Promise.all(entries.map(async kind => {
        try { return [kind, (await api(`/api/admin/submissions/${id}/media/${kind}`)).url as string] as const; }
        catch { return [kind, ''] as const; }
      }));
      setPreviews(Object.fromEntries(loaded.filter(([, url]) => url)));
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'تعذر تحميل المشاركة.');
      setSelectedId(null);
    } finally {
      setDetailLoading(false);
    }
  }, [showToast]);

  const refreshDetail = useCallback(async () => {
    if (selectedId) await openDetail(selectedId);
    await load();
  }, [selectedId, openDetail, load]);

  const act = useCallback(async (path: string, body?: unknown, successMessage?: string) => {
    setBusy(path);
    try {
      const result = await api(path, body === undefined ? { method: 'POST' } : { method: 'POST', body: jsonBody(body) });
      if (successMessage) showToast(successMessage);
      setConfirm(null);
      setRejectOpen(false);
      setChangesOpen(false);
      setRejectReason('');
      setChangesNotes('');
      await refreshDetail();
      return result;
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'تعذر تنفيذ الإجراء.');
      return null;
    } finally {
      setBusy('');
    }
  }, [refreshDetail, showToast]);

  const createLink = useCallback(async () => {
    if (!newLinkLabel.trim()) return;
    setBusy('links');
    try {
      const result = await api('/api/admin/submission-links', { method: 'POST', body: jsonBody({ label: newLinkLabel.trim() }) });
      setCreatedLink({ url: result.url, label: result.link.label });
      setNewLinkLabel('');
      await loadLinks();
    } catch (reason) {
      showToast(reason instanceof Error ? reason.message : 'تعذر إنشاء الرابط.');
    } finally {
      setBusy('');
    }
  }, [newLinkLabel, loadLinks, showToast]);

  const submission = detail?.submission as Submission | undefined;
  const state = submission?.state as SubmissionState | undefined;

  return (
    <div className="page-content">
      <PageHeader
        title="مشاركات المساهمين"
        description="استلام المواد التوعوية والتعليمية، ثم المراجعة والاعتماد النهائي والنشر. المادة غير المعتمدة لا تُنشر أبدًا."
        action={isApprover && <button className="button secondary" onClick={() => setLinksOpen(true)}>روابط المشاركة ✉</button>}
      />

      <div className="toolbar">
        <div className="toolbar-start" style={{ flexWrap: 'wrap' }}>
          {SUBMISSION_QUEUE_FILTERS.map(entry => (
            <button
              key={entry.id}
              className={`button small ${filter === entry.id ? 'teal' : 'secondary'}`}
              onClick={() => { setFilter(entry.id); setSelectedId(null); setDetail(null); }}
            >
              {entry.label}{counts[entry.id] ? ` (${counts[entry.id]})` : ''}
            </button>
          ))}
        </div>
        <div className="toolbar-end">
          <button className="button small secondary" onClick={() => void load()}>تحديث</button>
        </div>
      </div>

      {error && <ErrorState message={error} retry={() => void load()} />}
      {loading && <LoadingState label="جارٍ تحميل المشاركات…" />}
      {!loading && !error && submissions.length === 0 && (
        <div className="card"><EmptyState title="لا توجد مشاركات" description="لا توجد مشاركات في هذه الحالة حاليًا." /></div>
      )}

      {!loading && !error && submissions.length > 0 && (
        <div className="card"><div className="table-wrap"><table>
          <thead><tr><th>العنوان</th><th>المساهم</th><th>النوع</th><th>الحجم</th><th>الحالة</th><th>المعالجة</th><th>التاريخ</th><th></th></tr></thead>
          <tbody>
            {submissions.map((row: Submission) => (
              <tr key={row.id} style={{ cursor: 'pointer', background: selectedId === row.id ? '#f2fbf9' : undefined }} onClick={() => void openDetail(row.id)}>
                <td><span className="table-name">{row.title}</span><span className="table-sub">#{row.id.slice(0, 8)} · v{row.version}</span></td>
                <td>{row.contributor_name}</td>
                <td>{row.kind === 'video' ? 'فيديو' : row.kind === 'image' ? 'صورة' : '—'}</td>
                <td>{row.file_size ? formatBytes(Number(row.file_size)) : '—'}</td>
                <td><Badge tone={submissionStateTone(row.state)}>{SUBMISSION_STATE_LABELS[row.state as SubmissionState]}</Badge></td>
                <td><Badge tone={submissionProcessingTone(row.processing_status)}>{SUBMISSION_PROCESSING_LABELS[row.processing_status as keyof typeof SUBMISSION_PROCESSING_LABELS]}</Badge></td>
                <td>{new Date(row.created_at).toLocaleString('ar-SA')}</td>
                <td><button className="button small secondary" onClick={event => { event.stopPropagation(); void openDetail(row.id); }}>مراجعة</button></td>
              </tr>
            ))}
          </tbody>
        </table></div></div>
      )}

      {selectedId && (
        <div className="modal-backdrop" onClick={() => { setSelectedId(null); setDetail(null); }}>
          <div className="modal" onClick={event => event.stopPropagation()}>
            {detailLoading && <LoadingState label="جارٍ تحميل المشاركة…" />}
            {submission && state && (
              <>
                <div className="modal-header">
                  <h3>{submission.title}</h3>
                  <Badge tone={submissionStateTone(state)}>{SUBMISSION_STATE_LABELS[state]}</Badge>
                </div>

                <div className="grid-2" style={{ marginTop: 0 }}>
                  <section>
                    <div className="section-title"><h3>معاينة</h3><span>أصلي + معالج</span></div>
                    {previews.optimized && submission.kind === 'video'
                      ? <video src={previews.optimized} controls style={{ width: '100%', borderRadius: 10, background: '#000', maxHeight: 260 }} />
                      : previews.optimized && <img src={previews.optimized} alt="معاينة" style={{ width: '100%', borderRadius: 10, maxHeight: 260, objectFit: 'contain', background: '#f4f7fa' }} />}
                    {!previews.optimized && <div className="empty-state"><div><strong>لا توجد نسخة معالجة</strong><span>ستتوفر المعاينة بعد اكتمال المعالجة.</span></div></div>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                      {previews.original && <a className="button small secondary" href={previews.original} target="_blank" rel="noreferrer">الملف الأصلي ↗</a>}
                      {previews.optimized && <a className="button small secondary" href={previews.optimized} target="_blank" rel="noreferrer">النسخة المعالجة ↗</a>}
                      {previews.thumbnail && <a className="button small secondary" href={previews.thumbnail} target="_blank" rel="noreferrer">المصغّرة ↗</a>}
                      {submission.state === 'PUBLISHED' && <a className="button small teal" href={`/api/public/submissions/${submission.id}/media`} target="_blank" rel="noreferrer">رابط النشر العام ↗</a>}
                    </div>
                  </section>
                  <section>
                    <div className="section-title"><h3>بيانات المشاركة</h3><span>#{submission.id.slice(0, 8)}</span></div>
                    <SubmissionFacts submission={submission} />
                  </section>
                </div>

                {submission.processing_status === 'failed' && (
                  <div className="alert error" style={{ marginTop: 14 }}>
                    <strong>فشلت معالجة الوسائط.</strong> تم الاحتفاظ بالملف الأصلي. لا يمكن اعتماد أو نشر المشاركة قبل إكمال المعالجة.
                    <div style={{ marginTop: 6, fontSize: 11, direction: 'ltr', textAlign: 'right' }}>{submission.processing_error}</div>
                  </div>
                )}
                {submission.consent_accepted && (
                  <div className="alert success" style={{ marginTop: 14 }}>
                    <strong>الإقرار مسجّل:</strong> version {submission.consent_version} — {submission.consent_at ? new Date(submission.consent_at).toLocaleString('ar-SA') : ''}
                    <div style={{ fontSize: 11, marginTop: 6, color: 'var(--muted)', lineHeight: 1.8 }}>{submission.consent_text}</div>
                  </div>
                )}

                <div className="section-title" style={{ marginTop: 18 }}><h3>الإجراءات</h3><span>تنفيذ من الخادم</span></div>
                <div className="row-actions" style={{ gap: 8 }}>
                  {(state === 'READY_FOR_REVIEW' || state === 'UNDER_REVIEW') && (
                    <>
                      {state === 'READY_FOR_REVIEW' && (
                        <button className="button small secondary" disabled={!!busy} onClick={() => void act(`/api/admin/submissions/${submission.id}/review`, { action: 'start' })}>بدء المراجعة</button>
                      )}
                      {state === 'UNDER_REVIEW' && (
                        <button className="button small secondary" disabled={!!busy} onClick={() => setChangesOpen(true)}>طلب تعديلات</button>
                      )}
                      {isApprover && (
                        <button className="button small teal" disabled={!!busy || submission.processing_status !== 'completed'} onClick={() => setConfirm({ kind: 'approve', text: APPROVE_CONFIRMATION })}>اعتماد نهائي</button>
                      )}
                      {isApprover && (
                        <button className="button small danger" disabled={!!busy} onClick={() => setRejectOpen(true)}>رفض</button>
                      )}
                    </>
                  )}
                  {state === 'APPROVED' && isApprover && (
                    <>
                      <button className="button small teal" disabled={!!busy} onClick={() => setConfirm({ kind: 'publish', text: PUBLISH_CONFIRMATION })}>نشر</button>
                      <button className="button small danger" disabled={!!busy} onClick={() => setRejectOpen(true)}>رفض</button>
                    </>
                  )}
                  {state === 'APPROVED' && !isApprover && <span className="badge neutral">بانتظار الاعتماد النهائي من المدير</span>}
                  {state === 'PUBLISHED' && isApprover && (
                    <button className="button small danger" disabled={!!busy} onClick={() => setConfirm({ kind: 'unpublish', text: UNPUBLISH_CONFIRMATION })}>إلغاء النشر</button>
                  )}
                  {(state === 'READY_FOR_REVIEW' || state === 'UNDER_REVIEW' || state === 'REJECTED') && (
                    <button className="button small secondary" disabled={!!busy} onClick={() => void act(`/api/admin/submissions/${submission.id}/reprocess`, undefined, 'اكتملت إعادة المعالجة.')}>إعادة المعالجة</button>
                  )}
                  {state !== 'ARCHIVED' && state !== 'PUBLISHED' && (
                    <button className="button small secondary" disabled={!!busy} onClick={() => void act(`/api/admin/submissions/${submission.id}/archive`, undefined, 'تمت أرشفة المشاركة.')}>أرشفة</button>
                  )}
                </div>

                <div className="section-title" style={{ marginTop: 18 }}><h3>سجل المراجعة والاعتماد</h3><span>append-only</span></div>
                <div className="card" style={{ border: '1px solid var(--line)', maxHeight: 220, overflow: 'auto' }}>
                  {(!detail || detail.events.length === 0) && <div className="empty-state"><span>لا توجد أحداث بعد.</span></div>}
                  {(detail?.events ?? []).map((event: SubmissionEvent) => (
                    <div key={event.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '9px 14px', borderBottom: '1px solid #eef1f5', fontSize: 12 }}>
                      <Badge tone={event.event === 'APPROVED' || event.event === 'PUBLISHED' ? 'online' : event.event === 'REJECTED' || event.event === 'PROCESSING_FAILED' ? 'failed' : 'neutral'}>
                        {SUBMISSION_AUDIT_EVENT_LABELS[event.event as keyof typeof SUBMISSION_AUDIT_EVENT_LABELS] ?? event.event}
                      </Badge>
                      <span style={{ color: 'var(--muted)' }}>{new Date(event.created_at).toLocaleString('ar-SA')}</span>
                      <span style={{ color: 'var(--muted)' }}>{event.actor_role ?? ''}{event.state_after ? ` → ${SUBMISSION_STATE_LABELS[event.state_after as SubmissionState] ?? event.state_after}` : ''}</span>
                      {event.event === 'APPROVED' && event.details?.submissionVersion && <span style={{ color: 'var(--muted)' }}>version {String(event.details.submissionVersion)}</span>}
                      {event.event === 'REJECTED' && event.details?.reason && <span style={{ color: 'var(--danger)' }}>السبب: {String(event.details.reason)}</span>}
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className="modal-actions">
              <button className="button secondary" onClick={() => { setSelectedId(null); setDetail(null); }}>إغلاق</button>
            </div>
          </div>
        </div>
      )}

      {confirm && submission && (
        <div className="modal-backdrop" onClick={() => setConfirm(null)}>
          <div className="modal" style={{ width: 'min(520px,100%)' }} onClick={event => event.stopPropagation()}>
            <div className="modal-header"><h3>{confirm.kind === 'approve' ? 'الاعتماد النهائي' : confirm.kind === 'publish' ? 'نشر المشاركة' : 'إلغاء النشر'}</h3></div>
            <p style={{ lineHeight: 1.9 }}>{confirm.text}</p>
            <div className="modal-actions">
              <button className="button secondary" onClick={() => setConfirm(null)}>إلغاء</button>
              <button
                className={`button ${confirm.kind === 'approve' ? 'teal' : confirm.kind === 'publish' ? 'teal' : 'danger'}`}
                disabled={!!busy}
                onClick={() => void act(
                  `/api/admin/submissions/${submission.id}/${confirm.kind === 'approve' ? 'approve' : confirm.kind === 'publish' ? 'publish' : 'unpublish'}`,
                  { confirm: true },
                  confirm.kind === 'approve' ? 'تم اعتماد المشاركة نهائيًا.' : confirm.kind === 'publish' ? 'تم نشر المشاركة.' : 'تم إلغاء نشر المشاركة.',
                )}
              >
                {confirm.kind === 'approve' ? 'اعتماد نهائي' : confirm.kind === 'publish' ? 'نشر' : 'إلغاء النشر'}
              </button>
            </div>
          </div>
        </div>
      )}

      {rejectOpen && submission && (
        <div className="modal-backdrop" onClick={() => setRejectOpen(false)}>
          <div className="modal" style={{ width: 'min(520px,100%)' }} onClick={event => event.stopPropagation()}>
            <div className="modal-header"><h3>رفض المشاركة</h3></div>
            <div className="field"><label>سبب الرفض *</label>
              <textarea value={rejectReason} onChange={event => setRejectReason(event.target.value)} placeholder="اذكر سبب الرفض بإيجاز" />
            </div>
            <div className="modal-actions">
              <button className="button secondary" onClick={() => setRejectOpen(false)}>إلغاء</button>
              <button className="button danger" disabled={!!busy || rejectReason.trim().length < 3}
                onClick={() => void act(`/api/admin/submissions/${submission.id}/reject`, { reason: rejectReason.trim() }, 'تم رفض المشاركة.')}>
                رفض المشاركة
              </button>
            </div>
          </div>
        </div>
      )}

      {changesOpen && submission && (
        <div className="modal-backdrop" onClick={() => setChangesOpen(false)}>
          <div className="modal" style={{ width: 'min(520px,100%)' }} onClick={event => event.stopPropagation()}>
            <div className="modal-header"><h3>طلب تعديلات</h3></div>
            <div className="field"><label>ملاحظات التعديل (اختياري)</label>
              <textarea value={changesNotes} onChange={event => setChangesNotes(event.target.value)} placeholder="ما الذي يجب تعديله؟" />
            </div>
            <div className="modal-actions">
              <button className="button secondary" onClick={() => setChangesOpen(false)}>إلغاء</button>
              <button className="button teal" disabled={!!busy}
                onClick={() => void act(`/api/admin/submissions/${submission.id}/review`, { action: 'request_changes', notes: changesNotes.trim() }, 'تم طلب التعديلات.')}>
                إرسال الطلب
              </button>
            </div>
          </div>
        </div>
      )}

      {linksOpen && (
        <div className="modal-backdrop" onClick={() => { setLinksOpen(false); setCreatedLink(null); }}>
          <div className="modal" onClick={event => event.stopPropagation()}>
            <div className="modal-header"><h3>روابط المشاركة العامة</h3><span>للمساهمين</span></div>
            <div className="alert info">الرابط يفتح استمارة إرسال عامة (بدون حساب). لا يمنح أي صلاحية إدارية ولا يُظهر بيانات المساهمين الآخرين.</div>
            {createdLink && (
              <div className="alert success">
                <strong>تم إنشاء الرابط — انسخه الآن، لن يُعرض مرة أخرى:</strong>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <input readOnly value={createdLink.url} dir="ltr" onFocus={event => event.target.select()} style={{ flex: 1 }} />
                  <button className="button small secondary" onClick={() => { void navigator.clipboard?.writeText(createdLink.url); showToast('تم نسخ الرابط.'); }}>نسخ</button>
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
              <input value={newLinkLabel} onChange={event => setNewLinkLabel(event.target.value)} placeholder="تسمية الرابط (مثال: حملة توعية 2026)" style={{ flex: 1 }} />
              <button className="button teal" disabled={!!busy || !newLinkLabel.trim()} onClick={() => void createLink()}>إنشاء رابط</button>
            </div>
            <div className="table-wrap"><table>
              <thead><tr><th>التسمية</th><th>الحالة</th><th>المشاركات</th><th>تاريخ الإنشاء</th><th></th></tr></thead>
              <tbody>
                {links.map((link: any) => (
                  <tr key={link.id}>
                    <td>{link.label}</td>
                    <td><Badge tone={link.active ? 'online' : 'offline'}>{link.active ? 'نشط' : 'موقوف'}</Badge></td>
                    <td>{link.submissionCount}</td>
                    <td>{new Date(link.created_at).toLocaleString('ar-SA')}</td>
                    <td>
                      <button className="button small secondary" disabled={!!busy}
                        onClick={async () => { await api('/api/admin/submission-links', { method: 'PATCH', body: jsonBody({ id: link.id, active: !link.active }) }); await loadLinks(); }}>
                        {link.active ? 'إيقاف' : 'تفعيل'}
                      </button>
                    </td>
                  </tr>
                ))}
                {links.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد روابط بعد.</td></tr>}
              </tbody>
            </table></div>
            <div className="modal-actions"><button className="button secondary" onClick={() => { setLinksOpen(false); setCreatedLink(null); }}>إغلاق</button></div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function SubmissionFacts({ submission }: { submission: Submission }) {
  const rows: Array<[string, ReactNode]> = [
    ['الوصف', submission.description || '—'],
    ['المساهم', `${submission.contributor_name} — ${submission.contributor_contact}`],
    ['النوع', submission.mime_type ?? '—'],
    ['الحجم الأصلي', submission.file_size ? formatBytes(Number(submission.file_size)) : '—'],
    ['الحجم بعد المعالجة', submission.optimized_file_size ? formatBytes(Number(submission.optimized_file_size)) : '—'],
    ['الأبعاد', submission.width && submission.height ? `${submission.width}×${submission.height}` : '—'],
    ['المدة', submission.duration_ms ? `${Math.round(Number(submission.duration_ms) / 1000)}s` : '—'],
    ['بصمة الأصل (SHA-256)', submission.sha256 ? <code dir="ltr" style={{ fontSize: 10 }}>{submission.sha256.slice(0, 16)}…</code> : '—'],
    ['بصمة النسخة المعالجة', submission.optimized_sha256 ? <code dir="ltr" style={{ fontSize: 10 }}>{submission.optimized_sha256.slice(0, 16)}…</code> : '—'],
    ['تاريخ الإرسال', new Date(submission.created_at).toLocaleString('ar-SA')],
    ['اعتمد بواسطة', submission.approved_at ? `${new Date(submission.approved_at).toLocaleString('ar-SA')} · version ${submission.approved_version}` : '—'],
    ['تاريخ النشر', submission.published_at ? new Date(submission.published_at).toLocaleString('ar-SA') : '—'],
  ];
  return (
    <div style={{ display: 'grid', gap: 9, fontSize: 12 }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, paddingBottom: 8, borderBottom: '1px solid #eef1f5' }}>
          <span style={{ color: 'var(--muted)' }}>{label}</span>
          <span style={{ textAlign: 'left', maxWidth: '60%', overflowWrap: 'anywhere' }}>{value}</span>
        </div>
      ))}
    </div>
  );
}
