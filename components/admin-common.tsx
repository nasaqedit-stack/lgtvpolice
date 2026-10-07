'use client';

export function PageHeader({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-heading"><div><h2>{title}</h2><p>{description}</p></div>{action}</div>;
}
export function LoadingState({ label = 'جارٍ تحميل البيانات…' }: { label?: string }) {
  return <div className="card empty-state"><div><strong>{label}</strong><span>تتم قراءة البيانات المحفوظة من الخادم.</span></div></div>;
}
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="alert error" role="alert">{message}{retry && <button className="button small secondary" style={{ marginRight: 12 }} onClick={retry}>إعادة المحاولة</button>}</div>;
}
export function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="empty-state"><div><strong>{title}</strong><span>{description}</span>{action && <div style={{ marginTop: 14 }}>{action}</div>}</div></div>;
}
export function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'online' | 'offline' | 'pending' | 'failed' | 'neutral' }) {
  return <span className={`badge ${tone}`}><i className={tone === 'online' ? 'live-dot' : ''} />{children}</span>;
}
