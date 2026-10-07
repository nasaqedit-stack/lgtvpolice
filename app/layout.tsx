import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'شاشات | منصة العرض المؤسسي', template: '%s | شاشات' },
  description: 'إدارة وتشغيل الشاشات الرقمية دون اعتماد مستمر على الإنترنت.',
  applicationName: 'شاشات',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#101e33',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ar" dir="rtl"><body>{children}</body></html>;
}
