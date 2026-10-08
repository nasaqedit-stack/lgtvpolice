export type QuickTimeCodecInfo = {
  hasVideoTrack: boolean;
  videoCodecs: string[];
  hasAudioTrack: boolean;
  audioCodecs: string[];
};

type Atom = { type: string; start: number; payloadStart: number; end: number };
type Descriptor = { tag: number; payloadStart: number; end: number };

function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function uint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, false);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function readAtom(bytes: Uint8Array, offset: number, parentEnd: number): Atom | null {
  if (offset < 0 || offset + 8 > parentEnd || offset + 8 > bytes.length) return null;
  let size = uint32(bytes, offset);
  const type = fourcc(bytes, offset + 4);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > parentEnd || offset + 16 > bytes.length) return null;
    const high = uint32(bytes, offset + 8);
    const low = uint32(bytes, offset + 12);
    size = high * 0x100000000 + low;
    headerSize = 16;
  } else if (size === 0) {
    size = parentEnd - offset;
  }
  if (!Number.isSafeInteger(size) || size < headerSize || offset + size > parentEnd) return null;
  return { type, start: offset, payloadStart: offset + headerSize, end: offset + size };
}

function childAtoms(bytes: Uint8Array, parent: Atom): Atom[] | null {
  const atoms: Atom[] = [];
  let offset = parent.payloadStart;
  while (offset + 8 <= parent.end) {
    const atom = readAtom(bytes, offset, parent.end);
    if (!atom) return null;
    atoms.push(atom);
    offset = atom.end;
  }
  return offset === parent.end ? atoms : null;
}

function childOf(bytes: Uint8Array, parent: Atom, type: string): Atom | null {
  const children = childAtoms(bytes, parent);
  if (!children) return null;
  for (const child of children) if (child.type === type) return child;
  return null;
}

function sampleDescriptions(bytes: Uint8Array, stsd: Atom): Atom[] | null {
  // SampleDescriptionBox is a FullBox (version/flags) followed by entry_count and sample entries.
  if (stsd.payloadStart + 8 > stsd.end) return null;
  const count = uint32(bytes, stsd.payloadStart + 4);
  if (count > 64) return null;
  const entries: Atom[] = [];
  let offset = stsd.payloadStart + 8;
  for (let index = 0; index < count; index += 1) {
    const entry = readAtom(bytes, offset, stsd.end);
    if (!entry) return null;
    entries.push(entry);
    offset = entry.end;
  }
  return offset === stsd.end ? entries : null;
}

function readDescriptor(bytes: Uint8Array, offset: number, parentEnd: number): Descriptor | null {
  if (offset < 0 || offset + 2 > parentEnd) return null;
  const tag = bytes[offset];
  let cursor = offset + 1;
  let length = 0;
  let complete = false;
  for (let count = 0; count < 4 && cursor < parentEnd; count += 1) {
    const byte = bytes[cursor++];
    length = length * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) { complete = true; break; }
  }
  if (!complete || !Number.isSafeInteger(length) || cursor + length > parentEnd) return null;
  return { tag, payloadStart: cursor, end: cursor + length };
}

function parseAacLcDecoderConfig(bytes: Uint8Array, decoderConfig: Descriptor): boolean {
  const start = decoderConfig.payloadStart;
  // DecoderConfigDescriptor has objectTypeIndication, streamType, buffer size and bitrates.
  if (start + 13 > decoderConfig.end || bytes[start] !== 0x40) return false;
  let offset = start + 13;
  while (offset < decoderConfig.end) {
    const descriptor = readDescriptor(bytes, offset, decoderConfig.end);
    if (!descriptor) return false;
    if (descriptor.tag === 0x05) {
      // AAC-LC AudioSpecificConfig starts with audioObjectType 2 in the five most significant bits.
      return descriptor.payloadStart < descriptor.end && (bytes[descriptor.payloadStart] >> 3) === 2;
    }
    offset = descriptor.end;
  }
  return false;
}

function parseAacLcEsds(bytes: Uint8Array, esds: Atom): boolean {
  if (esds.payloadStart + 4 > esds.end) return false;
  const es = readDescriptor(bytes, esds.payloadStart + 4, esds.end);
  if (!es || es.tag !== 0x03 || es.payloadStart + 3 > es.end) return false;
  const flags = bytes[es.payloadStart + 2];
  let offset = es.payloadStart + 3;
  if (flags & 0x80) offset += 2;
  if (flags & 0x40) {
    if (offset >= es.end) return false;
    offset += 1 + bytes[offset];
  }
  if (flags & 0x20) offset += 2;
  if (offset > es.end) return false;
  while (offset < es.end) {
    const descriptor = readDescriptor(bytes, offset, es.end);
    if (!descriptor) return false;
    if (descriptor.tag === 0x04) return parseAacLcDecoderConfig(bytes, descriptor);
    offset = descriptor.end;
  }
  return false;
}

