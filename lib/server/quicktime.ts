import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { parseQuickTimeCodecInfo } from '@/lib/shared/quicktime';
import { storageRequestOptions } from '@/lib/server/storage';

const MAX_METADATA_ATOM_BYTES = 32 * 1024 * 1024;
const MAX_TOP_LEVEL_ATOMS = 4096;

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

async function readObjectRange(client: S3Client, bucket: string, key: string, start: number, end: number) {
  const expectedLength = end - start + 1;
  const response = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    Range: `bytes=${start}-${end}`,
  }), storageRequestOptions());
  if (!response.Body) return null;
  const bytes = await response.Body.transformToByteArray();
  return bytes.byteLength === expectedLength ? new Uint8Array(bytes) : null;
}

/**
 * Inspect only the stored QuickTime `ftyp` and `moov` atoms using bounded HTTP Range reads.
 * The client-side claim is advisory; the completed object is parsed again before DB acceptance.
 */
export async function inspectQuickTimeObject(client: S3Client, bucket: string, key: string, fileSize: number) {
  if (!Number.isSafeInteger(fileSize) || fileSize < 8) return null;
  let offset = 0;
  let foundFtyp = false;
  for (let count = 0; count < MAX_TOP_LEVEL_ATOMS && offset + 8 <= fileSize; count += 1) {
    const header = await readObjectRange(client, bucket, key, offset, Math.min(offset + 15, fileSize - 1));
    if (!header || header.byteLength < 8) return null;
    const type = fourcc(header, 4);
    let atomSize = uint32(header, 0);
    let headerSize = 8;
    if (atomSize === 1) {
      if (header.byteLength < 16) return null;
      atomSize = uint32(header, 8) * 0x100000000 + uint32(header, 12);
      headerSize = 16;
    } else if (atomSize === 0) {
      atomSize = fileSize - offset;
    }
    if (!Number.isSafeInteger(atomSize) || atomSize < headerSize || offset + atomSize > fileSize) return null;
    if (offset === 0 && type !== 'ftyp') return null;
    if (type === 'ftyp') foundFtyp = true;
    if (type === 'moov') {
      if (!foundFtyp || atomSize > MAX_METADATA_ATOM_BYTES) return null;
      const bytes = await readObjectRange(client, bucket, key, offset, offset + atomSize - 1);
      return bytes ? parseQuickTimeCodecInfo(bytes) : null;
    }
    if (atomSize <= 0 || offset + atomSize <= offset) return null;
    offset += atomSize;
  }
  return null;
}

