// Offline check of the server's S3 presigning shape (no network: presigning is local).
// Mirrors lib/server/storage.ts so the query parameters Supabase Storage receives can be inspected.
import { S3Client, GetObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

async function inspect(label, options) {
  const client = new S3Client({
    endpoint: 'https://abcdefghijklmnop.supabase.co/storage/v1/s3',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'KEYID123', secretAccessKey: 'SECRET456' },
    ...options,
  });
  const get = await getSignedUrl(client, new GetObjectCommand({ Bucket: 'signage-media', Key: 'media/8a1b', ResponseCacheControl: 'private, max-age=3600' }), { expiresIn: 3600 });
  const put = await getSignedUrl(client, new UploadPartCommand({ Bucket: 'signage-media', Key: 'media/8a1b', UploadId: 'up-1', PartNumber: 1 }), { expiresIn: 900 });
  const params = (url) => new URL(url).searchParams;
  console.log(`\n== ${label}`);
  console.log('GET  host+path:', new URL(get).host + new URL(get).pathname);
  console.log('GET  extra params:', [...params(get).keys()].filter(key => /^(x-amz-checksum|x-amz-sdk-checksum|response-|x-id)/i.test(key)).join(', ') || '(none)');
  console.log('PUT  extra params:', [...params(put).keys()].filter(key => /^(x-amz-checksum|x-amz-sdk-checksum|response-|x-id)/i.test(key)).join(', ') || '(none)');
  if (params(put).get('x-amz-checksum-crc32')) console.log('PUT  signed checksum value:', params(put).get('x-amz-checksum-crc32'), '(CRC32 of an empty body)');
}

await inspect('AWS SDK defaults', {});
await inspect('lib/server/storage.ts (WHEN_REQUIRED)', { requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
