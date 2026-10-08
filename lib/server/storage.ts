import { S3Client } from '@aws-sdk/client-s3';
import { ConfigError } from '@/lib/server/config-error';
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError(name);
  return value;
}

let singleton: S3Client | undefined;
export function storageConfig() {
  return {
    bucket: process.env.SIGNAGE_STORAGE_BUCKET || 'signage-media',
    endpoint: env('SUPABASE_S3_ENDPOINT'),
    region: process.env.SUPABASE_S3_REGION || 'us-east-1',
  };
}

export const STORAGE_REQUEST_TIMEOUT_MS = 15_000;

export function storageRequestOptions(timeoutMs = STORAGE_REQUEST_TIMEOUT_MS) {
  return { abortSignal: AbortSignal.timeout(timeoutMs) };
}

export function getS3Client() {
  if (!singleton) {
    singleton = new S3Client({
      endpoint: env('SUPABASE_S3_ENDPOINT'),
      region: process.env.SUPABASE_S3_REGION || 'us-east-1',
      forcePathStyle: true,
      // AWS SDK v3 (>= 3.729) computes flexible checksums by default. A presigned request has no
      // body at signing time, so the SDK signs the CRC32 of an EMPTY body
      // (`x-amz-checksum-crc32=AAAAAA==`, `x-amz-sdk-checksum-algorithm=CRC32`) into every part
      // upload URL and stamps `x-amz-checksum-mode=ENABLED` into every download URL. Supabase
      // Storage's S3 compatibility table lists checksum parameters as unsupported, and stores that
      // do validate them reject the request (BadDigest / InvalidRequest / NotImplemented). The
      // application already enforces integrity itself: `media.sha256` is computed on upload,
      // verified again on `complete`, and re-verified in the player after the download.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: env('SUPABASE_S3_ACCESS_KEY_ID'),
        secretAccessKey: env('SUPABASE_S3_SECRET_ACCESS_KEY'),
      },
    });
  }
  return singleton;
}
