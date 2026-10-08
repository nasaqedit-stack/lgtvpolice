import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPartManifest, slicePart, uploadParts } from '@/lib/client/media-upload';
import { HttpError } from '@/lib/server/http';
import { resumePartSize, verifyUploadParts, type ListedUploadPart } from '@/lib/server/uploads';
import { UPLOAD_PART_SIZE, uploadPartCount, uploadPartRange, uploadPartRanges } from '@/lib/shared';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Concatenate byte chunks without spreading them (a spread blows the stack at MiB scale). */
function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return joined;
}

/** Assert byte equality through a digest: precise, and fast at multi-MiB scale. */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array) {
  expect(actual.length).toBe(expected.length);
  expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'));
}

/** Deterministic pseudo-random bytes so a wrong slice is caught byte for byte. */
function testBytes(length: number, seed = 1): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

/** A minimal valid PNG header followed by filler, so the fixture is a real image container. */
function pngFixture(length: number) {
  const bytes = testBytes(length, 7);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return new File([bytes], `photo-${length}.png`, { type: 'image/png' });
}

/** A minimal `ftyp` box followed by filler: a real MP4 container shape. */
function mp4Fixture(length: number) {
  const bytes = testBytes(length, 11);
  bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32], 0);
  return new File([bytes], `clip-${length}.mp4`, { type: 'video/mp4' });
}

/**
 * What Supabase Storage's S3 `ListParts` really answers.
 *
 * `src/storage/protocols/s3/s3-handler.ts#listParts` builds every entry as
 * `{ PartNumber, LastModified, ETag }` and never serialises `<Size>`; its
 * `insertUploadPart` also never writes `s3_multipart_uploads_parts.size`, so the column
 * keeps its `DEFAULT 0`. Through the AWS SDK that arrives as `Size === undefined`.
 */
function supabaseListParts(partNumbers: number[]): ListedUploadPart[] {
  return partNumbers.map(partNumber => ({
    PartNumber: partNumber,
    ETag: `"etag-${partNumber}"`,
    LastModified: new Date('2026-10-08T00:00:00.000Z'),
  }));
}

/** The finalization check exactly as it shipped before this fix. */
function legacyPartSizeCheck(fileSize: number, listed: ListedUploadPart[]) {
  const partSize = 8 * 1024 * 1024;
  for (let index = 0; index < listed.length; index += 1) {
    const expected = Math.min(partSize, fileSize - index * partSize);
    const actual = Number(listed[index].Size);
    if (actual !== expected) return { partNumber: index + 1, expected, actual };
  }
  return null;
}

describe('multipart partition maths (single source of truth)', () => {
  const cases = [
    { name: 'smaller than one chunk (2 KiB PNG)', size: 2048, expected: [2048] },
    { name: 'one byte under a chunk', size: UPLOAD_PART_SIZE - 1, expected: [UPLOAD_PART_SIZE - 1] },
    { name: 'exactly one chunk', size: UPLOAD_PART_SIZE, expected: [UPLOAD_PART_SIZE] },
    { name: 'one byte over a chunk', size: UPLOAD_PART_SIZE + 1, expected: [UPLOAD_PART_SIZE, 1] },
    { name: 'exactly two chunks', size: UPLOAD_PART_SIZE * 2, expected: [UPLOAD_PART_SIZE, UPLOAD_PART_SIZE] },
    { name: 'smaller final chunk', size: 20_000_000, expected: [UPLOAD_PART_SIZE, UPLOAD_PART_SIZE, 20_000_000 - UPLOAD_PART_SIZE * 2] },
    { name: 'MP4 spanning three chunks', size: UPLOAD_PART_SIZE * 2 + 1234, expected: [UPLOAD_PART_SIZE, UPLOAD_PART_SIZE, 1234] },
    { name: 'largest accepted file (2 GiB)', size: 2 * 1024 * 1024 * 1024, expected: Array.from({ length: 256 }, () => UPLOAD_PART_SIZE) },
  ];

  for (const testCase of cases) {
    it(`partitions ${testCase.name}: ${testCase.size} bytes`, () => {
      const ranges = uploadPartRanges(testCase.size);
      expect(ranges.map(range => range.size)).toEqual(testCase.expected);
      expect(uploadPartCount(testCase.size)).toBe(testCase.expected.length);
      // Contiguous, exclusive-end, no gaps, no overlap, no byte past the end of the file.
      expect(ranges[0]?.start).toBe(0);
      expect(ranges.at(-1)?.end).toBe(testCase.size);
      for (const [index, range] of ranges.entries()) {
        expect(range.partNumber).toBe(index + 1);
        expect(range.end - range.start).toBe(range.size);
        expect(range.size).toBeGreaterThan(0);
        expect(range.size).toBeLessThanOrEqual(UPLOAD_PART_SIZE);
        if (index > 0) expect(range.start).toBe(ranges[index - 1]!.end);
      }
      expect(ranges.reduce((sum, range) => sum + range.size, 0)).toBe(testCase.size);
    });
  }

  it('rejects a part number outside the file', () => {
    expect(() => uploadPartRange(2048, 0)).toThrow(RangeError);
    expect(() => uploadPartRange(2048, 2)).toThrow(RangeError);
    expect(() => uploadPartRange(UPLOAD_PART_SIZE * 2, 3)).toThrow(RangeError);
  });
});