function findEsds(bytes: Uint8Array, start: number, end: number, depth = 0): Atom | null {
  if (depth > 4) return null;
  let offset = start;
  while (offset + 8 <= end) {
    const atom = readAtom(bytes, offset, end);
    if (!atom) return null;
    if (atom.type === 'esds') return atom;
    if (atom.type === 'wave') {
      const nested = findEsds(bytes, atom.payloadStart, atom.end, depth + 1);
      if (nested) return nested;
    }
    offset = atom.end;
  }
  return null;
}

function isAacLcSampleEntry(bytes: Uint8Array, entry: Atom): boolean {
  // AudioSampleEntry version 0/1/2 have 28/44/64 bytes before their child atoms.
  if (entry.payloadStart + 10 > entry.end) return false;
  const version = uint16(bytes, entry.payloadStart + 8);
  const fixedLength = version === 0 ? 28 : version === 1 ? 44 : version === 2 ? 64 : 0;
  if (!fixedLength || entry.payloadStart + fixedLength > entry.end) return false;
  const esds = findEsds(bytes, entry.payloadStart + fixedLength, entry.end);
  return Boolean(esds && parseAacLcEsds(bytes, esds));
}

/**
 * Parse codec sample entries from a QuickTime/ISO-BMFF `moov` atom. AAC audio is accepted only
 * when the `mp4a` entry's ES descriptor identifies MPEG-4 Audio with AAC-LC configuration.
 */
export function parseQuickTimeCodecInfo(moovBytes: Uint8Array): QuickTimeCodecInfo | null {
  const topLevel: Atom[] = [];
  let offset = 0;
  while (offset + 8 <= moovBytes.length) {
    const atom = readAtom(moovBytes, offset, moovBytes.length);
    if (!atom) return null;
    topLevel.push(atom);
    offset = atom.end;
  }
  const moov = topLevel.find(atom => atom.type === 'moov');
  if (!moov) return null;
  const tracks = childAtoms(moovBytes, moov);
  if (!tracks) return null;

  const videoCodecs: string[] = [];
  const audioCodecs: string[] = [];
  let hasVideoTrack = false;
  let hasAudioTrack = false;
  for (const track of tracks.filter(atom => atom.type === 'trak')) {
    const mdia = childOf(moovBytes, track, 'mdia');
    if (!mdia) continue;
    const hdlr = childOf(moovBytes, mdia, 'hdlr');
    if (!hdlr || hdlr.payloadStart + 12 > hdlr.end) continue;
    const handler = fourcc(moovBytes, hdlr.payloadStart + 8);
    if (handler !== 'vide' && handler !== 'soun') continue;
    const minf = childOf(moovBytes, mdia, 'minf');
    const stbl = minf ? childOf(moovBytes, minf, 'stbl') : null;
    const stsd = stbl ? childOf(moovBytes, stbl, 'stsd') : null;
    const descriptions = stsd ? sampleDescriptions(moovBytes, stsd) : null;
    if (handler === 'vide') {
      hasVideoTrack = true;
      if (!descriptions || descriptions.length === 0) videoCodecs.push('unknown');
      else videoCodecs.push(...descriptions.map(entry => entry.type));
    } else {
      // An unreadable audio track is still an audio track: never silently treat it as silent.
      hasAudioTrack = true;
      if (!descriptions || descriptions.length === 0) audioCodecs.push('unknown');
      else audioCodecs.push(...descriptions.map(entry => entry.type === 'mp4a' && isAacLcSampleEntry(moovBytes, entry) ? 'mp4a.40.2' : entry.type));
    }
  }
  return { hasVideoTrack, videoCodecs, hasAudioTrack, audioCodecs };
}

/** Confirm the legacy TV-safe video/audio sample-entry families used for MOV ingestion. */
export function isQuickTimeMovCompatible(info: QuickTimeCodecInfo | null): boolean {
  if (!info || !info.hasVideoTrack || info.videoCodecs.length === 0) return false;
  if (!info.videoCodecs.every(codec => codec === 'avc1' || codec === 'avc3')) return false;
  if (info.hasAudioTrack) {
    if (info.audioCodecs.length === 0 || !info.audioCodecs.every(codec => codec === 'mp4a.40.2')) return false;
  }
  return true;
}
