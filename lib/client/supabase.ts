'use client';

import { createBrowserClient } from '@supabase/ssr';

let singleton: ReturnType<typeof createBrowserClient> | undefined;
export function createSupabaseBrowser() {
  if (!singleton) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anonKey) throw new Error('لم يتم إعداد اتصال قاعدة البيانات.');
    singleton = createBrowserClient(url, anonKey);
  }
  return singleton;
}