describe('client slicing: byte length is read off the Blob', () => {
  it('sends exactly the file bytes for a file smaller than one chunk', async () => {
    const file = pngFixture(2048);
    const blob = slicePart(file, 1);
    expect(blob.size).toBe(2048);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(await file.arrayBuffer()));
  });

  it('sends exactly the file bytes when the final part is short', async () => {
    const size = UPLOAD_PART_SIZE + 4096;
    const file = mp4Fixture(size);
    const original = new Uint8Array(await file.arrayBuffer());
    const chunks: Uint8Array[] = [];
    for (let partNumber = 1; partNumber <= uploadPartCount(size); partNumber += 1) {
      const blob = slicePart(file, partNumber);
      expect(blob.size).toBe(uploadPartRange(size, partNumber).size);
      chunks.push(new Uint8Array(await blob.arrayBuffer()));
    }
    expectSameBytes(concatBytes(chunks), original);
  });

  it('covers exactly two chunks with two equal parts', async () => {
    const file = pngFixture(UPLOAD_PART_SIZE * 2);
    expect(slicePart(file, 1).size).toBe(UPLOAD_PART_SIZE);
    expect(slicePart(file, 2).size).toBe(UPLOAD_PART_SIZE);
  });

  it('builds a manifest of every part from the Blob sizes', () => {
    const size = 20_000_000;
    const file = pngFixture(size);
    const uploaded = [1, 2, 3].map(partNumber => ({ partNumber, size: slicePart(file, partNumber).size }));
    const manifest = buildPartManifest(file.size, uploaded);
    expect(manifest).toEqual([
      { partNumber: 1, size: UPLOAD_PART_SIZE },
      { partNumber: 2, size: UPLOAD_PART_SIZE },
      { partNumber: 3, size: 20_000_000 - UPLOAD_PART_SIZE * 2 },
    ]);
    expect(manifest.reduce((sum, part) => sum + part.size, 0)).toBe(size);
  });

  it('fills resumed parts from the shared partition when the browser did not re-read them', () => {
    const size = UPLOAD_PART_SIZE + 5;
    const manifest = buildPartManifest(size, [{ partNumber: 2, size: 5 }]);
    expect(manifest).toEqual([{ partNumber: 1, size: UPLOAD_PART_SIZE }, { partNumber: 2, size: 5 }]);
  });
});

describe('regression: "حجم أحد أجزاء الرفع غير صحيح" on a real Supabase ListParts answer', () => {
  it('the old check failed part 1 of a 2 KiB image because ListParts carries no Size', () => {
    const fileSize = 2048;
    const listed = supabaseListParts([1]);
    const failure = legacyPartSizeCheck(fileSize, listed);
    // This is the exact production symptom: expected 2048, "actual" NaN, part number 1.
    expect(failure).toEqual({ partNumber: 1, expected: 2048, actual: Number.NaN });
    expect(Number(listed[0]?.Size)).toBeNaN();
  });

  it('the old check failed part 1 for every file size, including multi-chunk MP4s', () => {
    for (const fileSize of [1, 2048, UPLOAD_PART_SIZE, UPLOAD_PART_SIZE + 1, UPLOAD_PART_SIZE * 2, 20_000_000]) {
      const listed = supabaseListParts(Array.from({ length: uploadPartCount(fileSize) }, (_unused, index) => index + 1));
      expect(legacyPartSizeCheck(fileSize, listed)?.partNumber, `${fileSize} bytes`).toBe(1);
    }
  });

  it('finalization now accepts the same payload for a small image', () => {
    const fileSize = 2048;
    const parts = verifyUploadParts(fileSize, supabaseListParts([1]), [{ partNumber: 1, size: 2048 }]);
    expect(parts.map(part => part.PartNumber)).toEqual([1]);
  });

  it('finalization now accepts a multi-part MP4 with a short last part', () => {
    const fileSize = 20_000_000;
    const declared = buildPartManifest(fileSize, [
      { partNumber: 1, size: UPLOAD_PART_SIZE },
      { partNumber: 2, size: UPLOAD_PART_SIZE },
      { partNumber: 3, size: fileSize - UPLOAD_PART_SIZE * 2 },
    ]);
    expect(() => verifyUploadParts(fileSize, supabaseListParts([3, 1, 2]), declared)).not.toThrow();
  });

  it('finalization still accepts an older client that sends no manifest', () => {
    expect(() => verifyUploadParts(2048, supabaseListParts([1]), undefined)).not.toThrow();
  });
});

