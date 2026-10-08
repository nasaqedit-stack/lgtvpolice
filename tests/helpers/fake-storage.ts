/**
 * A fake S3-compatible object store for route-level tests, answering the exact subset of the
 * S3 API the application uses (multipart upload, presigned part PUTs, Head/Get with Range,
 * Put/Delete). Like Supabase Storage, its ListParts reply carries PartNumber/LastModified/ETag
 * and NO per-part Size element.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type StoredObject = { bytes: Uint8Array; contentType: string; cacheControl?: string };
export type FakeUpload = { key: string; contentType: string; parts: Map<number, Uint8Array> };

const xmlEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function startFakeStorage(): Promise<{
  server: Server;
  endpoint: string;
  objects: Map<string, StoredObject>;
  uploads: Map<string, FakeUpload>;
}> {
  const objects = new Map<string, StoredObject>();
  const uploads = new Map<string, FakeUpload>();
  let uploadCounter = 0;

  const send = (response: any, status: number, body: string | Uint8Array, headers: Record<string, string> = {}) => {
    const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    response.writeHead(status, { 'Content-Length': String(payload.length), ...headers });
    response.end(payload);
  };

  const server = createServer(async (request, response) => {
    const url = new URL(String(request.url), 'http://127.0.0.1');
    const [, bucket, ...rest] = url.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    const uploadId = url.searchParams.get('uploadId');
    const partNumber = url.searchParams.get('partNumber');
    const readBody = async (): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    };
    try {
      // CreateMultipartUpload
      if (request.method === 'POST' && url.searchParams.has('uploads')) {
        uploadCounter += 1;
        const id = `fake-upload-${uploadCounter}`;
        uploads.set(id, { key, contentType: String(request.headers['content-type'] ?? 'application/octet-stream'), parts: new Map() });
        return send(response, 200, `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`, { 'Content-Type': 'application/xml' });
      }
      // UploadPart (direct or presigned)
      if (request.method === 'PUT' && partNumber && uploadId) {
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) return send(response, 404, 'NoSuchUpload', { 'Content-Type': 'application/xml' });
        const body = await readBody();
        upload.parts.set(Number(partNumber), new Uint8Array(body));
        return send(response, 200, '', { ETag: `"etag-${partNumber}"` });
      }
      // PutObject (optimized media, thumbnails)
      if (request.method === 'PUT') {
        const body = await readBody();
        objects.set(key, {
          bytes: new Uint8Array(body),
          contentType: String(request.headers['content-type'] ?? 'application/octet-stream'),
          cacheControl: request.headers['cache-control'],
        });
        return send(response, 200, '', { ETag: '"etag-put"' });
      }
      // ListParts — no <Size> element, exactly like Supabase Storage's S3 handler.
      if (request.method === 'GET' && uploadId) {
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) return send(response, 404, 'NoSuchUpload', { 'Content-Type': 'application/xml' });
        const parts = [...upload.parts.entries()].sort((left, right) => left[0] - right[0])
          .map(([number]) => `<Part><PartNumber>${number}</PartNumber><LastModified>2026-10-08T00:00:00.000Z</LastModified><ETag>"etag-${number}"</ETag></Part>`)
          .join('');
        return send(response, 200, `<?xml version="1.0" encoding="UTF-8"?><ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${xmlEscape(uploadId)}</UploadId>${parts}</ListPartsResult>`, { 'Content-Type': 'application/xml' });
      }
      // CompleteMultipartUpload
      if (request.method === 'POST' && uploadId) {
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) return send(response, 404, 'NoSuchUpload', { 'Content-Type': 'application/xml' });
        await readBody();
        const sorted = [...upload.parts.entries()].sort((left, right) => left[0] - right[0]);
        const bytes = new Uint8Array(sorted.reduce((sum, [, part]) => sum + part.length, 0));
        let offset = 0;
        for (const [, part] of sorted) { bytes.set(part, offset); offset += part.length; }
        objects.set(key, { bytes, contentType: upload.contentType });
        uploads.delete(uploadId);
        return send(response, 200, `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${xmlEscape(bucket)}</Bucket><Key>${xmlEscape(key)}</Key><ETag>"etag-complete"</ETag></CompleteMultipartUploadResult>`, { 'Content-Type': 'application/xml' });
      }
      // AbortMultipartUpload / DeleteObject
      if (request.method === 'DELETE' && uploadId) { uploads.delete(uploadId); return send(response, 204, ''); }
      if (request.method === 'DELETE') { objects.delete(key); return send(response, 204, ''); }
      // HeadObject
      if (request.method === 'HEAD') {
        const object = objects.get(key);
        if (!object) return send(response, 404, '');
        return send(response, 200, '', { 'Content-Type': object.contentType, 'Content-Length': String(object.bytes.length), ETag: '"etag-head"' });
      }
      // GetObject (with optional Range)
      if (request.method === 'GET') {
        const object = objects.get(key);
        if (!object) return send(response, 404, 'NoSuchKey', { 'Content-Type': 'application/xml' });
        const range = request.headers.range;
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (match) {
            const start = Number(match[1]);
            const end = match[2] ? Math.min(Number(match[2]), object.bytes.length - 1) : object.bytes.length - 1;
            const slice = object.bytes.slice(start, end + 1);
            return send(response, 206, slice, {
              'Content-Type': object.contentType,
              'Content-Length': String(slice.length),
              'Content-Range': `bytes ${start}-${end}/${object.bytes.length}`,
              'Accept-Ranges': 'bytes',
            });
          }
        }
        return send(response, 200, object.bytes, { 'Content-Type': object.contentType, 'Content-Length': String(object.bytes.length), 'Accept-Ranges': 'bytes' });
      }
      return send(response, 400, 'BadRequest', { 'Content-Type': 'application/xml' });
    } catch (error) {
      return send(response, 500, String(error), { 'Content-Type': 'application/xml' });
    }
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ server, endpoint: `http://127.0.0.1:${address.port}`, objects, uploads });
    });
  });
}
