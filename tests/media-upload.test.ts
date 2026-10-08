import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, RequestTimeoutError } from '@/lib/client/api';
import { runUploadTask, type UploadUiState } from '@/lib/client/upload-state';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('admin media upload state', () => {
  it('transitions to success only after the server task returns a media record', async () => {
    const states: UploadUiState[] = [];
    const mediaRecord = { id: 'media-row-id' };
    const result = await runUploadTask(
      { name: 'sample.png', size: 100 },
      state => states.push(state),
      async report => {
        report('إنشاء سجل الوسيط…', 100);
        return mediaRecord;
      },
    );

    expect(result).toEqual(mediaRecord);
    expect(states.map(state => state.status)).toEqual(['uploading', 'uploading', 'success']);
    expect(states.at(-1)?.percent).toBe(100);
  });

  it('leaves uploading and shows an error when a multipart-complete fetch never settles', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const observed = { signal: null as AbortSignal | null };
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      observed.signal = init?.signal ?? null;
      // Model a fetch implementation that never settles, even if its signal is aborted.
      return new Promise<Response>(() => undefined);
    }));

    const states: UploadUiState[] = [];
    const upload = runUploadTask(
      { name: 'sample.png', size: 100 },
      state => states.push(state),
      async () => api('/api/admin/media/uploads/upload-id/complete', { method: 'POST', body: '{}' }, 250),
    );
    const rejected = expect(upload).rejects.toBeInstanceOf(RequestTimeoutError);

    await vi.advanceTimersByTimeAsync(250);
    await rejected;

    expect(observed.signal?.aborted).toBe(true);
    expect(states.map(state => state.status)).toEqual(['uploading', 'error']);
    expect(states.at(-1)?.phase).toContain('فشل الرفع');
    expect(states.at(-1)?.error).toContain('complete');
  });

  it('also times out while reading a success response whose JSON body never finishes', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const observed = { signal: null as AbortSignal | null };
    const stalledResponse = { ok: true, status: 201, json: () => new Promise<never>(() => undefined) } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      observed.signal = init?.signal ?? null;
      return Promise.resolve(stalledResponse);
    }));

    const request = api('/api/admin/media/uploads/upload-id/complete', {}, 100);
    const rejected = expect(request).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(observed.signal?.aborted).toBe(true);
  });

  it('surfaces the API error payload instead of treating an error response as success', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Storage returned BadDigest', code: 'storage_error' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(api('/api/admin/media/uploads/upload-id/complete'))
      .rejects.toMatchObject({ message: 'Storage returned BadDigest', status: 502, code: 'storage_error' });
  });

  it('does not overwrite the browser-generated multipart boundary with an application/json header', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ uploadId: 'new-id' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api('/api/admin/media/uploads', { method: 'POST', body: new FormData() });

    const requestHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.has('content-type')).toBe(false);
  });
});
