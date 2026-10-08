import { describe, expect, it } from 'vitest';
import { inspectQuickTimeFile, isQuickTimeMovCompatible, parseQuickTimeCodecInfo } from '../lib/client/quicktime';

const ascii = (value: string) => new Uint8Array([...value].map(character => character.charCodeAt(0)));
const join = (...parts: Uint8Array[]) => {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
};
function atom(type: string, payload: Uint8Array = new Uint8Array()) {
  const result = new Uint8Array(8 + payload.length);
  new DataView(result.buffer).setUint32(0, result.length, false);
  result.set(ascii(type), 4);
  result.set(payload, 8);
  return result;
}
function descriptor(tag: number, payload: Uint8Array) {
  if (payload.length >= 128) throw new Error('test descriptor too large');
  return join(new Uint8Array([tag, payload.length]), payload);
}
function aacSampleEntry(audioObjectType = 2) {
  const decoderConfig = new Uint8Array(13);
  decoderConfig[0] = 0x40; // MPEG-4 Audio
  decoderConfig[1] = 0x15; // Audio stream type
  const audioSpecificConfig = new Uint8Array([audioObjectType === 2 ? 0x12 : 0x2a, 0x10]);
  const decoderConfigDescriptor = descriptor(0x04, join(decoderConfig, descriptor(0x05, audioSpecificConfig)));
  const esDescriptor = descriptor(0x03, join(new Uint8Array([0, 1, 0]), decoderConfigDescriptor, descriptor(0x06, new Uint8Array([2]))));
  const esds = atom('esds', join(new Uint8Array(4), esDescriptor));
  return atom('mp4a', join(new Uint8Array(28), esds));
}
function sampleDescription(codec: string, includeAacConfig = true, audioObjectType = 2) {
  const entryCount = new Uint8Array(4);
  new DataView(entryCount.buffer).setUint32(0, 1, false);
  const entry = codec === 'mp4a' && includeAacConfig ? aacSampleEntry(audioObjectType) : atom(codec, codec === 'mp4a' ? new Uint8Array(28) : new Uint8Array());
  return atom('stsd', join(new Uint8Array(4), entryCount, entry));
}
function track(kind: 'vide' | 'soun', codec: string, includeAacConfig = true, audioObjectType = 2) {
  const handlerPayload = join(new Uint8Array(8), ascii(kind), new Uint8Array(12));
  const mediaInformation = atom('minf', atom('stbl', sampleDescription(codec, includeAacConfig, audioObjectType)));
  return atom('trak', atom('mdia', join(atom('hdlr', handlerPayload), mediaInformation)));
}
function trackWithoutSampleDescription(kind: 'vide' | 'soun') {
  const handlerPayload = join(new Uint8Array(8), ascii(kind), new Uint8Array(12));
  return atom('trak', atom('mdia', join(atom('hdlr', handlerPayload), atom('minf', atom('stbl')))));
}
function movie(videoCodec = 'avc1', audioCodec: string | null = 'mp4a', includeAacConfig = true, audioObjectType = 2) {
  return atom('moov', join(atom('trak', atom('mdia', join(
    atom('hdlr', join(new Uint8Array(8), ascii('vide'), new Uint8Array(12))),
    atom('minf', atom('stbl', sampleDescription(videoCodec)))
  ))), audioCodec ? track('soun', audioCodec, includeAacConfig, audioObjectType) : new Uint8Array()));
}

function compatibleMetadata() {
  return parseQuickTimeCodecInfo(movie());
}

describe('QuickTime MOV codec compatibility', () => {
  it('accepts a parsed H.264 video track with an AAC audio track', () => {
    const info = compatibleMetadata();
    expect(info).toEqual({ hasVideoTrack: true, videoCodecs: ['avc1'], hasAudioTrack: true, audioCodecs: ['mp4a.40.2'] });
    expect(isQuickTimeMovCompatible(info)).toBe(true);
  });

  it('accepts a supported silent H.264 MOV but does not assume an audio track', () => {
    const info = parseQuickTimeCodecInfo(movie('avc3', null));
    expect(info?.hasAudioTrack).toBe(false);
    expect(isQuickTimeMovCompatible(info)).toBe(true);
  });

  it.each(['apch', 'hvc1', 'vp09'])('rejects a video codec the legacy target was not verified for (%s)', codec => {
    expect(isQuickTimeMovCompatible(parseQuickTimeCodecInfo(movie(codec, 'mp4a')))).toBe(false);
  });

  it('rejects a MOV with a non-AAC audio track', () => {
    expect(isQuickTimeMovCompatible(parseQuickTimeCodecInfo(movie('avc1', 'sowt')))).toBe(false);
  });

  it('requires an AAC-LC decoder configuration instead of trusting the mp4a sample-entry label', () => {
    expect(isQuickTimeMovCompatible(parseQuickTimeCodecInfo(movie('avc1', 'mp4a', false)))).toBe(false);
    expect(isQuickTimeMovCompatible(parseQuickTimeCodecInfo(movie('avc1', 'mp4a', true, 5)))).toBe(false);
    expect(isQuickTimeMovCompatible(parseQuickTimeCodecInfo(movie('avc1', 'mp4a', true)))).toBe(true);
  });

  it('does not silently treat an unreadable audio track as a silent movie', () => {
    const bytes = atom('moov', join(track('vide', 'avc1'), trackWithoutSampleDescription('soun')));
    const info = parseQuickTimeCodecInfo(bytes);
    expect(info?.hasAudioTrack).toBe(true);
    expect(isQuickTimeMovCompatible(info)).toBe(false);
  });

  it('reads only the ftyp/moov metadata and skips a large media-data atom', async () => {
    const ftyp = atom('ftyp', join(ascii('qt  '), new Uint8Array(4)));
    const mdat = atom('mdat', new Uint8Array(1024));
    const file = new Blob([ftyp, mdat, movie()]);
    const info = await inspectQuickTimeFile(file);
    expect(isQuickTimeMovCompatible(info)).toBe(true);
  });

  it('rejects a file without the expected QuickTime/ISO-BMFF structure', async () => {
    expect(await inspectQuickTimeFile(new Blob([ascii('not a movie')]))).toBeNull();
    expect(parseQuickTimeCodecInfo(atom('moov', new Uint8Array([0, 0, 0])))).toBeNull();
  });
});
