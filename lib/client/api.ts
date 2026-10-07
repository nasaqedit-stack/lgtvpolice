'use client';

export async function api<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: 'no-store',
      headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    throw new Error('تعذر الاتصال بالخادم. تحقق من اتصالك ثم أعد المحاولة.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `فشل الطلب (${response.status}).`);
  return data as T;
}
export function jsonBody(value: unknown) { return JSON.stringify(value); }
