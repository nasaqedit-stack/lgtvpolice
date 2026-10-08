import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseAdmin, createSupabaseServer } from '@/lib/server/supabase';
import { ConfigError } from '@/lib/server/config-error';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'request_failed') {
    super(message);
    this.name = 'HttpError';
  }
}

function safeErrorFields(error: unknown) {
  const value = error as { name?: unknown; message?: unknown; code?: unknown; status?: unknown } | null;
  const name = typeof value?.name === 'string' ? value.name.slice(0, 100) : 'UnknownError';
  const code = typeof value?.code === 'string' ? value.code.slice(0, 100) : undefined;
  const status = typeof value?.status === 'number' ? value.status : undefined;
  let message = error instanceof Error
    ? error.message
    : typeof value?.message === 'string' ? value.message : String(error);
  // Diagnostics must not echo signed URLs, auth headers, or credential-like values.
  message = message
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL redacted]')
    .replace(/(authorization|access[_ -]?key|secret|token|signature|password)(\s*[:=]\s*|\s+)[^\s,;]+/gi, '$1$2[redacted]')
    .slice(0, 1000);
  return { name, code, status, message };
}

export function errorResponse(error: unknown, context: { route?: string; stage?: string } = {}) {
  if (error instanceof HttpError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  if (error instanceof ConfigError) {
    // Environment variable names are not secret; values are never included in the response.
    console.error('Server configuration error:', { variable: error.variable, ...context });
    return NextResponse.json({
      error: `الخادم غير مهيأ: المتغيّر البيئي "${error.variable}" غير مضبوط في بيئة الإنتاج. راجع إعدادات متغيرات البيئة في Vercel.`,
      code: 'server_misconfigured',
      missingVariable: error.variable,
    }, { status: 503 });
  }
  const details = safeErrorFields(error);
  if (process.env.NODE_ENV !== 'production') {
    console.error('Unhandled API error:', { ...context, ...details });
    return NextResponse.json({
      error: `خطأ من الخادم: ${details.message}`,
      code: details.code || 'internal_error',
    }, { status: 500 });
  }
  // Production logs contain operation-safe metadata only; do not serialize SDK errors, headers,
  // request bodies, signed URLs, or tokens into Vercel logs.
  console.error('Unhandled API error:', { ...context, name: details.name, code: details.code, status: details.status });
  return NextResponse.json({ error: 'تعذر إكمال الطلب. حاول مرة أخرى.', code: 'internal_error' }, { status: 500 });
}

export async function requireAdmin(request?: NextRequest) {
  if (request && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) assertSameOrigin(request);
  const auth = await createSupabaseServer();
  const { data: { user }, error } = await auth.auth.getUser();
  if (error || !user) throw new HttpError(401, 'يلزم تسجيل الدخول.', 'unauthorized');

  const db = createSupabaseAdmin();
  const { data: profile, error: profileError } = await db
    .from('profiles')
    .select('role, disabled')
    .eq('id', user.id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile || profile.disabled || !['admin', 'operator'].includes(profile.role)) {
    throw new HttpError(403, 'ليس لديك صلاحية لإدارة هذا النظام.', 'forbidden');
  }
  return { user, role: profile.role as 'admin' | 'operator', db };
}

export function assertSameOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (!origin) throw new HttpError(403, 'يتطلب هذا الطلب مصدراً موثوقاً.', 'origin_required');
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const requestHost = forwardedHost || request.headers.get('host') || request.nextUrl.host;
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const scheme = forwardedProto || request.nextUrl.protocol.replace(':', '');
  const expected = `${scheme}://${requestHost}`;
  if (origin !== expected && origin !== request.nextUrl.origin) throw new HttpError(403, 'تم رفض الطلب بسبب اختلاف مصدره.', 'origin_rejected');
}

export async function requireScreen(request: NextRequest) {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+([A-Za-z0-9_-]{40,100})$/.exec(header);
  if (!match) throw new HttpError(401, 'اعتماد الشاشة مفقود.', 'screen_unauthorized');
  const { createHash } = await import('node:crypto');
  const tokenHash = createHash('sha256').update(match[1]).digest('hex');
  const db = createSupabaseAdmin();
  const { data: credential, error } = await db
    .from('screen_credentials')
    .select('id, screen_id')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!credential) throw new HttpError(401, 'اعتماد الشاشة غير صالح أو تم إلغاؤه.', 'screen_unauthorized');

  const { data: screen, error: screenError } = await db
    .from('screens')
    .select('*')
    .eq('id', credential.screen_id)
    .maybeSingle();
  if (screenError) throw screenError;
  if (!screen) throw new HttpError(401, 'الشاشة غير موجودة.', 'screen_unauthorized');
  if (!screen.enabled) throw new HttpError(403, 'هذه الشاشة معطّلة حالياً.', 'screen_disabled');
  await db.from('screen_credentials').update({ last_used_at: new Date().toISOString() }).eq('id', credential.id);
  return { db, screen };
}

export async function readJson<T = unknown>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new HttpError(400, 'صيغة الطلب غير صحيحة.', 'invalid_json');
  }
}
