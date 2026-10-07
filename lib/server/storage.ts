import { S3Client } from '@aws-sdk/client-s3';
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing server configuration: ${name}`);
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

export function getS3Client() {
  if (!singleton) {
    singleton = new S3Client({
      endpoint: env('SUPABASE_S3_ENDPOINT'),
      region: process.env.SUPABASE_S3_REGION || 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: env('SUPABASE_S3_ACCESS_KEY_ID'),
        secretAccessKey: env('SUPABASE_S3_SECRET_ACCESS_KEY'),
      },
    });
  }
  return singleton;
}