describe('part size validation is still enforced', () => {
  const fileSize = 20_000_000;
  const listed = supabaseListParts([1, 2, 3]);
  const good = buildPartManifest(fileSize, []);

  it('rejects a declared part that is one byte short', () => {
    const declared = good.map(part => (part.partNumber === 2 ? { ...part, size: part.size - 1 } : part));
    expect(() => verifyUploadParts(fileSize, listed, declared)).toThrowError(
      expect.objectContaining({ status: 409, code: 'upload_part_size_invalid' }),
    );
    try { verifyUploadParts(fileSize, listed, declared); } catch (error) {
      expect((error as HttpError).message).toContain('الجزء 2');
      expect((error as HttpError).message).toContain(String(UPLOAD_PART_SIZE));
      expect((error as HttpError).message).toContain(String(UPLOAD_PART_SIZE - 1));
    }
  });

  it('rejects a declared short final part that used the full chunk size', () => {
    const declared = good.map(part => (part.partNumber === 3 ? { ...part, size: UPLOAD_PART_SIZE } : part));
    expect(() => verifyUploadParts(fileSize, listed, declared)).toThrowError(
      expect.objectContaining({ code: 'upload_part_size_invalid' }),
    );
  });

  it('rejects a missing, duplicated or out-of-range part number', () => {
    expect(() => verifyUploadParts(fileSize, listed, good.slice(0, 2)))
      .toThrowError(expect.objectContaining({ code: 'upload_parts_manifest_invalid' }));
    expect(() => verifyUploadParts(fileSize, listed, [...good, { partNumber: 2, size: UPLOAD_PART_SIZE }]))
      .toThrowError(expect.objectContaining({ code: 'upload_parts_manifest_invalid' }));
    expect(() => verifyUploadParts(fileSize, listed, [...good.slice(0, 2), { partNumber: 4, size: 1 }]))
      .toThrowError(expect.objectContaining({ code: 'upload_parts_manifest_invalid' }));
  });

  it('rejects a manifest whose sizes do not add up to the file size', () => {
    const declared = [{ partNumber: 1, size: 10 }, { partNumber: 2, size: 10 }, { partNumber: 3, size: 10 }];
    expect(() => verifyUploadParts(fileSize, listed, declared)).toThrowError(
      expect.objectContaining({ status: 409, code: 'upload_part_size_invalid' }),
    );
  });

  it('rejects a store that does report a part size and it is wrong', () => {
    const listing: ListedUploadPart[] = [
      { PartNumber: 1, ETag: '"a"', Size: UPLOAD_PART_SIZE },
      { PartNumber: 2, ETag: '"b"', Size: 1234 },
      { PartNumber: 3, ETag: '"c"', Size: fileSize - UPLOAD_PART_SIZE * 2 },
    ];
    expect(() => verifyUploadParts(fileSize, listing, good)).toThrowError(
      expect.objectContaining({ code: 'upload_part_size_invalid' }),
    );
  });

  it('accepts a store that reports correct part sizes', () => {
    const listing: ListedUploadPart[] = uploadPartRanges(fileSize)
      .map(range => ({ PartNumber: range.partNumber, ETag: `"${range.partNumber}"`, Size: range.size }));
    expect(() => verifyUploadParts(fileSize, listing, good)).not.toThrow();
  });

  it('still reports an incomplete upload when a part never landed', () => {
    expect(() => verifyUploadParts(fileSize, supabaseListParts([1, 2]), good))
      .toThrowError(expect.objectContaining({ status: 409, code: 'upload_incomplete' }));
    expect(() => verifyUploadParts(fileSize, [{ PartNumber: 1 }, { PartNumber: 2 }, { PartNumber: 3 }], good))
      .toThrowError(expect.objectContaining({ code: 'upload_incomplete' }));
  });
});

