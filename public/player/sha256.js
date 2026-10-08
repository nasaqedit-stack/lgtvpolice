/*
 * Signage player SHA-256 — pure ES5, zero dependencies.
 *
 * Why this file exists:
 *   The TV player verifies every downloaded file against the SHA-256 hash published in the screen
 *   manifest. The previous implementation relied on `Blob.prototype.arrayBuffer()` (Chrome 76+)
 *   and/or `crypto.subtle.digest` (Chrome 37+, but frequently absent/partial on TV firmwares).
 *   LG webOS 3.5 (UJ634V) is Chromium 38, so neither can be assumed. This module is the
 *   always-available verifier: it is hand-written ES5 (validated by a test that parses it with
 *   acorn at ecmaVersion 5) and incremental, so multi-hundred-megabyte videos are hashed block by
 *   block without buffering the file in memory.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
  if (root) root.SignageSha256 = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  var HEX = '0123456789abcdef';

  function rotr(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
  }

  /** Normalizes Uint8Array | ArrayBuffer | number[] into a Uint8Array view without copying buffers. */
  function toBytes(input) {
    if (input === null || input === undefined) return new Uint8Array(0);
    if (typeof Uint8Array !== 'undefined' && input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (typeof input.length === 'number') return new Uint8Array(input);
    return new Uint8Array(0);
  }

  function bytesToHex(bytes) {
    var view = toBytes(bytes);
    var out = '';
    for (var i = 0; i < view.length; i += 1) {
      out += HEX.charAt((view[i] >>> 4) & 15) + HEX.charAt(view[i] & 15);
    }
    return out;
  }

  /** Incremental SHA-256. `update()` accepts byte arrays, `digestHex()` finalises once. */
  function Hasher() {
    this.h0 = 0x6a09e667; this.h1 = 0xbb67ae85; this.h2 = 0x3c6ef372; this.h3 = 0xa54ff53a;
    this.h4 = 0x510e527f; this.h5 = 0x9b05688c; this.h6 = 0x1f83d9ab; this.h7 = 0x5be0cd19;
    this.block = new Uint8Array(64);
    this.blockLength = 0;
    this.totalBytes = 0;
    this.w = new Array(64);
    this.finished = false;
  }

  Hasher.prototype._compress = function (bytes, offset) {
    var w = this.w;
    var i, t1, t2;
    for (i = 0; i < 16; i += 1) {
      var j = offset + i * 4;
      w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (i = 16; i < 64; i += 1) {
      var x = w[i - 15];
      var y = w[i - 2];
      var s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      var s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    var a = this.h0, b = this.h1, c = this.h2, d = this.h3;
    var e = this.h4, f = this.h5, g = this.h6, h = this.h7;
    for (i = 0; i < 64; i += 1) {
      var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      var ch = ((e & f) ^ (~e & g)) >>> 0;
      t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    this.h0 = (this.h0 + a) >>> 0; this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0; this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0; this.h5 = (this.h5 + f) >>> 0;
    this.h6 = (this.h6 + g) >>> 0; this.h7 = (this.h7 + h) >>> 0;
  };

  Hasher.prototype.update = function (input) {
    if (this.finished) throw new Error('sha256: update() after digest()');
    return this._update(input);
  };

  Hasher.prototype._update = function (input) {
    var bytes = toBytes(input);
    var length = bytes.length;
    if (length === 0) return this;
    this.totalBytes += length;
    var offset = 0;
    if (this.blockLength > 0) {
      // Top up the pending block first; this keeps the hot loop free of per-byte branches.
      while (this.blockLength < 64 && offset < length) {
        this.block[this.blockLength] = bytes[offset];
        this.blockLength += 1;
        offset += 1;
      }
      if (this.blockLength === 64) {
        this._compress(this.block, 0);
        this.blockLength = 0;
      }
    }
    while (offset + 64 <= length) {
      this._compress(bytes, offset);
      offset += 64;
    }
    while (offset < length) {
      this.block[this.blockLength] = bytes[offset];
      this.blockLength += 1;
      offset += 1;
    }
    return this;
  };

  /** Finalises the digest. The hasher must not be reused afterwards (a fresh one costs nothing). */
  Hasher.prototype.digestBytes = function () {
    if (this.finished) throw new Error('sha256: digest() called twice');
    var totalBytes = this.totalBytes;
    var bitLengthHigh = Math.floor(totalBytes / 0x20000000);
    var bitLengthLow = (totalBytes * 8) >>> 0;
    var padding = new Uint8Array(this.blockLength < 56 ? 64 - this.blockLength : 128 - this.blockLength);
    padding[0] = 0x80;
    var lengthOffset = padding.length - 8;
    padding[lengthOffset] = (bitLengthHigh >>> 24) & 255;
    padding[lengthOffset + 1] = (bitLengthHigh >>> 16) & 255;
    padding[lengthOffset + 2] = (bitLengthHigh >>> 8) & 255;
    padding[lengthOffset + 3] = bitLengthHigh & 255;
    padding[lengthOffset + 4] = (bitLengthLow >>> 24) & 255;
    padding[lengthOffset + 5] = (bitLengthLow >>> 16) & 255;
    padding[lengthOffset + 6] = (bitLengthLow >>> 8) & 255;
    padding[lengthOffset + 7] = bitLengthLow & 255;
    // Copy the pending partial block plus the padding into one tail buffer and compress it through
    // the normal path, so there is exactly one block-processing implementation.
    var tail = new Uint8Array(this.blockLength + padding.length);
    tail.set(this.block.subarray(0, this.blockLength), 0);
    tail.set(padding, this.blockLength);
    this.blockLength = 0;
    this._update(tail);
    this.finished = true;
    this.totalBytes = totalBytes;
    var out = new Uint8Array(32);
    var words = [this.h0, this.h1, this.h2, this.h3, this.h4, this.h5, this.h6, this.h7];
    for (var i = 0; i < 8; i += 1) {
      out[i * 4] = (words[i] >>> 24) & 255;
      out[i * 4 + 1] = (words[i] >>> 16) & 255;
      out[i * 4 + 2] = (words[i] >>> 8) & 255;
      out[i * 4 + 3] = words[i] & 255;
    }
    return out;
  };

  Hasher.prototype.digestHex = function () {
    return bytesToHex(this.digestBytes());
  };

  return {
    create: function () { return new Hasher(); },
    /** One-shot helper: sha256(bytes) -> Uint8Array(32). */
    digest: function (input) { return new Hasher().update(input).digestBytes(); },
    /** One-shot helper: sha256Hex(bytes) -> lowercase hex string. */
    hex: function (input) { return new Hasher().update(input).digestHex(); },
    bytesToHex: bytesToHex,
    toBytes: toBytes
  };
});
