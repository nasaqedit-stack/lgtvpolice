import { parseQuickTimeCodecInfo } from '@/lib/shared/quicktime';

export { isQuickTimeMovCompatible, parseQuickTimeCodecInfo } from '@/lib/shared/quicktime';
export type { QuickTimeCodecInfo } from '@/lib/shared/quicktime';

const MAX_METADATA_ATOM_BYTES = 32 * 1024 * 1024;
const MAX_TOP_LEVEL_ATOMS = 4096;

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

/**
 * Read MOV metadata without loading the media payload. The browser probes the actual file after
 * the structural codec check; the API repeats the check against the stored object before accept.
 */
export async function inspectQuickTimeFile(file: Blob) {
  try {
    let offset = 0;
    let foundFtyp = false;
    for (let count = 0; count < MAX_TOP_LEVEL_ATOMS && offset + 8 <= file.size; count += 1) {
      const header = new Uint8Array(await file.slice(offset, Math.min(offset + 16, file.size)).arrayBuffer());
      if (header.length < 8) return null;
      const type = fourcc(header, 4);
      let atomSize = uint32(header, 0);
      let headerSize = 8;
      if (atomSize === 1) {
        if (header.length < 16) return null;
        atomSize = uint32(header, 8) * 0x100000000 + uint32(header, 12);
        headerSize = 16;
      } else if (atomSize === 0) {
        atomSize = file.size - offset;
      }
      if (!Number.isSafeInteger(atomSize) || atomSize < headerSize || offset + atomSize > file.size) return null;
      if (offset === 0 && type !== 'ftyp') return null;
      if (type === 'ftyp') foundFtyp = true;
      if (type === 'moov') {
        if (!foundFtyp || atomSize > MAX_METADATA_ATOM_BYTES) return null;
        const bytes = new Uint8Array(await file.slice(offset, offset + atomSize).arrayBuffer());
        return parseQuickTimeCodecInfo(bytes);
      }
      if (atomSize <= 0 || offset + atomSize <= offset) return null;
      offset += atomSize;
    }
  } catch {
    return null;
  }
  return null;
}