describe('resumed session progress', () => {
  it('falls back to the partition size when the store reports no length', () => {
    const fileSize = 20_000_000;
    expect(resumePartSize(fileSize, 1, undefined)).toBe(UPLOAD_PART_SIZE);
    expect(resumePartSize(fileSize, 3, undefined)).toBe(fileSize - UPLOAD_PART_SIZE * 2);
    expect(resumePartSize(fileSize, 2, 4242)).toBe(4242);
    expect(resumePartSize(fileSize, 9, undefined)).toBe(0);
  });
});

describe('uploadParts: what really goes over the wire', () => {
  function jsonResponse(payload: unknown, status = 200) {
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  }

  /** Stubs fetch for both the presign API and the Storage PUTs, recording every body sent. */
  function stubUploads() {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const puts: Array<{ partNumber: number; bytes: Uint8Array }> = [];
    const tickets: number[][] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/')) {
        const body = JSON.parse(String(init?.body)) as { partNumbers: number[] };
        tickets.push(body.partNumbers);
        return jsonResponse({
          urls: Object.fromEntries(body.partNumbers.map(partNumber => [partNumber, `https://storage.test/part?n=${partNumber}`])),
          partSize: UPLOAD_PART_SIZE,
        });
      }
      const blob = init?.body as Blob;
      const partNumber = Number(new URL(url).searchParams.get('n'));
      puts.push({ partNumber, bytes: new Uint8Array(await blob.arrayBuffer()) });
      return jsonResponse({}, 200);
    }));
    return { puts, tickets };
  }

  it('PUTs every part of a multi-chunk MP4 with the exact bytes and reports their Blob sizes', async () => {
    const size = UPLOAD_PART_SIZE * 2 + 4321;
    const file = mp4Fixture(size);
    const original = new Uint8Array(await file.arrayBuffer());
    const { puts } = stubUploads();

    const progress: number[] = [];
    const uploaded = await uploadParts(file, 'upload-id', [1, 2, 3], bytes => progress.push(bytes));

    expect(uploaded).toEqual([
      { partNumber: 1, size: UPLOAD_PART_SIZE },
      { partNumber: 2, size: UPLOAD_PART_SIZE },
      { partNumber: 3, size: 4321 },
    ]);
    expect(progress.reduce((sum, bytes) => sum + bytes, 0)).toBe(size);
    // The bodies Storage received, reassembled in part order, are the file itself.
    const ordered = [...puts].sort((left, right) => left.partNumber - right.partNumber);
    expect(ordered.map(put => put.partNumber)).toEqual([1, 2, 3]);
    expectSameBytes(concatBytes(ordered.map(put => put.bytes)), original);
    // The manifest the client declares matches the bytes it actually sent, part by part.
    expect(buildPartManifest(file.size, uploaded)).toEqual(ordered.map(put => ({ partNumber: put.partNumber, size: put.bytes.length })));
  });

  it('PUTs a single part for an image smaller than one chunk', async () => {
    const file = pngFixture(2048);
    const { puts, tickets } = stubUploads();
    const uploaded = await uploadParts(file, 'upload-id', [1], () => undefined);
    expect(uploaded).toEqual([{ partNumber: 1, size: 2048 }]);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.bytes).toEqual(new Uint8Array(await file.arrayBuffer()));
    expect(tickets).toEqual([[1]]);
  });

  it('re-derives the offsets on a retry instead of reusing a stale range', async () => {
    const size = UPLOAD_PART_SIZE + 99;
    const file = pngFixture(size);
    const { puts } = stubUploads();
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    let failures = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('/api/') && failures < 1) {
        failures += 1;
        return jsonResponse({ error: 'TransientFailure' }, 500);
      }
      if (url.startsWith('/api/')) {
        const body = JSON.parse(String(init?.body)) as { partNumbers: number[] };
        return jsonResponse({ urls: Object.fromEntries(body.partNumbers.map(partNumber => [partNumber, `https://storage.test/part?n=${partNumber}`])) });
      }
      const blob = init?.body as Blob;
      puts.push({ partNumber: Number(new URL(url).searchParams.get('n')), bytes: new Uint8Array(await blob.arrayBuffer()) });
      return jsonResponse({}, 200);
    });

    const uploaded = await uploadParts(file, 'upload-id', [1, 2], () => undefined);
    expect(uploaded).toEqual([{ partNumber: 1, size: UPLOAD_PART_SIZE }, { partNumber: 2, size: 99 }]);
    const retried = puts.find(put => put.partNumber === 1);
    expect(retried?.bytes.length).toBe(UPLOAD_PART_SIZE);
    const ordered = [...puts].sort((left, right) => left.partNumber - right.partNumber);
    expectSameBytes(concatBytes(ordered.map(put => put.bytes)), new Uint8Array(await file.arrayBuffer()));
  });
});
