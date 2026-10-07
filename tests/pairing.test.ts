import { describe, expect, it } from 'vitest';
import {
  hashHex, makePairingCode, normalizedPairingCode, pairRequestSchema,
} from '../lib/server/pairing';

// The exact JSON body components/player.tsx sends to POST /api/player/pair.
const playerPairPayload = {
  code: 'ABCD2345',
  deviceInfo: {
    userAgent: 'Mozilla/5.0 (Web0S; Linux) AppleWebKit/537.36 Chrome/133.0.0.0 Safari/537.36',
    platform: 'Web0S',
    screenWidth: 1920,
    screenHeight: 1080,
    language: 'ar-SA',
  },
};

describe('pairing request validation', () => {
  it('accepts the exact payload the player client sends (regression: language field)', () => {
    const result = pairRequestSchema.safeParse(playerPairPayload);
    expect(result.success).toBe(true);
  });

  it('still accepts the payload without optional device metadata', () => {
    expect(pairRequestSchema.safeParse({ code: 'ABCD2345' }).success).toBe(true);
    expect(pairRequestSchema.safeParse({ code: 'ABCD2345', deviceInfo: {} }).success).toBe(true);
  });

  it('strips unknown device metadata instead of rejecting the pairing request', () => {
    const parsed = pairRequestSchema.parse({
      ...playerPairPayload,
      deviceInfo: { ...playerPairPayload.deviceInfo, futureField: 'ignored' },
    });
    expect(parsed.deviceInfo).toEqual(playerPairPayload.deviceInfo);
    expect(parsed.deviceInfo).not.toHaveProperty('futureField');
  });

  it('keeps the request body strict and validates the code shape', () => {
    expect(pairRequestSchema.safeParse({ ...playerPairPayload, extra: true }).success).toBe(false);
    expect(pairRequestSchema.safeParse({ code: 'abc', deviceInfo: playerPairPayload.deviceInfo }).success).toBe(false);
    expect(pairRequestSchema.safeParse({ code: 'TOO-LONG-CODE-VALUE', deviceInfo: playerPairPayload.deviceInfo }).success).toBe(false);
    expect(pairRequestSchema.safeParse({ deviceInfo: playerPairPayload.deviceInfo }).success).toBe(false);
  });
});

describe('pairing code generation and validation round-trip', () => {
  it('hashes the displayed code exactly the way validation hashes the entered code', () => {
    const { raw, display, hash } = makePairingCode();
    expect(display).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(raw).toHaveLength(8);

    // The TV user may type the display form, lowercase, or with spaces.
    for (const entered of [raw, display, display.toLowerCase(), ` ${display.toLowerCase()} `]) {
      const normalized = normalizedPairingCode(entered);
      expect(normalized).toBe(raw);
      expect(hashHex(normalized)).toBe(hash);
    }
  });

  it('normalizes what the user types into the exact stored form', () => {
    expect(normalizedPairingCode('abc d-efgh')).toBe('ABCDEFGH');
    expect(normalizedPairingCode('ABCDEFG')).toHaveLength(7); // route rejects anything != 8 after normalization
    expect(normalizedPairingCode('ABC-EFG')).toBe('ABCEFG');
    expect(normalizedPairingCode('')).toHaveLength(0);
    expect(normalizedPairingCode('!!!!')).toHaveLength(0);
  });
});
