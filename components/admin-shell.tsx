'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { createSupabaseBrowser } from '@/lib/client/supabase';

const items = [
  { href: '/dashboard', label: 'الرئيسية', icon: '◫' },
  { href: '/screens', label: 'الشاشات', icon: '▣' },
  { href: '/media', label: 'الوسائط', icon: '▧' },
  { href: '/playlists', label: 'قوائم التشغيل', icon: '≡' },
  { href: '/schedule', label: 'الجدولة', icon: '◷' },
  { href: '/submissions', label: 'المشاركات', icon: '✉' },
  { href: '/settings', label: 'الإعدادات', icon: '⚙' },
];
const titles: Record<string, string> = {
  '/dashboard': 'نظرة عامة', '/screens': 'إدارة الشاشات', '/media': 'مكتبة الوسائط',
  '/playlists': 'قوائم التشغيل', '/schedule': 'جدولة المحتوى', '/submissions': 'مراجعة المشاركات', '/settings': 'الإعدادات',
};

export default function AdminShell({ children, email, role }: { children: React.ReactNode; email: string; role: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const title = titles[pathname] ?? 'لوحة الإدارة';
  const signOut = async () => {
    await createSupabaseBrowser().auth.signOut();
    router.replace('/login');
    router.refresh();
  };
  const nav = <>
    <div className="brand"><div className="brand-mark">ش</div><div><strong>شاشات</strong><small>إدارة العرض المؤسسي</small></div></div>
    <div className="nav-label">مساحة العمل</div>
    <nav className="nav-links" aria-label="التنقل الرئيسي">
      {items.map(item => <Link key={item.href} className={`nav-link ${pathname === item.href ? 'active' : ''}`} href={item.href} onClick={() => setMenuOpen(false)}>
        <span className="nav-icon" aria-hidden="true">{item.icon}</span>{item.label}
      </Link>)}
    </nav>
    <div className="side-spacer" />
    <button className="nav-link" onClick={signOut} aria-label="تسجيل الخروج"><span className="nav-icon">⇥</span>تسجيل الخروج</button>
    <div className="user-card"><div className="user-avatar">{email.slice(0, 1).toUpperCase() || 'م'}</div><span>{email || 'مستخدم'}<small>{role === 'admin' ? 'مدير النظام' : 'مشغّل'}</small></span></div>
  </>;

  return <div className="admin-shell">
    <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>{nav}</aside>
    {menuOpen && <button className="mobile-backdrop" aria-label="إغلاق القائمة" onClick={() => setMenuOpen(false)} />}
    <main className="admin-main">
      <header className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="icon-button mobile-menu" onClick={() => setMenuOpen(true)} aria-label="فتح القائمة">☰</button>
          <div><h1>{title}</h1><small>منصة شاشات العرض — تشغيل موثوق دون اتصال</small></div>
        </div>
        <div className="topbar-actions"><span className="live-chip"><i className="live-dot" /> النظام جاهز</span></div>
      </header>
      {children}
    </main>
  </div>;
}
