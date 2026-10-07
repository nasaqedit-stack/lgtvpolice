import { redirect } from 'next/navigation';
import { createSupabaseServer, createSupabaseAdmin } from '@/lib/server/supabase';
import AdminShell from '@/components/admin-shell';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const auth = await createSupabaseServer();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) redirect('/login');

  const db = createSupabaseAdmin();
  const { data: profile } = await db.from('profiles').select('role, disabled').eq('id', user.id).maybeSingle();
  if (!profile || profile.disabled || !['admin', 'operator'].includes(profile.role)) redirect('/login?denied=1');

  return <AdminShell email={user.email ?? ''} role={profile.role}>{children}</AdminShell>;
}
