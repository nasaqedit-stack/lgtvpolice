'use client';

export const DEFAULT_API_TIMEOUT_MS = 30_000;

export class RequestTimeoutError extends Error {
  constructor(readonly operation: string, readonly timeoutMs: number) {
    const seconds = Math.ceil(timeoutMs / 1000);
    super(`انتهت مهلة ${operation} بعد ${seconds} ثانية. لم يُؤكَّد اكتمال العملية؛ تحقق من مكتبة الوسائط قبل إعادة المحاولة.`);
    this.name = 'RequestTimeoutError';
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Put a hard deadline around both a fetch and any follow-up body read. Aborting the signal alone
 * is not sufficient for a stalled/mocked implementation, so the race also settles the caller.
 */
export async function withRequestTimeout<T>(
  operation: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let rejectTimeout: ((reason: RequestTimeoutError) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const task = Promise.resolve().then(() => run(controller.signal));

  const timer = setTimeout(() => {
    const error = new RequestTimeoutError(operation, timeoutMs);
    controller.abort(error);
    rejectTimeout?.(error);
  }, timeoutMs);

  try {
    return await Promise.race([task, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function safeRequestLabel(url: string) {
  try {
    const path = new URL(url, typeof window === 'undefined' ? 'http://local.invalid' : window.location.origin).pathname;
    return path.replace(/(\/media\/uploads\/)[^/]+(?=\/|$)/, '$1[uploadId]');
  } catch {
    return 'API request';
  }
}

function logRequest(outcome: 'started' | 'finished' | 'failed', label: string, elapsedMs?: number, status?: number) {
  // Never log request bodies, cookies, upload identifiers, or signed Storage URLs.
  if (process.env.NODE_ENV !== 'production') {
    console.debug(`[media-upload] ${outcome}: ${label}`, {
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
      ...(status === undefined ? {} : { status }),
    });
  }
}

export async function api<T = any>(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_API_TIMEOUT_MS): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const path = safeRequestLabel(url);
  const label = `${method} ${path}`;
  const startedAt = Date.now();
  let responseStatus: number | undefined;
  logRequest('started', label);

  try {
    const result = await withRequestTimeout(label, timeoutMs, async signal => {
      const headers = new Headers(init.headers);
      // JSON API calls pass string bodies. Leave FormData, Blob and streams alone so fetch can
      // supply the correct boundary/content type (or no content type) itself.
      if (typeof init.body === 'string' && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }

      let response: Response;
      try {
        response = await fetch(url, { ...init, cache: 'no-store', headers, signal });
        responseStatus = response.status;
      } catch {
        if (signal.aborted && signal.reason instanceof Error) throw signal.reason;
        throw new Error('تعذر الاتصال بالخادم. تحقق من اتصالك ثم أعد المحاولة.');
      }

      let data: any = {};
      try {
        data = await response.json();
      } catch {
        if (response.ok) throw new Error('أعاد الخادم استجابة غير صالحة؛ لم يتم تأكيد العملية.');
      }
      if (!response.ok) {
        const message = typeof data?.error === 'string' && data.error.trim()
          ? data.error
          : `فشل الطلب (${response.status}).`;
        throw new ApiError(message, response.status, typeof data?.code === 'string' ? data.code : undefined);
      }
      return data as T;
    });
    logRequest('finished', label, Date.now() - startedAt, responseStatus);
    return result;
  } catch (error) {
    logRequest('failed', label, Date.now() - startedAt, error instanceof ApiError ? error.status : responseStatus);
    throw error;
  }
}

export function jsonBody(value: unknown) { return JSON.stringify(value); }
