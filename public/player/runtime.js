/*
 * Signage player runtime — ES5, dependency-free, webOS 3.5 safe.
 *
 * Delivery target: LG UJ634V / webOS 3.5 / Chromium 38, and every newer TV as well.
 * Rules this file follows without exception:
 *   - ES5 syntax only (no let/const/arrow/template literals/optional chaining/nullish coalescing).
 *     `tests/player-standalone-syntax.test.ts` parses this file with acorn at ecmaVersion 5 and
 *     fails on any modern token.
 *   - No required modern web API: no AbortController, ReadableStream, BroadcastChannel,
 *     ResizeObserver, IntersectionObserver, navigator.storage, Service Worker, module script,
 *     MediaSource, Blob.prototype.arrayBuffer, Object.assign, Map/Set, Array.prototype.at or
 *     Intl.formatToParts. Every optional API is probed; each one either has a fallback or is
 *     reported as degraded.
 *   - The protocol is unchanged: /api/player/pair, /api/player/manifest, /api/player/media-urls,
 *     /api/player/media/<id>, /api/player/heartbeat, SHA-256 verification, atomic manifest
 *     activation, per-origin private credential storage.
 *
 * Boot contract (see lib/player/standalone/shell.ts): the HTML shell paints a visible panel before
 * any script runs and arms a boot guard. If this runtime never reports readiness, the guard shows
 * the compatibility diagnostics instead of leaving a blank screen.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
  if (root) root.SignagePlayerRuntime = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function (root) {
  'use strict';

  var VERSION = '2.1.0';
  var DB_NAME = 'digital-signage-player';  // unchanged: TVs already paired keep their data
  var DB_VERSION = 1;
  var DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;
  var MAX_FULL_BUFFER_BYTES = 192 * 1024 * 1024;
  var DEFAULT_MAX_RETRIES = 3;
  var MAX_MEDIA_URL_BATCH = 25;
  var HEX = '0123456789abcdef';

  /* ---------------------------------------------------------------------------------------------
   * 0. Environment helpers (including a promise shim for platforms without one)
   * ------------------------------------------------------------------------------------------ */

  function MinimalPromise(executor) {
    this.state = 0; // 0 pending, 1 fulfilled, 2 rejected
    this.value = undefined;
    this.handlers = [];
    var self = this;
    function settle(state, value) {
      if (self.state !== 0) return;
      self.state = state;
      self.value = value;
      self.flush();
    }
    function resolve(value) {
      if (value && typeof value.then === 'function' && value !== self) {
        try {
          value.then(function (inner) { resolve(inner); }, function (reason) { settle(2, reason); });
          return;
        } catch (error) { settle(2, error); return; }
      }
      settle(1, value);
    }
    function reject(reason) { settle(2, reason); }
    try { executor(resolve, reject); } catch (error) { reject(error); }
  }
  MinimalPromise.prototype.flush = function () {
    if (!this.handlers.length || this.state === 0) return;
    var state = this.state;
    var value = this.value;
    var pending = this.handlers;
    this.handlers = [];
    setTimeout(function () {
      for (var i = 0; i < pending.length; i += 1) {
        var pair = pending[i];
        try {
          if (state === 1 && typeof pair.onFulfilled === 'function') pair.resolve(pair.onFulfilled(value));
          else if (state === 2 && typeof pair.onRejected === 'function') pair.resolve(pair.onRejected(value));
          else if (state === 2) pair.reject(value);
          else pair.resolve(value);
        } catch (error) { pair.reject(error); }
      }
    }, 0);
  };
  MinimalPromise.prototype.then = function (onFulfilled, onRejected) {
    var self = this;
    return new MinimalPromise(function (resolve, reject) {
      self.handlers.push({ onFulfilled: onFulfilled, onRejected: onRejected, resolve: resolve, reject: reject });
      self.flush();
    });
  };
  MinimalPromise.prototype['catch'] = function (onRejected) { return this.then(null, onRejected); };
  MinimalPromise.resolve = function (value) { return new MinimalPromise(function (resolve) { resolve(value); }); };
  MinimalPromise.reject = function (reason) { return new MinimalPromise(function (resolve, reject) { reject(reason); }); };
  MinimalPromise.all = function (items) {
    return new MinimalPromise(function (resolve, reject) {
      var list = items || [];
      var remaining = list.length;
      var results = new Array(list.length);
      if (!remaining) { resolve(results); return; }
      for (var i = 0; i < list.length; i += 1) {
        (function (index) {
          MinimalPromise.resolve(list[index]).then(function (value) {
            results[index] = value;
            remaining -= 1;
            if (remaining === 0) resolve(results);
          }, reject);
        })(i);
      }
    });
  };

  function resolvePromise(explicit, win) {
    if (explicit) return explicit;
    if (win && typeof win.Promise === 'function' && typeof win.Promise.resolve === 'function') return win.Promise;
    if (typeof Promise === 'function' && typeof Promise.resolve === 'function') return Promise;
    return MinimalPromise;
  }

  function noop() { /* intentionally empty */ }
  function isFn(value) { return typeof value === 'function'; }
  function isArray(value) { return Object.prototype.toString.call(value) === '[object Array]'; }
  function hasOwn(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }

  function extend(target, source) {
    var out = target || {};
    if (!source) return out;
    for (var key in source) { if (hasOwn(source, key)) out[key] = source[key]; }
    return out;
  }

  function PlayerError(message, code) {
    var error = new Error(message);
    error.name = 'PlayerError';
    error.code = code || 'player_error';
    return error;
  }

  function errorCode(error, fallback) {
    if (error && typeof error.code === 'string' && error.code) return error.code;
    return fallback || 'unknown_error';
  }

  function message(error, fallback) {
    if (error && typeof error.message === 'string' && error.message) return error.message;
    return fallback || 'حدث خطأ غير متوقع.';
  }

  function nowIso() { return new Date().toISOString(); }

  function safeString(value, limit) {
    var text = value === null || value === undefined ? '' : String(value);
    if (limit && text.length > limit) return text.slice(0, limit);
    return text;
  }

  /* ---------------------------------------------------------------------------------------------
   * 1. Capability detection
   * ------------------------------------------------------------------------------------------ */

  function detectWebOs(userAgent) {
    var ua = userAgent || '';
    var versionMatch = /(?:Web0S|webOS)[\s\/]*([0-9]+(?:\.[0-9]+)*)/i.exec(ua);
    var hbbtvMatch = /WEBOS([0-9]+(?:\.[0-9]+)*)/i.exec(ua);
    var detected = Boolean(versionMatch || hbbtvMatch || /SmartTV|HbbTV|NetCast/i.test(ua));
    return {
      detected: detected,
      version: versionMatch ? versionMatch[1] : (hbbtvMatch ? hbbtvMatch[1] : null),
      hbbtv: /HbbTV/i.test(ua)
    };
  }

  function detectChromium(userAgent) {
    var match = /(?:Chrome|CriOS|Chromium)\/([0-9]+)/i.exec(userAgent || '');
    if (match) return Number(match[1]);
    var engine = /QtWebEngine\/([0-9.]+)/i.exec(userAgent || '');
    if (engine) return engine[1];
    return null;
  }

  function canPlay(win, mime) {
    try {
      if (!win.document) return null;
      var video = win.document.createElement('video');
      if (!video || !isFn(video.canPlayType)) return null;
      var answer = video.canPlayType(mime);
      if (answer === 'probably') return 'probably';
      if (answer === 'maybe') return 'maybe';
      return '';
    } catch (error) { return null; }
  }

  function detectCapabilities(win) {
    var w = win || {};
    var nav = w.navigator || {};
    var ua = safeString(nav.userAgent, 500);
    var xhrProbe = null;
    try { xhrProbe = isFn(w.XMLHttpRequest) ? new w.XMLHttpRequest() : null; } catch (error) { xhrProbe = null; }
    var urlApi = w.URL || w.webkitURL || null;
    var cryptoObject = w.crypto || null;
    var intl = w.Intl || null;
    var features = {
      xmlHttpRequest: Boolean(xhrProbe),
      fetch: isFn(w.fetch),
      nativePromise: isFn(w.Promise),
      json: typeof JSON !== 'undefined',
      uint8Array: typeof Uint8Array !== 'undefined',
      blob: isFn(w.Blob),
      blobUrl: Boolean(urlApi && isFn(urlApi.createObjectURL)),
      fileReader: isFn(w.FileReader),
      response: isFn(w.Response),
      indexedDb: Boolean(w.indexedDB || w.mozIndexedDB || w.webkitIndexedDB),
      cacheApi: Boolean(w.caches && isFn(w.caches.open)),
      serviceWorker: Boolean(nav.serviceWorker),
      localStorage: false,
      navigatorStorage: Boolean(nav.storage && isFn(nav.storage.estimate)),
      storagePersist: Boolean(nav.storage && isFn(nav.storage.persist)),
      abortController: isFn(w.AbortController),
      readableStream: isFn(w.ReadableStream),
      broadcastChannel: isFn(w.BroadcastChannel),
      resizeObserver: isFn(w.ResizeObserver),
      intersectionObserver: isFn(w.IntersectionObserver),
      cryptoSubtle: Boolean(cryptoObject && cryptoObject.subtle && isFn(cryptoObject.subtle.digest)),
      webkitCryptoSubtle: Boolean(cryptoObject && cryptoObject.webkitSubtle && isFn(cryptoObject.webkitSubtle.digest)),
      xhrResponseType: false,
      intl: Boolean(intl),
      intlFormatToParts: Boolean(intl && intl.DateTimeFormat && intl.DateTimeFormat.prototype && isFn(intl.DateTimeFormat.prototype.formatToParts)),
      mediaSource: isFn(w.MediaSource) || isFn(w.WebKitMediaSource),
      fullscreen: Boolean(w.document && w.document.documentElement && isFn(w.document.documentElement.requestFullscreen)),
      webkitFullscreen: Boolean(w.document && w.document.documentElement && isFn(w.document.documentElement.webkitRequestFullscreen)),
      mp4: canPlay(w, 'video/mp4'),
      h264: canPlay(w, 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"')
    };
    try { features.localStorage = Boolean(w.localStorage); } catch (error) { features.localStorage = false; }
    if (xhrProbe) {
      try { features.xhrResponseType = ('responseType' in xhrProbe); } catch (error) { features.xhrResponseType = false; }
    }
    return {
      version: VERSION,
      userAgent: ua,
      platform: safeString(nav.platform || 'browser', 120),
      language: safeString(nav.language || nav.userLanguage || '', 32),
      screen: {
        width: (w.screen && w.screen.width) || 0,
        height: (w.screen && w.screen.height) || 0,
        devicePixelRatio: w.devicePixelRatio || 1
      },
      webos: detectWebOs(ua),
      chromium: detectChromium(ua),
      features: features,
      sha256: features.cryptoSubtle || features.webkitCryptoSubtle ? 'subtle+internal' : 'internal',
      degraded: buildDegradedList(features)
    };
  }

  function buildDegradedList(features) {
    var checks = [
      ['indexedDb', 'لا يوجد IndexedDB: سيُستخدم تخزين بديل، وقد لا يستمر المحتوى بعد إعادة تشغيل التلفاز.'],
      ['cacheApi', 'لا يوجد Cache API: لا يوجد تخزين دائم بديل للوسائط.'],
      ['fetch', 'لا يوجد fetch: سيُستخدم XMLHttpRequest.'],
      ['nativePromise', 'لا توجد Promises أصلية: ستُستخدم نسخة توافقية داخلية.'],
      ['blobUrl', 'لا يوجد Blob URL: سيتم تشغيل الوسائط من الشبكة مباشرة.'],
      ['cryptoSubtle', 'لا يوجد crypto.subtle: يُستخدم SHA-256 داخلي بالجافاسكربت.'],
      ['navigatorStorage', 'لا توجد إحصاءات تخزين: لن تُعرض أرقام المساحة.'],
      ['storagePersist', 'لا يوجد طلب تخزين دائم: قد يمسح المتصفح الوسائط المخزنة.'],
      ['serviceWorker', 'لا يوجد Service Worker: لا حاجة له؛ المشغل لا يعتمد عليه.']
    ];
    var degraded = [];
    for (var i = 0; i < checks.length; i += 1) {
      if (!features[checks[i][0]]) degraded.push({ feature: checks[i][0], message: checks[i][1] });
    }
    return degraded;
  }

  var REPORT_FEATURES = [
    'xmlHttpRequest', 'fetch', 'nativePromise', 'blob', 'blobUrl', 'fileReader', 'response',
    'indexedDb', 'cacheApi', 'serviceWorker', 'localStorage', 'navigatorStorage',
    'cryptoSubtle', 'webkitCryptoSubtle', 'intlFormatToParts', 'mediaSource', 'fullscreen',
    'mp4', 'h264', 'abortController', 'readableStream', 'broadcastChannel', 'resizeObserver',
    'intersectionObserver'
  ];

  function capabilitiesForReport(caps) {
    var features = (caps && caps.features) || {};
    var report = [];
    for (var i = 0; i < REPORT_FEATURES.length; i += 1) {
      var key = REPORT_FEATURES[i];
      report.push({ feature: key, supported: Boolean(features[key]), value: features[key] });
    }
    return report;
  }

  /* ---------------------------------------------------------------------------------------------
   * 2. Byte and hash helpers
   * ------------------------------------------------------------------------------------------ */

  function resolveSha(win, explicit) {
    if (explicit) return explicit;
    if (win && win.SignageSha256) return win.SignageSha256;
    if (root && root.SignageSha256) return root.SignageSha256;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS fallback for the UMD build
      if (typeof require === 'function') return require('./sha256.js');
    } catch (error) { /* browser without bundler: the global is the only source */ }
    return null;
  }

  function createHasher(win, sha) {
    var module = resolveSha(win, sha);
    if (!module || !isFn(module.create)) throw PlayerError('وحدة SHA-256 غير محمّلة.', 'hash_unavailable');
    return module.create();
  }

  function toUint8(input) {
    if (input === null || input === undefined) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    return new Uint8Array(input);
  }

  /** Copy of `bytes[start:end]` without TypedArray.prototype.slice (Chrome 45+). */
  function sliceBytes(bytes, start, end) {
    var view = toUint8(bytes);
    var from = Math.max(0, start || 0);
    var to = end === undefined || end === null ? view.length : Math.min(view.length, end);
    if (to <= from) return new Uint8Array(0);
    var out = new Uint8Array(to - from);
    for (var i = from; i < to; i += 1) out[i - from] = view[i];
    return out;
  }

  function copyBuffer(bytes) {
    var view = toUint8(bytes);
    var buffer = new ArrayBuffer(view.length);
    new Uint8Array(buffer).set(view);
    return buffer;
  }

  function bytesToHex(bytes) {
    var view = toUint8(bytes);
    var out = '';
    for (var i = 0; i < view.length; i += 1) out += HEX.charAt((view[i] >>> 4) & 15) + HEX.charAt(view[i] & 15);
    return out;
  }

  /** Reads a Blob into a Uint8Array without assuming Blob.prototype.arrayBuffer (Chrome 76+). */
  function readBlobBytes(win, blob, P) {
    var PromiseImpl = resolvePromise(P, win);
    return new PromiseImpl(function (resolve, reject) {
      if (!blob) { reject(PlayerError('لا توجد بيانات لقراءتها.', 'blob_missing')); return; }
      if (isFn(blob.arrayBuffer)) {
        try {
          blob.arrayBuffer().then(function (buffer) { resolve(new Uint8Array(buffer)); }, function () { readWithFileReader(win, blob, resolve, reject); });
          return;
        } catch (error) { /* fall through to FileReader */ }
      }
      readWithFileReader(win, blob, resolve, reject);
    });
  }

  function readWithFileReader(win, blob, resolve, reject) {
    var FileReaderCtor = win && win.FileReader;
    if (!FileReaderCtor) { reject(PlayerError('المتصفح لا يستطيع قراءة الملفات المحلية.', 'filereader_unavailable')); return; }
    var reader = new FileReaderCtor();
    reader.onload = function () { resolve(new Uint8Array(reader.result)); };
    reader.onerror = function () { reject(PlayerError('تعذر قراءة ملف محلي.', 'filereader_failed')); };
    try { reader.readAsArrayBuffer(blob); } catch (error) { reject(PlayerError('تعذر بدء قراءة الملف المحلي.', 'filereader_failed')); }
  }

  /* ---------------------------------------------------------------------------------------------
   * 3. Storage backends
   *   Precedence: IndexedDB (resumable chunk store) -> Cache API -> memory.
   *   The IndexedDB layout matches the layout used by the previous React player, so a TV that has
   *   already paired and cached media keeps its credential and assets after this update.
   * ------------------------------------------------------------------------------------------ */

  function idbRequest(P, request) {
    return new P(function (resolve, reject) {
      var settled = false;
      request.onsuccess = function () { if (!settled) { settled = true; resolve(request.result); } };
      request.onerror = function () { if (!settled) { settled = true; reject(request.error || PlayerError('تعذر تنفيذ عملية تخزين محلي.', 'idb_request_failed')); } };
    });
  }

  function idbTransactionDone(P, transaction) {
    return new P(function (resolve, reject) {
      var settled = false;
      transaction.oncomplete = function () { if (!settled) { settled = true; resolve(true); } };
      transaction.onabort = function () { if (!settled) { settled = true; reject(transaction.error || PlayerError('أُلغيت عملية التخزين المحلي.', 'idb_aborted')); } };
      transaction.onerror = function () { if (!settled) { settled = true; reject(transaction.error || PlayerError('فشلت عملية التخزين المحلي.', 'idb_failed')); } };
    });
  }

  function openIndexedDb(win, P) {
    var factory = win.indexedDB || win.mozIndexedDB || win.webkitIndexedDB;
    if (!factory) return P.reject(PlayerError('IndexedDB غير متاح.', 'no_indexeddb'));
    return new P(function (resolve, reject) {
      var settled = false;
      var timer = win.setTimeout(function () {
        if (!settled) { settled = true; reject(PlayerError('لم يستجب التخزين المحلي في الوقت المحدد.', 'idb_open_timeout')); }
      }, 8000);
      function settleReject(error) {
        if (settled) return;
        settled = true;
        win.clearTimeout(timer);
        reject(error);
      }
      var open;
      try { open = factory.open(DB_NAME, DB_VERSION); } catch (error) { settleReject(PlayerError('تعذر فتح التخزين المحلي.', 'idb_open_failed')); return; }
      open.onupgradeneeded = function () {
        try {
          var db = open.result;
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
          if (!db.objectStoreNames.contains('credentials')) db.createObjectStore('credentials', { keyPath: 'key' });
          if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'hash' });
          if (!db.objectStoreNames.contains('parts')) {
            var store = db.createObjectStore('parts', { keyPath: 'key' });
            store.createIndex('by-hash', 'hash', { unique: false });
          }
          if (!db.objectStoreNames.contains('partials')) db.createObjectStore('partials', { keyPath: 'hash' });
          if (!db.objectStoreNames.contains('manifests')) db.createObjectStore('manifests', { keyPath: 'manifestHash' });
        } catch (error) { /* a partially created database still works; missing stores degrade later */ }
      };
      open.onsuccess = function () {
        if (settled) { try { open.result.close(); } catch (error) { noop(); } return; }
        settled = true;
        win.clearTimeout(timer);
        var db = open.result;
        try { db.onversionchange = function () { try { db.close(); } catch (error) { noop(); } }; } catch (error) { noop(); }
        resolve(db);
      };
      open.onerror = function () { settleReject(PlayerError('المتصفح منع التخزين المحلي.', 'idb_open_failed')); };
      open.onblocked = function () { settleReject(PlayerError('التخزين المحلي مشغول في نافذة أخرى.', 'idb_blocked')); };
    });
  }

  function IdbAdapter(win, db, P) {
    this.win = win;
    this.db = db;
    this.P = P;
    this.backend = 'indexeddb';
    this.notes = [];
  }
  IdbAdapter.prototype._get = function (store, key) {
    var self = this;
    var P = this.P;
    return new P(function (resolve, reject) {
      var tx;
      try { tx = self.db.transaction(store, 'readonly'); } catch (error) { reject(error); return; }
      idbRequest(P, tx.objectStore(store).get(key)).then(resolve, reject);
    });
  };
  IdbAdapter.prototype._getAll = function (store) {
    var self = this;
    var P = this.P;
    return new P(function (resolve, reject) {
      var tx;
      try { tx = self.db.transaction(store, 'readonly'); } catch (error) { reject(error); return; }
      idbRequest(P, tx.objectStore(store).getAll()).then(function (rows) { resolve(rows || []); }, reject);
    });
  };
  IdbAdapter.prototype._put = function (store, value) {
    var self = this;
    var P = this.P;
    return new P(function (resolve, reject) {
      var tx;
      try { tx = self.db.transaction(store, 'readwrite'); } catch (error) { reject(error); return; }
      try { tx.objectStore(store).put(value); } catch (error) { reject(error); return; }
      idbTransactionDone(P, tx).then(function () { resolve(value); }, reject);
    });
  };
  IdbAdapter.prototype._delete = function (store, key) {
    var self = this;
    var P = this.P;
    return new P(function (resolve, reject) {
      var tx;
      try { tx = self.db.transaction(store, 'readwrite'); } catch (error) { reject(error); return; }
      try { tx.objectStore(store).delete(key); } catch (error) { reject(error); return; }
      idbTransactionDone(P, tx).then(function () { resolve(true); }, reject);
    });
  };
  IdbAdapter.prototype._partsOf = function (hash) {
    var self = this;
    var P = this.P;
    function cursorWalk() {
      return new P(function (resolve, reject) {
        var tx;
        try { tx = self.db.transaction('parts', 'readonly'); } catch (error) { reject(error); return; }
        var rows = [];
        var walk;
        try { walk = tx.objectStore('parts').openCursor(); } catch (error) { reject(error); return; }
        walk.onsuccess = function () {
          var cursor = walk.result;
          if (!cursor) {
            rows.sort(function (a, b) { return a.index - b.index; });
            resolve(rows);
            return;
          }
          if (cursor.value && cursor.value.hash === hash) rows.push(cursor.value);
          try { cursor['continue'](); } catch (error) { resolve(rows); }
        };
        walk.onerror = function () { reject(walk.error || PlayerError('تعذر قراءة الأجزاء المحلية.', 'idb_request_failed')); };
      });
    }
    return new P(function (resolve) {
      var tx;
      try { tx = self.db.transaction('parts', 'readonly'); } catch (error) { resolve([]); return; }
      var request;
      try {
        var keyRange = (typeof IDBKeyRange !== 'undefined' && IDBKeyRange) || self.win.IDBKeyRange;
        if (!keyRange || !isFn(keyRange.only)) throw PlayerError('IDBKeyRange غير متاح.', 'no_key_range');
        request = tx.objectStore('parts').index('by-hash').getAll(keyRange.only(hash));
      } catch (error) {
        cursorWalk().then(resolve, function () { resolve([]); });
        return;
      }
      idbRequest(P, request).then(function (rows) {
        var list = (rows || []).filter(function (row) { return row && row.hash === hash; });
        list.sort(function (a, b) { return a.index - b.index; });
        resolve(list);
      }, function () { cursorWalk().then(resolve, function () { resolve([]); }); });
    });
  };
  IdbAdapter.prototype._partBytes = function (part) {
    var P = this.P;
    if (!part) return P.resolve(null);
    if (part.buffer) return P.resolve(new Uint8Array(part.buffer));
    if (part.bytes) return P.resolve(toUint8(part.bytes));
    if (part.blob) return readBlobBytes(this.win, part.blob, P);
    return P.resolve(null);
  };
  IdbAdapter.prototype._partLength = function (part) {
    if (!part) return 0;
    if (typeof part.size === 'number') return part.size;
    if (part.buffer && typeof part.buffer.byteLength === 'number') return part.buffer.byteLength;
    if (part.blob && typeof part.blob.size === 'number') return part.blob.size;
    if (part.bytes && typeof part.bytes.length === 'number') return part.bytes.length;
    return 0;
  };
  IdbAdapter.prototype.getCredential = function () {
    return this._get('credentials', 'screen').then(function (row) { return (row && row.token) || null; }, function () { return null; });
  };
  IdbAdapter.prototype.setCredential = function (token) {
    return this._put('credentials', { key: 'screen', token: token, savedAt: nowIso() }).then(function () { return true; });
  };
  IdbAdapter.prototype.clearCredential = function () { return this._delete('credentials', 'screen'); };
  IdbAdapter.prototype.getActiveManifest = function () {
    var self = this;
    return this._get('meta', 'activeManifest').then(function (pointer) {
      if (!pointer || typeof pointer.value !== 'string') return null;
      return self._get('manifests', pointer.value).then(function (row) { return (row && row.manifest) || null; }, function () { return null; });
    }, function () { return null; });
  };
  IdbAdapter.prototype.activateManifest = function (manifest) {
    var self = this;
    var P = this.P;
    return this.completeHashes(manifest).then(function (missing) {
      if (missing.length) throw PlayerError('لا يمكن تفعيل قائمة ناقصة: الملف ' + safeString(missing[0], 8) + ' غير مكتمل.', 'partial_sync');
      return new P(function (resolve, reject) {
        var tx;
        try { tx = self.db.transaction(['manifests', 'meta'], 'readwrite'); } catch (error) { reject(error); return; }
        try {
          tx.objectStore('manifests').put({ manifestHash: manifest.manifestHash, manifest: manifest, activatedAt: nowIso() });
          tx.objectStore('meta').put({ key: 'activeManifest', value: manifest.manifestHash });
        } catch (error) { reject(error); return; }
        idbTransactionDone(P, tx).then(function () { resolve(true); }, reject);
      });
    });
  };
  IdbAdapter.prototype.completeHashes = function (manifest) {
    var self = this;
    var P = this.P;
    var assets = uniqueAssetsLoose(manifest);
    var missing = [];
    function next(index) {
      if (index >= assets.length) return P.resolve(missing);
      return self.hasCompleteAsset(assets[index].hash, assets[index].size, assets[index].mimeType).then(function (ok) {
        if (!ok) missing.push(assets[index].hash);
        return next(index + 1);
      });
    }
    return next(0);
  };
  IdbAdapter.prototype.hasCompleteAsset = function (hash, expectedSize, mimeType) {
    var self = this;
    return this._get('assets', hash).then(function (record) {
      if (!record || record.complete !== true || Number(record.size) !== Number(expectedSize)) {
        if (record) return self.clearAsset(hash).then(function () { return false; });
        return false;
      }
      if (mimeType && record.mimeType && record.mimeType !== mimeType) {
        return self.clearAsset(hash).then(function () { return false; });
      }
      return self._partsOf(hash).then(function (parts) {
        if (parts.length !== Number(record.chunkCount)) {
          return self.clearAsset(hash).then(function () { return false; });
        }
        var total = 0;
        var intact = true;
        for (var i = 0; i < parts.length; i += 1) {
          var size = self._partLength(parts[i]);
          total += size;
          if (parts[i].index !== i || size <= 0) intact = false;
          if (record.chunkSize && i < parts.length - 1 && size !== Number(record.chunkSize)) intact = false;
        }
        if (!intact || total !== Number(expectedSize)) {
          return self.clearAsset(hash).then(function () { return false; });
        }
        return true;
      }, function () { return false; });
    }, function () { return false; });
  };
  IdbAdapter.prototype.getPartialInfo = function (hash) { return this._get('partials', hash); };
  IdbAdapter.prototype.getAssetParts = function (hash) {
    var self = this;
    var P = this.P;
    return this._partsOf(hash).then(function (parts) {
      var out = [];
      function next(index) {
        if (index >= parts.length) return P.resolve(out);
        return self._partBytes(parts[index]).then(function (bytes) {
          if (bytes) out.push({ index: parts[index].index, bytes: bytes, size: self._partLength(parts[index]) });
          return next(index + 1);
        }, function () { return next(index + 1); });
      }
      return next(0);
    }, function () { return []; });
  };
  IdbAdapter.prototype.saveChunk = function (hash, index, bytes, meta) {
    var P = this.P;
    var self = this;
    var buffer = copyBuffer(bytes);
    return new P(function (resolve, reject) {
      var tx;
      try { tx = self.db.transaction(['parts', 'partials'], 'readwrite'); } catch (error) { reject(error); return; }
      try {
        tx.objectStore('parts').put({ key: hash + ':' + index, hash: hash, index: index, buffer: buffer, size: buffer.byteLength });
        tx.objectStore('partials').put({
          hash: hash,
          expectedSize: Number(meta.expectedSize),
          mimeType: meta.mimeType,
          chunkSize: Number(meta.chunkSize),
          updatedAt: nowIso()
        });
      } catch (error) { reject(error); return; }
      idbTransactionDone(P, tx).then(function () { resolve(true); }, reject);
    });
  };
  IdbAdapter.prototype.finalizeAsset = function (hash, expectedSize, mimeType, chunkCount, chunkSize) {
    var self = this;
    var P = this.P;
    return this._partsOf(hash).then(function (parts) {
      if (parts.length !== Number(chunkCount)) throw PlayerError('عدد الأجزاء المحلية غير مكتمل.', 'partial_sync');
      var total = 0;
      for (var i = 0; i < parts.length; i += 1) {
        if (parts[i].index !== i) throw PlayerError('تسلسل أجزاء الملف المحلي غير مكتمل.', 'partial_sync');
        total += self._partLength(parts[i]);
      }
      if (total !== Number(expectedSize)) throw PlayerError('حجم الملف المحلي لا يطابق البيان.', 'size_mismatch');
      return new P(function (resolve, reject) {
        var tx;
        try { tx = self.db.transaction(['assets', 'partials'], 'readwrite'); } catch (error) { reject(error); return; }
        try {
          tx.objectStore('assets').put({
            hash: hash, size: Number(expectedSize), mimeType: mimeType, chunkCount: Number(chunkCount),
            chunkSize: Number(chunkSize), verifiedAt: nowIso(), complete: true
          });
          tx.objectStore('partials').delete(hash);
        } catch (error) { reject(error); return; }
        idbTransactionDone(P, tx).then(function () { resolve(true); }, reject);
      });
    });
  };
  IdbAdapter.prototype.getAssetBlob = function (hash) {
    var self = this;
    if (!isFn(this.win.Blob)) return this.P.resolve(null);
    return this._get('assets', hash).then(function (record) {
      if (!record || !record.complete) return null;
      return self._partsOf(hash).then(function (parts) {
        var pieces = [];
        var total = 0;
        for (var i = 0; i < parts.length; i += 1) {
          if (parts[i].index !== i) return null;
          if (parts[i].buffer) pieces.push(parts[i].buffer);
          else if (parts[i].bytes) pieces.push(toUint8(parts[i].bytes));
          else if (parts[i].blob) pieces.push(parts[i].blob);
          else return null;
          total += self._partLength(parts[i]);
        }
        if (total !== Number(record.size)) return null;
        try { return new self.win.Blob(pieces, { type: record.mimeType || 'application/octet-stream' }); }
        catch (error) { try { return new self.win.Blob(pieces); } catch (inner) { return null; } }
      }, function () { return null; });
    }, function () { return null; });
  };
  IdbAdapter.prototype.clearAsset = function (hash) {
    var self = this;
    var P = this.P;
    return this._partsOf(hash).then(function (parts) {
      return new P(function (resolve) {
        var tx;
        try { tx = self.db.transaction(['assets', 'parts', 'partials'], 'readwrite'); } catch (error) { resolve(false); return; }
        try {
          tx.objectStore('assets').delete(hash);
          tx.objectStore('partials').delete(hash);
          var store = tx.objectStore('parts');
          for (var i = 0; i < parts.length; i += 1) {
            if (parts[i] && parts[i].key) store.delete(parts[i].key);
            else if (parts[i]) store.delete(hash + ':' + parts[i].index);
          }
        } catch (error) { resolve(false); return; }
        idbTransactionDone(P, tx).then(function () { resolve(true); }, function () { resolve(false); });
      });
    }, function () { return false; });
  };
  IdbAdapter.prototype.getLastSyncAt = function () {
    return this._get('meta', 'lastSyncAt').then(function (row) { return (row && typeof row.value === 'string') ? row.value : null; }, function () { return null; });
  };
  IdbAdapter.prototype.setLastSyncAt = function (value) {
    return this._put('meta', { key: 'lastSyncAt', value: value }).then(function () { return true; });
  };
  IdbAdapter.prototype.getSeenReloadVersion = function () {
    return this._get('meta', 'seenReloadVersion').then(function (row) { return Number((row && row.value) || 0); }, function () { return 0; });
  };
  IdbAdapter.prototype.setSeenReloadVersion = function (value) {
    return this._put('meta', { key: 'seenReloadVersion', value: Number(value) || 0 }).then(function () { return true; });
  };
  IdbAdapter.prototype.getAudioEnabled = function () {
    return this._get('meta', 'audioEnabled').then(function (row) { return Boolean(row && row.value); }, function () { return false; });
  };
  IdbAdapter.prototype.setAudioEnabled = function (value) {
    return this._put('meta', { key: 'audioEnabled', value: Boolean(value) }).then(function () { return true; });
  };
  IdbAdapter.prototype.countCachedAssets = function () {
    return this._getAll('assets').then(function (rows) {
      var count = 0;
      for (var i = 0; i < rows.length; i += 1) if (rows[i] && rows[i].complete) count += 1;
      return count;
    }, function () { return 0; });
  };
  IdbAdapter.prototype.deleteUnreferenced = function (protectedHashes) {
    var self = this;
    var keep = {};
    for (var i = 0; i < protectedHashes.length; i += 1) keep[protectedHashes[i]] = true;
    return this._getAll('assets').then(function (assets) {
      return self._getAll('partials').then(function (partials) {
        var victims = [];
        var j;
        for (j = 0; j < assets.length; j += 1) if (!keep[assets[j].hash]) victims.push(assets[j].hash);
        for (j = 0; j < partials.length; j += 1) if (!keep[partials[j].hash] && victims.indexOf(partials[j].hash) === -1) victims.push(partials[j].hash);
        function next(index) {
          if (index >= victims.length) return self.P.resolve(victims.length);
          return self.clearAsset(victims[index]).then(function () { return next(index + 1); });
        }
        return next(0);
      });
    }, function () { return 0; });
  };
  IdbAdapter.prototype.getStats = function () {
    var win = this.win;
    var P = this.P;
    var stats = { usage: null, quota: null, persisted: null, backend: this.backend, notes: this.notes };
    var pending = [];
    if (win.navigator && win.navigator.storage && isFn(win.navigator.storage.estimate)) {
      pending.push(new P(function (resolve) {
        try {
          win.navigator.storage.estimate().then(function (estimate) {
            if (estimate) {
              if (typeof estimate.usage === 'number') stats.usage = estimate.usage;
              if (typeof estimate.quota === 'number') stats.quota = estimate.quota;
            }
            resolve(true);
          }, function () { resolve(false); });
        } catch (error) { resolve(false); }
      }));
    }
    if (win.navigator && win.navigator.storage && isFn(win.navigator.storage.persisted)) {
      pending.push(new P(function (resolve) {
        try {
          win.navigator.storage.persisted().then(function (value) { stats.persisted = Boolean(value); resolve(true); }, function () { resolve(false); });
        } catch (error) { resolve(false); }
      }));
    }
    if (!pending.length) return P.resolve(stats);
    return P.all(pending).then(function () { return stats; }, function () { return stats; });
  };
  IdbAdapter.prototype.requestPersistence = function () {
    var win = this.win;
    var P = this.P;
    if (!win.navigator || !win.navigator.storage || !isFn(win.navigator.storage.persist)) return P.resolve(null);
    return new P(function (resolve) {
      try { win.navigator.storage.persist().then(function (value) { resolve(Boolean(value)); }, function () { resolve(false); }); }
      catch (error) { resolve(false); }
    });
  };
  IdbAdapter.prototype.close = function () {
    try { this.db.close(); } catch (error) { noop(); }
    return this.P.resolve(true);
  };

  function localStorageSafe(win) {
    try {
      var storage = win.localStorage;
      if (!storage) return null;
      storage.setItem('__signage_probe', '1');
      storage.removeItem('__signage_probe');
      return storage;
    } catch (error) { return null; }
  }

  /** Cache API backend: used only when IndexedDB is unavailable but CacheStorage exists. */
  function CacheAdapter(win, cache, P) {
    this.win = win;
    this.cache = cache;
    this.P = P;
    this.backend = 'cache-api';
    this.notes = ['يُستخدم Cache API لأن IndexedDB غير متاح.'];
    this.prefix = '/__signage_cache__/';
  }
  CacheAdapter.prototype._url = function (hash, suffix) { return this.prefix + hash + '/' + suffix; };
  CacheAdapter.prototype._metaUrl = function (key) { return this.prefix + 'meta/' + key; };
  CacheAdapter.prototype._putJson = function (url, value) {
    var self = this;
    return new this.P(function (resolve, reject) {
      try {
        var response = new self.win.Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
        self.cache.put(url, response).then(function () { resolve(true); }, reject);
      } catch (error) { reject(PlayerError('تعذر الحفظ في Cache API.', 'cache_put_failed')); }
    });
  };
  CacheAdapter.prototype._getJson = function (url) {
    var self = this;
    return new this.P(function (resolve) {
      self.cache.match(url).then(function (response) {
        if (!response) { resolve(null); return; }
        response.json().then(function (value) { resolve(value || null); }, function () { resolve(null); });
      }, function () { resolve(null); });
    });
  };
  CacheAdapter.prototype._putBytes = function (url, bytes, contentType) {
    var self = this;
    return new this.P(function (resolve, reject) {
      try {
        var response = new self.win.Response(toUint8(bytes), { status: 200, headers: { 'Content-Type': contentType || 'application/octet-stream' } });
        self.cache.put(url, response).then(function () { resolve(true); }, reject);
      } catch (error) { reject(PlayerError('تعذر الحفظ في Cache API.', 'cache_put_failed')); }
    });
  };
  CacheAdapter.prototype._keysForHash = function (hash) {
    var needle = this.prefix + hash + '/';
    return new this.P(function (resolve) {
      this.cache.keys().then(function (requests) {
        var out = [];
        for (var i = 0; i < requests.length; i += 1) {
          var url = requests[i].url || requests[i];
          var text = typeof url === 'string' ? url : (url.href || '');
          var marker = text.indexOf(needle);
          if (marker !== -1) out.push(text.slice(marker + needle.length));
        }
        resolve(out);
      }, function () { resolve([]); });
    }.bind(this));
  };
  CacheAdapter.prototype.getCredential = function () {
    var storage = localStorageSafe(this.win);
    if (storage) return this.P.resolve(storage.getItem('signage.screenToken'));
    return this._getJson(this._metaUrl('credential')).then(function (value) { return (value && value.token) || null; });
  };
  CacheAdapter.prototype.setCredential = function (token) {
    var storage = localStorageSafe(this.win);
    if (storage) { storage.setItem('signage.screenToken', token); return this.P.resolve(true); }
    return this._putJson(this._metaUrl('credential'), { token: token });
  };
  CacheAdapter.prototype.clearCredential = function () {
    var storage = localStorageSafe(this.win);
    if (storage) storage.removeItem('signage.screenToken');
    return this._putJson(this._metaUrl('credential'), { token: null });
  };
  CacheAdapter.prototype.getActiveManifest = function () {
    return this._getJson(this._metaUrl('activeManifest')).then(function (value) { return (value && value.manifest) || null; });
  };
  CacheAdapter.prototype.activateManifest = function (manifest) {
    var self = this;
    return this.completeHashes(manifest).then(function (missing) {
      if (missing.length) throw PlayerError('لا يمكن تفعيل قائمة ناقصة: الملف ' + safeString(missing[0], 8) + ' غير مكتمل.', 'partial_sync');
      return self._putJson(self._metaUrl('activeManifest'), { manifest: manifest });
    });
  };
  CacheAdapter.prototype.completeHashes = function (manifest) {
    var self = this;
    var P = this.P;
    var assets = uniqueAssetsLoose(manifest);
    var missing = [];
    function next(index) {
      if (index >= assets.length) return P.resolve(missing);
      return self.hasCompleteAsset(assets[index].hash, assets[index].size, assets[index].mimeType).then(function (ok) {
        if (!ok) missing.push(assets[index].hash);
        return next(index + 1);
      });
    }
    return next(0);
  };
  CacheAdapter.prototype._assetRecord = function (hash) {
    return this._getJson(this._url(hash, 'record.json'));
  };
  CacheAdapter.prototype.hasCompleteAsset = function (hash, expectedSize, mimeType) {
    return this._assetRecord(hash).then(function (record) {
      if (!record || record.complete !== true) return false;
      if (Number(record.size) !== Number(expectedSize)) return false;
      if (mimeType && record.mimeType && record.mimeType !== mimeType) return false;
      if (!record.parts || typeof record.parts !== 'object') return false;
      var count = 0;
      var total = 0;
      for (var key in record.parts) {
        if (!hasOwn(record.parts, key)) continue;
        count += 1;
        total += Number(record.parts[key]);
      }
      if (count !== Number(record.chunkCount)) return false;
      return total === Number(expectedSize);
    }, function () { return false; });
  };
  CacheAdapter.prototype.getPartialInfo = function (hash) {
    return this._getJson(this._url(hash, 'partial.json'));
  };
  CacheAdapter.prototype.getAssetParts = function (hash) {
    var self = this;
    var P = this.P;
    return this._assetRecord(hash).then(function (record) {
      if (!record || !record.parts) return [];
      var indexes = [];
      for (var key in record.parts) if (hasOwn(record.parts, key)) indexes.push(Number(key));
      indexes.sort(function (a, b) { return a - b; });
      var out = [];
      function next(position) {
        if (position >= indexes.length) return P.resolve(out);
        var index = indexes[position];
        return self.cache.match(self._url(hash, 'part-' + index + '.bin')).then(function (response) {
          if (!response) return next(position + 1);
          return response.arrayBuffer().then(function (buffer) {
            var bytes = new Uint8Array(buffer);
            out.push({ index: index, bytes: bytes, size: bytes.length });
            return next(position + 1);
          }, function () { return next(position + 1); });
        });
      }
      return next(0);
    }, function () { return []; });
  };
  CacheAdapter.prototype.saveChunk = function (hash, index, bytes, meta) {
    var self = this;
    var view = toUint8(bytes);
    return this._putBytes(this._url(hash, 'part-' + index + '.bin'), view, 'application/octet-stream').then(function () {
      return self._assetRecord(hash);
    }).then(function (record) {
      var next = record && record.parts ? record : { hash: hash, parts: {}, chunkCount: 0, complete: false };
      next.hash = hash;
      next.mimeType = meta.mimeType;
      next.size = Number(meta.expectedSize);
      next.chunkSize = Number(meta.chunkSize);
      next.parts[index] = view.length;
      var count = 0;
      for (var key in next.parts) if (hasOwn(next.parts, key)) count += 1;
      next.chunkCount = count;
      next.complete = false;
      return self._putJson(self._url(hash, 'record.json'), next);
    }).then(function () {
      return self._putJson(self._url(hash, 'partial.json'), {
        hash: hash, expectedSize: Number(meta.expectedSize), mimeType: meta.mimeType,
        chunkSize: Number(meta.chunkSize), updatedAt: nowIso()
      });
    }).then(function () { return true; });
  };
  CacheAdapter.prototype.finalizeAsset = function (hash, expectedSize, mimeType, chunkCount, chunkSize) {
    var self = this;
    return this._assetRecord(hash).then(function (record) {
      if (!record || !record.parts) throw PlayerError('عدد الأجزاء المحلية غير مكتمل.', 'partial_sync');
      var indexes = [];
      var total = 0;
      var key;
      for (key in record.parts) if (hasOwn(record.parts, key)) { indexes.push(Number(key)); total += Number(record.parts[key]); }
      if (indexes.length !== Number(chunkCount)) throw PlayerError('عدد الأجزاء المحلية غير مكتمل.', 'partial_sync');
      indexes.sort(function (a, b) { return a - b; });
      for (var i = 0; i < indexes.length; i += 1) if (indexes[i] !== i) throw PlayerError('تسلسل أجزاء الملف المحلي غير مكتمل.', 'partial_sync');
      if (total !== Number(expectedSize)) throw PlayerError('حجم الملف المحلي لا يطابق البيان.', 'size_mismatch');
      record.complete = true;
      record.mimeType = mimeType;
      record.chunkSize = Number(chunkSize);
      return self._putJson(self._url(hash, 'record.json'), record).then(function () {
        return self._putJson(self._url(hash, 'partial.json'), { hash: hash, cleared: true });
      });
    });
  };
  CacheAdapter.prototype.getAssetBlob = function (hash) {
    var self = this;
    if (!isFn(this.win.Blob)) return this.P.resolve(null);
    return this._assetRecord(hash).then(function (record) {
      if (!record || !record.complete) return null;
      return self.getAssetParts(hash).then(function (parts) {
        var pieces = [];
        var total = 0;
        for (var i = 0; i < parts.length; i += 1) { pieces.push(parts[i].bytes); total += parts[i].size; }
        if (total !== Number(record.size)) return null;
        try { return new self.win.Blob(pieces, { type: record.mimeType || 'application/octet-stream' }); } catch (error) { return null; }
      });
    }, function () { return null; });
  };
  CacheAdapter.prototype.clearAsset = function (hash) {
    var self = this;
    var prefix = this.prefix + hash + '/';
    return new this.P(function (resolve) {
      self.cache.keys().then(function (requests) {
        var jobs = [];
        for (var i = 0; i < requests.length; i += 1) {
          var request = requests[i];
          var text = typeof request === 'string' ? request : (request.url || '');
          if (text.indexOf(prefix) !== -1) jobs.push(self.cache['delete'](request));
        }
        self.P.all(jobs).then(function () { resolve(true); }, function () { resolve(false); });
      }, function () { resolve(false); });
    });
  };
  CacheAdapter.prototype.getLastSyncAt = function () {
    return this._getJson(this._metaUrl('lastSyncAt')).then(function (value) { return (value && value.at) || null; });
  };
  CacheAdapter.prototype.setLastSyncAt = function (value) { return this._putJson(this._metaUrl('lastSyncAt'), { at: value }); };
  CacheAdapter.prototype.getSeenReloadVersion = function () {
    return this._getJson(this._metaUrl('seenReloadVersion')).then(function (value) { return Number((value && value.version) || 0); });
  };
  CacheAdapter.prototype.setSeenReloadVersion = function (value) {
    return this._putJson(this._metaUrl('seenReloadVersion'), { version: Number(value) || 0 });
  };
  CacheAdapter.prototype.getAudioEnabled = function () {
    return this._getJson(this._metaUrl('audioEnabled')).then(function (value) { return Boolean(value && value.enabled); });
  };
  CacheAdapter.prototype.setAudioEnabled = function (value) {
    return this._putJson(this._metaUrl('audioEnabled'), { enabled: Boolean(value) });
  };
  CacheAdapter.prototype.countCachedAssets = function () {
    var self = this;
    return new this.P(function (resolve) {
      self.cache.keys().then(function (requests) {
        var count = 0;
        for (var i = 0; i < requests.length; i += 1) {
          var text = typeof requests[i] === 'string' ? requests[i] : (requests[i].url || '');
          if (text.indexOf('/record.json') === -1) continue;
          if (text.indexOf(self.prefix + 'meta/') !== -1) continue;
          count += 1;
        }
        resolve(count);
      }, function () { resolve(0); });
    });
  };
  CacheAdapter.prototype.deleteUnreferenced = function (protectedHashes) {
    var self = this;
    var keep = {};
    for (var i = 0; i < protectedHashes.length; i += 1) keep[protectedHashes[i]] = true;
    return new this.P(function (resolve) {
      self.cache.keys().then(function (requests) {
        var victims = [];
        var pattern = /([a-f0-9]{64})\//;
        for (var j = 0; j < requests.length; j += 1) {
          var text = typeof requests[j] === 'string' ? requests[j] : (requests[j].url || '');
          var match = pattern.exec(text);
          if (match && !keep[match[1]] && victims.indexOf(match[1]) === -1) victims.push(match[1]);
        }
        function next(index) {
          if (index >= victims.length) return self.P.resolve(victims.length);
          return self.clearAsset(victims[index]).then(function () { return next(index + 1); });
        }
        next(0).then(resolve, function () { resolve(0); });
      }, function () { resolve(0); });
    });
  };
  CacheAdapter.prototype.getStats = function () {
    return this.P.resolve({ usage: null, quota: null, persisted: null, backend: this.backend, notes: this.notes });
  };
  CacheAdapter.prototype.requestPersistence = function () { return this.P.resolve(null); };
  CacheAdapter.prototype.close = function () { return this.P.resolve(true); };

  /** Memory backend: last resort so the player still runs (no crash, no blank screen). */
  function MemoryAdapter(win, P) {
    this.win = win;
    this.P = P;
    this.backend = 'memory';
    this.notes = ['لا يوجد تخزين دائم في هذا المتصفح: يعمل المشغل من الذاكرة، ولن يستمر المحتوى بعد إغلاق المتصفح.'];
    this.assets = {};
    this.manifests = {};
    this.meta = {};
    this.usage = 0;
  }
  MemoryAdapter.prototype.getCredential = function () {
    var storage = localStorageSafe(this.win);
    if (storage) return this.P.resolve(storage.getItem('signage.screenToken'));
    return this.P.resolve(this.meta.credential || null);
  };
  MemoryAdapter.prototype.setCredential = function (token) {
    var storage = localStorageSafe(this.win);
    if (storage) storage.setItem('signage.screenToken', token);
    this.meta.credential = token;
    return this.P.resolve(true);
  };
  MemoryAdapter.prototype.clearCredential = function () {
    var storage = localStorageSafe(this.win);
    if (storage) storage.removeItem('signage.screenToken');
    this.meta.credential = null;
    return this.P.resolve(true);
  };
  MemoryAdapter.prototype.getActiveManifest = function () {
    var hash = this.meta.activeManifest;
    return this.P.resolve(hash && this.manifests[hash] ? this.manifests[hash].manifest : null);
  };
  MemoryAdapter.prototype.activateManifest = function (manifest) {
    var self = this;
    return this.completeHashes(manifest).then(function (missing) {
      if (missing.length) throw PlayerError('لا يمكن تفعيل قائمة ناقصة: الملف ' + safeString(missing[0], 8) + ' غير مكتمل.', 'partial_sync');
      self.manifests[manifest.manifestHash] = { manifest: manifest, activatedAt: nowIso() };
      self.meta.activeManifest = manifest.manifestHash;
      return true;
    });
  };
  MemoryAdapter.prototype.completeHashes = function (manifest) {
    var self = this;
    var P = this.P;
    var assets = uniqueAssetsLoose(manifest);
    var missing = [];
    function next(index) {
      if (index >= assets.length) return P.resolve(missing);
      return self.hasCompleteAsset(assets[index].hash, assets[index].size, assets[index].mimeType).then(function (ok) {
        if (!ok) missing.push(assets[index].hash);
        return next(index + 1);
      });
    }
    return next(0);
  };
  MemoryAdapter.prototype.hasCompleteAsset = function (hash, expectedSize, mimeType) {
    var record = this.assets[hash];
    if (!record || !record.complete) return this.P.resolve(false);
    if (Number(record.size) !== Number(expectedSize)) return this.P.resolve(false);
    if (mimeType && record.mimeType && record.mimeType !== mimeType) return this.P.resolve(false);
    var total = 0;
    for (var i = 0; i < record.parts.length; i += 1) {
      if (!record.parts[i] || record.parts[i].index !== i) return this.P.resolve(false);
      total += record.parts[i].bytes.length;
    }
    return this.P.resolve(total === Number(expectedSize));
  };
  MemoryAdapter.prototype.getPartialInfo = function (hash) { return this.P.resolve(this.assets[hash] && this.assets[hash].pending ? this.assets[hash].pending : null); };
  MemoryAdapter.prototype.getAssetParts = function (hash) {
    var record = this.assets[hash];
    if (!record) return this.P.resolve([]);
    var out = [];
    for (var i = 0; i < record.parts.length; i += 1) {
      if (record.parts[i]) out.push({ index: record.parts[i].index, bytes: record.parts[i].bytes, size: record.parts[i].bytes.length });
    }
    return this.P.resolve(out);
  };
  MemoryAdapter.prototype.saveChunk = function (hash, index, bytes, meta) {
    var record = this.assets[hash];
    if (!record) { record = { hash: hash, parts: [], complete: false }; this.assets[hash] = record; }
    record.mimeType = meta.mimeType;
    record.size = Number(meta.expectedSize);
    record.chunkSize = Number(meta.chunkSize);
    while (record.parts.length <= index) record.parts.push(null);
    var copy = new Uint8Array(toUint8(bytes).length);
    copy.set(toUint8(bytes));
    if (!record.parts[index]) this.usage += copy.length;
    record.parts[index] = { index: index, bytes: copy };
    record.pending = {
      hash: hash, expectedSize: Number(meta.expectedSize), mimeType: meta.mimeType,
      chunkSize: Number(meta.chunkSize), updatedAt: nowIso()
    };
    return this.P.resolve(true);
  };
  MemoryAdapter.prototype.finalizeAsset = function (hash, expectedSize, mimeType, chunkCount, chunkSize) {
    var record = this.assets[hash];
    if (!record) throw PlayerError('لا توجد أجزاء محلية للتفعيل.', 'partial_sync');
    if (record.parts.length !== Number(chunkCount)) throw PlayerError('عدد الأجزاء المحلية غير مكتمل.', 'partial_sync');
    var total = 0;
    for (var i = 0; i < record.parts.length; i += 1) {
      if (!record.parts[i] || record.parts[i].index !== i) throw PlayerError('تسلسل أجزاء الملف المحلي غير مكتمل.', 'partial_sync');
      total += record.parts[i].bytes.length;
    }
    if (total !== Number(expectedSize)) throw PlayerError('حجم الملف المحلي لا يطابق البيان.', 'size_mismatch');
    record.complete = true;
    record.chunkCount = Number(chunkCount);
    record.chunkSize = Number(chunkSize);
    record.mimeType = mimeType;
    record.size = Number(expectedSize);
    record.pending = null;
    return this.P.resolve(true);
  };
  MemoryAdapter.prototype.getAssetBlob = function (hash) {
    var record = this.assets[hash];
    if (!record || !record.complete || !isFn(this.win.Blob)) return this.P.resolve(null);
    var pieces = [];
    for (var i = 0; i < record.parts.length; i += 1) pieces.push(record.parts[i].bytes);
    try { return this.P.resolve(new this.win.Blob(pieces, { type: record.mimeType })); } catch (error) { return this.P.resolve(null); }
  };
  MemoryAdapter.prototype.clearAsset = function (hash) {
    var record = this.assets[hash];
    if (record) {
      for (var i = 0; i < record.parts.length; i += 1) if (record.parts[i]) this.usage -= record.parts[i].bytes.length;
      if (this.usage < 0) this.usage = 0;
    }
    delete this.assets[hash];
    return this.P.resolve(true);
  };
  MemoryAdapter.prototype.getLastSyncAt = function () { return this.P.resolve(this.meta.lastSyncAt || null); };
  MemoryAdapter.prototype.setLastSyncAt = function (value) { this.meta.lastSyncAt = value; return this.P.resolve(true); };
  MemoryAdapter.prototype.getSeenReloadVersion = function () { return this.P.resolve(Number(this.meta.seenReloadVersion || 0)); };
  MemoryAdapter.prototype.setSeenReloadVersion = function (value) { this.meta.seenReloadVersion = Number(value) || 0; return this.P.resolve(true); };
  MemoryAdapter.prototype.getAudioEnabled = function () { return this.P.resolve(Boolean(this.meta.audioEnabled)); };
  MemoryAdapter.prototype.setAudioEnabled = function (value) { this.meta.audioEnabled = Boolean(value); return this.P.resolve(true); };
  MemoryAdapter.prototype.countCachedAssets = function () {
    var count = 0;
    for (var hash in this.assets) if (hasOwn(this.assets, hash) && this.assets[hash].complete) count += 1;
    return this.P.resolve(count);
  };
  MemoryAdapter.prototype.deleteUnreferenced = function (protectedHashes) {
    var keep = {};
    for (var i = 0; i < protectedHashes.length; i += 1) keep[protectedHashes[i]] = true;
    var victims = [];
    var hash;
    for (hash in this.assets) if (hasOwn(this.assets, hash) && !keep[hash]) victims.push(hash);
    for (var j = 0; j < victims.length; j += 1) this.clearAsset(victims[j]);
    return this.P.resolve(victims.length);
  };
  MemoryAdapter.prototype.getStats = function () {
    return this.P.resolve({ usage: this.usage, quota: null, persisted: false, backend: this.backend, notes: this.notes });
  };
  MemoryAdapter.prototype.requestPersistence = function () { return this.P.resolve(null); };
  MemoryAdapter.prototype.close = function () { return this.P.resolve(true); };

  /** Manifest assets without validation — used by the adapters' completeness checks. */
  function uniqueAssetsLoose(manifest) {
    var out = [];
    var seen = {};
    var assets = (manifest && manifest.assets) || [];
    for (var i = 0; i < assets.length; i += 1) {
      if (!assets[i] || seen[assets[i].hash]) continue;
      seen[assets[i].hash] = true;
      out.push({ hash: assets[i].hash, size: Number(assets[i].size), mimeType: assets[i].mimeType });
    }
    return out;
  }

  /**
   * Opens the best storage backend available. Never rejects: the memory backend always works, so a
   * TV without IndexedDB still renders and plays from memory instead of crashing.
   */
  function createStorage(win, options) {
    var opts = options || {};
    var P = resolvePromise(opts.Promise, win);
    var log = isFn(opts.log) ? opts.log : noop;
    var notes = [];

    function idbAttempt() {
      if (!(win.indexedDB || win.mozIndexedDB || win.webkitIndexedDB)) {
        return P.reject(PlayerError('IndexedDB غير متاح في هذا المتصفح.', 'no_indexeddb'));
      }
      return openIndexedDb(win, P).then(function (db) {
        // Probe: a store that opens but cannot be written is worse than no store at all.
        return new P(function (resolve, reject) {
          var tx;
          try { tx = db.transaction('meta', 'readwrite'); } catch (error) { reject(error); return; }
          try { tx.objectStore('meta').put({ key: '__probe', value: nowIso() }); } catch (error) { reject(error); return; }
          idbTransactionDone(P, tx).then(function () { resolve(db); }, reject);
        });
      });
    }

    function cacheAttempt() {
      if (!(win.caches && isFn(win.caches.open))) return P.reject(PlayerError('Cache API غير متاح.', 'no_cache_api'));
      if (!isFn(win.Response)) return P.reject(PlayerError('Response غير متاح.', 'no_cache_api'));
      return win.caches.open('signage-player-v1').then(function (cache) {
        if (!cache || !isFn(cache.put) || !isFn(cache.match) || !isFn(cache.keys)) throw PlayerError('Cache API غير مكتمل.', 'no_cache_api');
        return new CacheAdapter(win, cache, P);
      });
    }

    return idbAttempt().then(function (db) {
      return new IdbAdapter(win, db, P);
    }, function (idbError) {
      log('idb_unavailable', { code: errorCode(idbError) });
      notes.push('تعذر استخدام IndexedDB (' + errorCode(idbError) + ').');
      return cacheAttempt().then(function (adapter) {
        adapter.notes = (adapter.notes || []).concat(notes);
        return adapter;
      }, function (cacheError) {
        log('cache_unavailable', { code: errorCode(cacheError) });
        var adapter = new MemoryAdapter(win, P);
        adapter.notes = notes.concat(adapter.notes);
        return adapter;
      });
    }).then(function (adapter) {
      log('storage_ready', { backend: adapter.backend });
      return adapter;
    });
  }

  /* ---------------------------------------------------------------------------------------------
   * 4. HTTP transport (XMLHttpRequest first; fetch only as a fallback)
   * ------------------------------------------------------------------------------------------ */

  function normalizeResponse(spec) {
    return {
      status: spec.status,
      ok: spec.status >= 200 && spec.status < 300,
      url: spec.url,
      bytes: spec.bytes || null,
      text: spec.text === null || spec.text === undefined ? null : spec.text,
      receivedBytes: spec.receivedBytes || 0,
      header: function (name) {
        if (!spec.headers || !isFn(spec.headers.get)) return null;
        try { return spec.headers.get(name); } catch (error) { return null; }
      },
      json: function () {
        if (spec.text === null || spec.text === undefined) throw PlayerError('لا يمكن قراءة استجابة فارغة.', 'empty_response');
        return JSON.parse(spec.text);
      }
    };
  }

  function stringToBytes(text) {
    var out = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 255;
    return out;
  }

  function xhrRequest(win, spec) {
    var P = resolvePromise(spec.Promise, win);
    return new P(function (resolve, reject) {
      var xhr = new win.XMLHttpRequest();
      var url = spec.url;
      var wantsBinary = spec.responseType === 'arraybuffer';
      var settled = false;
      function fail(code, detail) {
        if (settled) return;
        settled = true;
        reject(PlayerError(detail || 'فشل طلب الشبكة.', code));
      }
      try { xhr.open(spec.method || 'GET', url, true); }
      catch (error) { fail('request_open_failed', 'تعذر بدء طلب الشبكة.'); return; }
      try { if ('responseType' in xhr) xhr.responseType = wantsBinary ? 'arraybuffer' : 'text'; } catch (error) { noop(); }
      var headers = spec.headers || {};
      for (var name in headers) {
        if (!hasOwn(headers, name)) continue;
        if (headers[name] === null || headers[name] === undefined) continue;
        try { xhr.setRequestHeader(name, String(headers[name])); } catch (error) { noop(); }
      }
      try { if (spec.timeoutMs) xhr.timeout = spec.timeoutMs; } catch (error) { noop(); }
      var receivedBytes = 0;
      if (isFn(spec.onProgress)) {
        xhr.onprogress = function (event) {
          if (!event || typeof event.loaded !== 'number') return;
          receivedBytes = event.loaded;
          try { spec.onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : -1 }); } catch (error) { noop(); }
        };
      }
      xhr.onload = function () {
        if (settled) return;
        settled = true;
        var status = 0;
        try { status = xhr.status || 0; } catch (error) { status = 0; }
        if (status === 0) {
          reject(PlayerError('لم يصل أي رد من الشبكة (قد يكون المضيف محجوباً أو الطلب مرفوضاً).', 'network_error'));
          return;
        }
        var bytes = null;
        var text = null;
        try {
          if (wantsBinary) {
            if (xhr.response instanceof ArrayBuffer) bytes = new Uint8Array(xhr.response);
            else if (xhr.response && typeof xhr.response.byteLength === 'number') bytes = new Uint8Array(xhr.response);
            else if (typeof xhr.responseText === 'string' && xhr.responseText) bytes = stringToBytes(xhr.responseText);
          } else {
            text = typeof xhr.responseText === 'string' ? xhr.responseText : (typeof xhr.response === 'string' ? xhr.response : '');
          }
        } catch (error) { bytes = null; text = null; }
        resolve(normalizeResponse({
          status: status, url: url, bytes: bytes, text: text,
          receivedBytes: bytes ? bytes.length : receivedBytes,
          headers: { get: function (headerName) { try { return xhr.getResponseHeader(headerName); } catch (error) { return null; } } }
        }));
      };
      xhr.onerror = function () { fail('network_error', 'تعذر الاتصال بالشبكة.'); };
      xhr.ontimeout = function () { fail('timeout', 'انتهت مدة الطلب قبل الرد.'); };
      xhr.onabort = function () { fail('aborted', 'أُلغى الطلب.'); };
      try { xhr.send(spec.body === undefined || spec.body === null ? null : spec.body); }
      catch (error) { fail('request_send_failed', 'تعذر إرسال الطلب.'); }
    });
  }

  function fetchRequest(win, spec) {
    var P = resolvePromise(spec.Promise, win);
    var url = spec.url;
    var init = { method: spec.method || 'GET', headers: spec.headers || {} };
    if (spec.body !== undefined && spec.body !== null) init.body = spec.body;
    // AbortController is deliberately not used anywhere in this runtime: the timeout is enforced by
    // racing the promise and ignoring a late response, which works on Chrome < 66.
    return new P(function (resolve, reject) {
      var settled = false;
      var timer = null;
      if (spec.timeoutMs) {
        timer = win.setTimeout(function () {
          if (!settled) { settled = true; reject(PlayerError('انتهت مدة الطلب قبل الرد.', 'timeout')); }
        }, spec.timeoutMs);
      }
      win.fetch(url, init).then(function (response) {
        if (settled) return null;
        if (timer) { win.clearTimeout(timer); timer = null; }
        var wantsBinary = spec.responseType === 'arraybuffer';
        return (wantsBinary ? response.arrayBuffer() : response.text()).then(function (body) {
          if (settled) return;
          settled = true;
          resolve(normalizeResponse({
            status: response.status, url: url,
            bytes: wantsBinary ? new Uint8Array(body) : null,
            text: wantsBinary ? null : body,
            headers: { get: function (name) { try { return response.headers.get(name); } catch (error) { return null; } } }
          }));
        });
      }).then(null, function (error) {
        if (settled) return;
        if (timer) win.clearTimeout(timer);
        settled = true;
        reject(PlayerError(message(error, 'تعذر الاتصال بالشبكة.'), 'network_error'));
      });
    });
  }

  function createHttp(win, options) {
    var opts = options || {};
    var log = isFn(opts.log) ? opts.log : noop;
    var transport = isFn(opts.transport) ? opts.transport : null;
    var P = resolvePromise(opts.Promise, win);
    var api = {};
    api.request = function (spec) {
      var finalSpec = extend({ Promise: P, timeoutMs: opts.timeoutMs || 60000 }, spec);
      if (transport) return transport(finalSpec);
      if (isFn(win.XMLHttpRequest)) {
        return xhrRequest(win, finalSpec)['catch'](function (error) {
          if (errorCode(error) === 'network_error' && isFn(win.fetch)) {
            log('xhr_network_error_fetch_retry', { url: safeString(spec.url, 120) });
            return fetchRequest(win, finalSpec);
          }
          throw error;
        });
      }
      if (isFn(win.fetch)) return fetchRequest(win, finalSpec);
      return P.reject(PlayerError('المتصفح لا يدعم أي طريقة اتصال معتمدة.', 'no_http_transport'));
    };
    api.json = function (url, options2) {
      var spec = extend({ url: url, method: 'GET', responseType: 'text' }, options2 || {});
      spec.headers = extend({ Accept: 'application/json' }, spec.headers || {});
      if (spec.body) spec.headers['Content-Type'] = 'application/json';
      return api.request(spec).then(function (response) {
        var data = null;
        if (response.ok) {
          try { data = response.json(); }
          catch (error) { throw PlayerError('استجابة الخادم ليست JSON صالحاً.', 'invalid_json'); }
        }
        return { ok: response.ok, status: response.status, data: data, response: response };
      });
    };
    return api;
  }

  /* ---------------------------------------------------------------------------------------------
   * 5. Scheduling (timezone-safe without Intl.formatToParts)
   * ------------------------------------------------------------------------------------------ */

  var WEEKDAY_NAMES = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  var offsetCache = {};

  function timezoneOffsetMinutes(win, date, timezone) {
    var key = timezone + '|' + Math.floor(date.getTime() / 900000);
    if (hasOwn(offsetCache, key)) return offsetCache[key];
    // Path A: Intl.DateTimeFormat.formatToParts (Chrome 57+ / modern desktop browsers).
    try {
      if (win.Intl && win.Intl.DateTimeFormat && isFn(win.Intl.DateTimeFormat.prototype.formatToParts)) {
        var formatter = new win.Intl.DateTimeFormat('en-GB', {
          timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
        });
        var parts = formatter.formatToParts(date);
        var values = {};
        for (var i = 0; i < parts.length; i += 1) values[parts[i].type] = parts[i].value;
        var weekday = WEEKDAY_NAMES[values.weekday];
        var hour = Number(values.hour);
        if (weekday && isFinite(hour)) {
          offsetCache[key] = { weekday: weekday, minutes: (hour % 24) * 60 + Number(values.minute || 0), source: 'formatToParts' };
          return offsetCache[key];
        }
      }
    } catch (error) { /* fall through to the Chromium 38 path */ }
    // Path B: the toLocaleString round-trip — supported by Chromium 38 (webOS 3.5). Parsed with an
    // explicit regex so no engine-specific date parsing is trusted.
    try {
      var text = date.toLocaleString('en-US', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
      var match = /(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2}):(\d{2})/.exec(text);
      if (match) {
        var asUtc = Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2]), Number(match[4]) % 24, Number(match[5]), Number(match[6]));
        var shifted = new Date(asUtc);
        var isoWeekday = shifted.getUTCDay() === 0 ? 7 : shifted.getUTCDay();
        offsetCache[key] = {
          weekday: isoWeekday,
          minutes: (Number(match[4]) % 24) * 60 + Number(match[5]),
          source: 'toLocaleString'
        };
        return offsetCache[key];
      }
    } catch (error) { /* fall through to device-local time */ }
    // Path C: device-local clock. Documented degradation, never a crash.
    try {
      var localWeekday = date.getDay() === 0 ? 7 : date.getDay();
      offsetCache[key] = { weekday: localWeekday, minutes: date.getHours() * 60 + date.getMinutes(), source: 'device-local' };
      return offsetCache[key];
    } catch (error) { return null; }
  }

  function toMinutes(value) {
    if (typeof value !== 'string') return 0;
    var parts = value.split(':');
    var hours = Number(parts[0]);
    var minutes = Number(parts[1]);
    if (!isFinite(hours) || !isFinite(minutes)) return 0;
    return hours * 60 + minutes;
  }

  function includesWeekday(weekdays, value) {
    if (!isArray(weekdays)) return false;
    for (var i = 0; i < weekdays.length; i += 1) if (Number(weekdays[i]) === Number(value)) return true;
    return false;
  }

  function scheduledPlaylistId(win, manifest, date) {
    if (!manifest) return null;
    var now = date || new Date();
    var schedules = manifest.schedules || [];
    for (var i = 0; i < schedules.length; i += 1) {
      var rule = schedules[i];
      if (!rule || !rule.enabled) continue;
      var clock = timezoneOffsetMinutes(win, now, rule.timezone || (manifest.screen && manifest.screen.timezone) || 'UTC');
      if (!clock) continue;
      var start = toMinutes(rule.startTime);
      var end = toMinutes(rule.endTime);
      var today = includesWeekday(rule.weekdays, clock.weekday);
      var yesterday = includesWeekday(rule.weekdays, clock.weekday === 1 ? 7 : clock.weekday - 1);
      var active = start < end
        ? (today && clock.minutes >= start && clock.minutes < end)
        : ((today && clock.minutes >= start) || (yesterday && clock.minutes < end));
      if (active) return rule.playlistId;
    }
    return manifest.defaultPlaylistId || null;
  }

  function activeItem(manifest, playlistId, index) {
    if (!manifest || !playlistId) return null;
    var playlists = manifest.playlists || [];
    var playlist = null;
    for (var i = 0; i < playlists.length; i += 1) {
      if (playlists[i] && playlists[i].id === playlistId && playlists[i].enabled !== false) { playlist = playlists[i]; break; }
    }
    if (!playlist || !isArray(playlist.items) || !playlist.items.length) return null;
    var count = playlist.items.length;
    var itemIndex = ((index % count) + count) % count;
    return { playlistId: playlist.id, playlistVersion: playlist.version, item: playlist.items[itemIndex], index: itemIndex, count: count };
  }

  /* ---------------------------------------------------------------------------------------------
   * 6. Sync engine — the same protocol as the admin-facing app, re-implemented compatibly.
   * ------------------------------------------------------------------------------------------ */

  function isManifest(value) {
    return Boolean(value && value.schemaVersion === 1 && value.screen && value.screen.id &&
      typeof value.manifestHash === 'string' && isArray(value.playlists) && isArray(value.assets) && isArray(value.schedules));
  }

  function hasPlayableContent(manifest) {
    var playlists = manifest.playlists || [];
    var playable = false;
    for (var i = 0; i < playlists.length; i += 1) {
      if (playlists[i] && playlists[i].enabled !== false && isArray(playlists[i].items) && playlists[i].items.length) { playable = true; break; }
    }
    return playable && Boolean(manifest.defaultPlaylistId || (manifest.schedules && manifest.schedules.length));
  }

  function uniqueAssets(manifest) {
    var out = [];
    var seen = {};
    var assets = manifest.assets || [];
    for (var i = 0; i < assets.length; i += 1) {
      var asset = assets[i];
      if (!asset || !/^[a-f0-9]{64}$/.test(String(asset.hash)) || !isFinite(Number(asset.size)) || Number(asset.size) < 1) {
        throw PlayerError('البيان يحتوي على ملف أو حجم غير صالح.', 'invalid_manifest');
      }
      if (seen[asset.hash]) continue;
      seen[asset.hash] = true;
      out.push({ mediaId: asset.mediaId, hash: asset.hash, size: Number(asset.size), mimeType: asset.mimeType, name: asset.name });
    }
    return out;
  }

  function protectList(manifest) {
    var hashes = [];
    var assets = (manifest && manifest.assets) || [];
    for (var i = 0; i < assets.length; i += 1) hashes.push(assets[i].hash);
    return hashes;
  }

  function createSync(options) {
    var win = options.win;
    var storage = options.storage;
    var http = options.http;
    var log = isFn(options.log) ? options.log : noop;
    var onProgress = isFn(options.onProgress) ? options.onProgress : noop;
    var chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
    var maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
    var P = resolvePromise(options.Promise, win);
    var shaModule = resolveSha(win, options.sha);
    var preferSameOrigin = Boolean(options.preferSameOrigin);
    var signedUrlCache = {};

    function progress(phase, text, values) {
      var payload = { phase: phase, message: text, totalBytes: 0, downloadedBytes: 0 };
      if (values) {
        if (typeof values.totalBytes === 'number') payload.totalBytes = values.totalBytes;
        if (typeof values.downloadedBytes === 'number') payload.downloadedBytes = values.downloadedBytes;
        if (values.currentName) payload.currentName = values.currentName;
      }
      try { onProgress(payload); } catch (error) { noop(); }
    }

    function authHeaders(extra) {
      var headers = extend({}, extra || {});
      if (options.token) headers.Authorization = 'Bearer ' + options.token;
      return headers;
    }

    function authorizedRequest(spec) {
      var finalSpec = extend({}, spec);
      finalSpec.headers = authHeaders(spec.headers);
      return http.request(finalSpec).then(function (response) {
        if (response.status === 401) throw PlayerError('تم إلغاء ربط هذه الشاشة. أعد ربطها من لوحة الإدارة.', 'screen_unauthorized');
        if (response.status === 403) throw PlayerError('الشاشة معطّلة على الخادم. يستمر المحتوى المحلي حتى يتوفر اتصال.', 'screen_disabled');
        return response;
      }, function (error) {
        throw PlayerError('تعذر الاتصال بالخادم. سيستمر العرض المحلي.', 'network_offline', errorCode(error));
      });
    }

    function mediaUrls(mediaIds) {
      if (!mediaIds.length) return P.resolve({});
      return authorizedRequest({
        method: 'POST', url: '/api/player/media-urls', responseType: 'text',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mediaIds: mediaIds })
      }).then(function (result) {
        if (!result.ok) throw PlayerError('تعذر الحصول على روابط تنزيل آمنة.', 'url_unavailable');
        var data = result.json();
        var urls = (data && data.urls) || {};
        for (var key in urls) if (hasOwn(urls, key) && typeof urls[key] === 'string') signedUrlCache[key] = urls[key];
        return urls;
      }, function (error) {
        // One asset at a time is the compatible fallback: batching is only an optimisation.
        var singles = [];
        for (var i = 0; i < mediaIds.length; i += 1) {
          (function (mediaId) {
            singles.push(authorizedRequest({
              method: 'POST', url: '/api/player/media-urls', responseType: 'text',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mediaIds: [mediaId] })
            }).then(function (result) {
              if (!result.ok) return null;
              var data = result.json();
              if (data && data.urls && typeof data.urls[mediaId] === 'string') signedUrlCache[mediaId] = data.urls[mediaId];
              return null;
            }, function () { return null; }));
          })(mediaIds[i]);
        }
        return P.all(singles).then(function () { return signedUrlCache; }, function () { throw error; });
      });
    }

    function signedUrlFor(mediaId) {
      if (preferSameOrigin) return P.resolve(null);
      if (signedUrlCache[mediaId]) return P.resolve(signedUrlCache[mediaId]);
      return mediaUrls([mediaId]).then(function () { return signedUrlCache[mediaId] || null; }, function () { return null; });
    }

    function sameOriginUrl(mediaId) { return '/api/player/media/' + mediaId; }

    function rangeRequest(url, start, end, authenticated) {
      var headers = { Range: 'bytes=' + start + '-' + end };
      return http.request({
        method: 'GET', url: url, responseType: 'arraybuffer',
        headers: authenticated ? authHeaders(headers) : headers,
        timeoutMs: 180000
      });
    }

    function backoff(attempt, context) {
      var delay = 500 * Math.pow(2, attempt - 1);
      log('sync_retry', { attempt: attempt, delayMs: delay, code: context || null });
      return new P(function (resolve) { win.setTimeout(resolve, delay); });
    }

    var FATAL_CODES = {
      screen_unauthorized: true, screen_disabled: true, download_rejected: true,
      range_size_mismatch: true, range_rejected: true, file_too_large_for_browser: true,
      invalid_manifest: true, hash_mismatch: true, size_mismatch: true
    };
    function transientError(error) {
      var code = errorCode(error);
      return !hasOwn(FATAL_CODES, code);
    }

    function saveWhole(asset, bytes) {
      if (bytes.length > MAX_FULL_BUFFER_BYTES) {
        throw PlayerError('حجم الملف كبير على متصفح التلفاز ولا يدعم الخادم تنزيل النطاقات.', 'file_too_large_for_browser');
      }
      function next(position, index) {
        if (position >= bytes.length) return P.resolve(bytes.length);
        var part = sliceBytes(bytes, position, Math.min(position + chunkSize, bytes.length));
        return storage.saveChunk(asset.hash, index, part, {
          expectedSize: asset.size, mimeType: asset.mimeType, chunkSize: chunkSize
        }).then(function () {
          if (index % 8 === 7) {
            return new P(function (resolve) { win.setTimeout(function () { resolve(next(position + part.length, index + 1)); }, 0); });
          }
          return next(position + part.length, index + 1);
        });
      }
      return next(0, 0);
    }

    function downloadAsset(asset, onBytes) {
      var chunkCount = Math.ceil(asset.size / chunkSize);
      return storage.getPartialInfo(asset.hash).then(function (info) {
        if (info && !info.cleared && (Number(info.expectedSize) !== asset.size || info.mimeType !== asset.mimeType || Number(info.chunkSize) !== chunkSize)) {
          return storage.clearAsset(asset.hash);
        }
        return null;
      }).then(function () {
        return storage.getAssetParts(asset.hash);
      }).then(function (parts) {
        var offset = 0;
        var index = 0;
        for (var i = 0; i < parts.length; i += 1) {
          if (parts[i].index !== index || parts[i].size <= 0) { parts = null; break; }
          if (index < parts.length - 1 && parts[i].size !== chunkSize) { parts = null; break; }
          offset += parts[i].size;
          index += 1;
        }
        if (!parts || offset > asset.size || (offset > 0 && offset < asset.size && offset % chunkSize !== 0)) {
          return storage.clearAsset(asset.hash).then(function () { return { offset: 0, index: 0 }; });
        }
        return { offset: offset, index: index };
      }).then(function (state) {
        var offset = state.offset;
        var index = state.index;
        var failures = 0;
        var urlPromise = preferSameOrigin ? P.resolve(null) : signedUrlFor(asset.mediaId);

        function step() {
          if (offset >= asset.size) return P.resolve(true);
          var end = Math.min(offset + chunkSize, asset.size) - 1;
          return urlPromise.then(function (signedUrl) {
            var first;
            if (signedUrl) {
              first = rangeRequest(signedUrl, offset, end, false).then(function (response) {
                return { response: response, signed: true };
              }, function () { return { response: null, signed: true }; });
            } else {
              first = P.resolve({ response: null, signed: false });
            }
            return first.then(function (attempt) {
              if (attempt.response && (attempt.response.status === 401 || attempt.response.status === 403)) {
                // Expired signature: refresh once, then fall through to the same-origin stream.
                delete signedUrlCache[asset.mediaId];
                return signedUrlFor(asset.mediaId).then(function (fresh) {
                  if (!fresh || fresh === signedUrl) return null;
                  return rangeRequest(fresh, offset, end, false).then(function (response) { return { response: response, signed: true }; }, function () { return null; });
                });
              }
              return attempt;
            }).then(function (attempt) {
              if (attempt && attempt.response) return attempt.response;
              if (attempt && attempt.signed) {
                if (!preferSameOrigin) log('media_same_origin', { mediaId: asset.mediaId });
                preferSameOrigin = true;
              }
              return rangeRequest(sameOriginUrl(asset.mediaId), offset, end, true);
            }).then(function (response) {
              if (response.status === 401) throw PlayerError('تم إلغاء ربط هذه الشاشة. أعد ربطها من لوحة الإدارة.', 'screen_unauthorized');
              if (response.status === 403) throw PlayerError('رفض الخادم تنزيل الوسيط لهذه الشاشة.', 'download_rejected');
              if (response.status === 206) {
                var bytes = response.bytes ? toUint8(response.bytes) : new Uint8Array(0);
                var expected = end - offset + 1;
                if (bytes.length > expected) bytes = sliceBytes(bytes, 0, expected);
                if (bytes.length !== expected) throw PlayerError('حجم جزء التنزيل غير مطابق.', 'range_size_mismatch');
                return storage.saveChunk(asset.hash, index, bytes, {
                  expectedSize: asset.size, mimeType: asset.mimeType, chunkSize: chunkSize
                }).then(function () {
                  offset += bytes.length;
                  index += 1;
                  failures = 0;
                  onBytes(bytes.length);
                  return step();
                });
              }
              if (response.status === 200 && offset > 0) {
                // The server ignored the range: start over so part bookkeeping stays exact.
                return storage.clearAsset(asset.hash).then(function () {
                  offset = 0;
                  index = 0;
                  return step();
                });
              }
              if (response.status === 200) {
                var whole = response.bytes ? toUint8(response.bytes) : new Uint8Array(0);
                if (whole.length !== asset.size) throw PlayerError('حجم الملف الذي تم تنزيله غير مكتمل.', 'size_mismatch');
                return saveWhole(asset, whole).then(function (count) {
                  onBytes(count);
                  offset = asset.size;
                  index = chunkCount;
                  return true;
                });
              }
              if (response.status === 416) {
                if (offset >= asset.size) return true;
                throw PlayerError('رفض الخادم نطاق التنزيل المطلوب.', 'range_rejected');
              }
              if (response.status === 400 || response.status === 404 || response.status === 405 || response.status === 501) {
                // A signed URL that cannot serve ranges is remembered, then never used again: the
                // same-origin stream is the only remaining option, so a second refusal is fatal.
                var hadSigned = !preferSameOrigin && Boolean(signedUrlCache[asset.mediaId]);
                if (!hadSigned) throw PlayerError('رفض خادم الملفات طلب التنزيل (' + response.status + ').', 'download_rejected');
                preferSameOrigin = true;
                delete signedUrlCache[asset.mediaId];
                urlPromise = P.resolve(null);
                return step();
              }
              if (response.status >= 500 || response.status === 429) {
                failures += 1;
                if (failures >= maxRetries) throw PlayerError('تعذر تنزيل الوسيط بعد عدة محاولات. ستُحفظ الأجزاء المكتملة لإعادة المحاولة.', 'download_retries_exhausted');
                return backoff(failures, 'http_' + response.status).then(step);
              }
              throw PlayerError('رفض خادم الملفات طلب التنزيل (' + response.status + ').', 'download_rejected');
            }, function (error) {
              // Deterministic failures (unauthorised screen, rejected range, corrupt part) are not
              // retried: retrying them only delays the diagnostics the operator needs to see.
              if (!transientError(error)) throw error;
              failures += 1;
              if (failures >= maxRetries) throw error;
              return backoff(failures, errorCode(error)).then(step);
            });
          });
        }
        return step();
      });
    }

    function verifyAsset(asset) {
      // Incremental SHA-256 over the stored parts, yielding to the event loop between parts so the
      // TV never freezes while a large video is verified.
      var digest = createHasher(win, shaModule);
      var total = 0;
      return storage.getAssetParts(asset.hash).then(function (parts) {
        function next(index) {
          if (index >= parts.length) return P.resolve(total);
          digest.update(toUint8(parts[index].bytes));
          total += parts[index].size;
          return new P(function (resolve) { win.setTimeout(function () { resolve(next(index + 1)); }, 0); });
        }
        return next(0);
      }).then(function (size) {
        if (size !== asset.size) throw PlayerError('فشل فحص حجم الملف بعد التنزيل.', 'size_mismatch');
        var hex = digest.digestHex();
        if (hex !== String(asset.hash)) throw PlayerError('فشل التحقق من بصمة الملف. يحتفظ المشغل بالقائمة السابقة.', 'hash_mismatch');
        return true;
      });
    }

    function quantity(list) {
      var total = 0;
      for (var i = 0; i < list.length; i += 1) total += list[i].size;
      return total;
    }

    function run() {
      progress('manifest', 'التحقق من تحديثات المحتوى…');
      var previous = null;
      return storage.getActiveManifest().then(function (saved) {
        previous = saved;
        var headers = {};
        if (previous && previous.manifestHash) headers['If-None-Match'] = '"' + previous.manifestHash + '"';
        return authorizedRequest({ method: 'GET', url: '/api/player/manifest', responseType: 'text', headers: headers });
      }).then(function (response) {
        if (response.status === 304 && previous) {
          return storage.completeHashes(previous).then(function (missingHashes) {
            if (!missingHashes.length) {
              progress('ready', 'المحتوى المحلي محدث.');
              return storage.getLastSyncAt().then(function (at) {
                return { manifest: previous, changed: false, lastSyncAt: at || previous.generatedAt || nowIso() };
              });
            }
            return authorizedRequest({ method: 'GET', url: '/api/player/manifest', responseType: 'text' });
          });
        }
        return response;
      }).then(function (response) {
        if (response && response.manifest) return response;
        if (response.status === 401) throw PlayerError('تم إلغاء ربط هذه الشاشة. أعد ربطها من لوحة الإدارة.', 'screen_unauthorized');
        if (response.status === 403) throw PlayerError('هذه الشاشة معطّلة من لوحة الإدارة، وسيستمر عرض المحتوى المحفوظ.', 'screen_disabled');
        if (!response.ok) throw PlayerError('تعذر قراءة بيان المحتوى من الخادم.', 'manifest_unavailable');
        var incoming;
        try { incoming = response.json(); }
        catch (error) { throw PlayerError('بيان المحتوى غير صالح.', 'invalid_manifest'); }
        if (!isManifest(incoming)) throw PlayerError('بيان المحتوى غير مكتمل أو غير صالح.', 'invalid_manifest');
        if (!hasPlayableContent(incoming)) {
          if (previous) {
            return storage.getLastSyncAt().then(function (at) {
              return { manifest: previous, changed: false, lastSyncAt: at || previous.generatedAt || nowIso(), notice: 'no_published_content' };
            });
          }
          throw PlayerError('لم يتم نشر قائمة تشغيل تحتوي على وسائط لهذه الشاشة.', 'no_published_content');
        }
        var assets = uniqueAssets(incoming);
        var targets = [];
        for (var i = 0; i < assets.length; i += 1) targets.push(assets[i].hash);
        return storage.deleteUnreferenced(protectList(previous).concat(targets)).then(function () {
          progress('checking', 'فحص التخزين المحلي والوسائط المطلوبة…');
          var pending = [];
          function checkNext(index) {
            if (index >= assets.length) return P.resolve(pending);
            var asset = assets[index];
            return storage.hasCompleteAsset(asset.hash, asset.size, asset.mimeType).then(function (ok) {
              if (!ok) pending.push(asset);
              return checkNext(index + 1);
            });
          }
          return checkNext(0).then(function (list) {
            var totalBytes = quantity(list);
            var gate = P.resolve(true);
            if (totalBytes > 0 && storage.backend === 'indexeddb') {
              gate = storage.getStats().then(function (stats) {
                if (stats.quota === null || stats.usage === null) return true;
                var free = Math.max(0, stats.quota - stats.usage);
                var reserve = Math.max(16 * 1024 * 1024, Math.ceil(stats.quota * 0.03));
                if (free < totalBytes + reserve) {
                  throw PlayerError('المساحة المحلية غير كافية. يلزم ' + Math.ceil(totalBytes / 1048576) + ' ميجابايت إضافية تقريباً. القائمة الحالية لم تتغير.', 'storage_quota');
                }
                return true;
              });
            }
            return gate.then(function () {
              var mediaIds = [];
              for (var j = 0; j < list.length; j += 1) mediaIds.push(list[j].mediaId);
              var batches = [];
              for (var k = 0; k < mediaIds.length; k += MAX_MEDIA_URL_BATCH) batches.push(mediaIds.slice(k, k + MAX_MEDIA_URL_BATCH));
              function fetchUrls(position) {
                if (position >= batches.length) return P.resolve(true);
                return mediaUrls(batches[position]).then(function () { return fetchUrls(position + 1); }, function () { return fetchUrls(position + 1); });
              }
              return fetchUrls(0).then(function () { return storage.requestPersistence(); }).then(function () {
                var completed = 0;
                function download(position) {
                  if (position >= list.length) return P.resolve(true);
                  var asset = list[position];
                  progress('downloading', 'تنزيل الوسائط إلى التخزين المحلي…', {
                    totalBytes: totalBytes, downloadedBytes: completed, currentName: asset.name
                  });
                  return downloadAsset(asset, function (count) {
                    completed += count;
                    progress('downloading', 'تنزيل الوسائط إلى التخزين المحلي…', {
                      totalBytes: totalBytes, downloadedBytes: completed, currentName: asset.name
                    });
                  }).then(function () {
                    progress('verifying', 'التحقق من بصمة الملف…', {
                      totalBytes: totalBytes, downloadedBytes: completed, currentName: asset.name
                    });
                    return verifyAsset(asset).then(function () {
                      return storage.finalizeAsset(asset.hash, asset.size, asset.mimeType, Math.ceil(asset.size / chunkSize), chunkSize);
                    }, function (error) {
                      return storage.clearAsset(asset.hash).then(function () { throw error; });
                    });
                  }).then(function () { return download(position + 1); });
                }
                return download(0).then(function () {
                  progress('activating', 'التحقق من الملفات وتجهيز القائمة الجديدة…', { totalBytes: totalBytes, downloadedBytes: completed });
                  var notComplete = [];
                  function verifyAll(index) {
                    if (index >= assets.length) return P.resolve(notComplete);
                    return storage.hasCompleteAsset(assets[index].hash, assets[index].size, assets[index].mimeType).then(function (ok) {
                      if (!ok) notComplete.push(assets[index].hash);
                      return verifyAll(index + 1);
                    });
                  }
                  return verifyAll(0).then(function (missing) {
                    if (missing.length) throw PlayerError('لم تكتمل مزامنة كل الوسائط. تبقى قائمة التشغيل السابقة نشطة.', 'partial_sync');
                    return storage.activateManifest(incoming).then(function () {
                      var at = nowIso();
                      return storage.setLastSyncAt(at).then(function () {
                        return storage.deleteUnreferenced(targets).then(function () {
                          progress('ready', 'اكتملت المزامنة. يمكن الآن التشغيل دون إنترنت.', { totalBytes: totalBytes, downloadedBytes: totalBytes });
                          return { manifest: incoming, changed: !previous || previous.manifestHash !== incoming.manifestHash, lastSyncAt: at };
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    }

    return {
      run: run,
      mediaUrl: signedUrlFor,
      sameOriginUrl: sameOriginUrl,
      signedUrls: function () { return signedUrlCache; },
      usesSameOrigin: function () { return preferSameOrigin; },
      chunkSize: chunkSize
    };
  }

  /* ---------------------------------------------------------------------------------------------
   * 7. Playback engine (DOM-injected so it is testable and so a failure never blanks the screen)
   * ------------------------------------------------------------------------------------------ */

  function createEngine(options) {
    var win = options.win;
    var doc = options.doc || win.document;
    var stage = options.stage;
    var storage = options.storage;
    var sync = options.sync;
    var http = options.http;
    var P = resolvePromise(options.Promise, win);
    var log = isFn(options.log) ? options.log : noop;
    var notice = isFn(options.onNotice) ? options.onNotice : noop;
    var onItem = isFn(options.onItem) ? options.onItem : noop;
    var onState = isFn(options.onState) ? options.onState : noop;
    var onAudioBlocked = isFn(options.onAudioBlocked) ? options.onAudioBlocked : noop;
    var onAudioReady = isFn(options.onAudioReady) ? options.onAudioReady : noop;
    var state = {
      manifest: null, playlistId: null, index: 0, item: null, element: null, objectUrl: null,
      source: null, mounted: false, mountedHash: null, mountedKind: null, videoElement: null, videoSourceUrl: null,
      pendingImage: null, pendingImageUrl: null, playbackGeneration: 0, renderRequest: 0,
      audioEnabled: Boolean(options.audioEnabled), audioBlocked: false
    };
    var imageTimer = null;
    var stallTimer = null;
    var watchdogMs = options.watchdogMs || 25000;
    var imageDurationDefaultMs = options.imageDurationMs || 10000;
    var networkRetry = {};

    function clearTimers() {
      if (imageTimer) { win.clearTimeout(imageTimer); imageTimer = null; }
      if (stallTimer) { win.clearTimeout(stallTimer); stallTimer = null; }
    }
    function releaseObjectUrl(url) {
      var urlApi = win.URL || win.webkitURL;
      if (url && urlApi && isFn(urlApi.revokeObjectURL)) {
        try { urlApi.revokeObjectURL(url); } catch (error) { noop(); }
      }
    }
    function revokeCurrent() {
      releaseObjectUrl(state.objectUrl);
      state.objectUrl = null;
    }
    function removeImage(image) {
      if (image && image.parentNode) {
        try { image.parentNode.removeChild(image); } catch (error) { noop(); }
      }
    }
    function createVideoElement() {
      if (state.videoElement) return state.videoElement;
      var video = doc.createElement('video');
      video.className = 'sp-video';
      video.setAttribute('autoplay', 'autoplay');
      video.setAttribute('playsinline', 'playsinline');
      video.setAttribute('webkit-playsinline', 'webkit-playsinline');
      video.setAttribute('preload', 'auto');
      video.controls = false;
      video.muted = false;
      video.defaultMuted = false;
      video.volume = 1;
      video.removeAttribute('muted');
      video.style.display = 'none';
      video.style.visibility = 'hidden';
      video.style.opacity = '1';
      video.style.filter = 'none';
      video.style.webkitFilter = 'none';
      stage.appendChild(video);
      state.videoElement = video;
      return video;
    }
    function setVideoVisible(video, visible) {
      if (!video || !video.style) return;
      video.style.display = visible ? 'block' : 'none';
      video.style.visibility = visible ? 'visible' : 'hidden';
      video.style.opacity = '1';
      video.style.filter = 'none';
      video.style.webkitFilter = 'none';
    }
    function clearVideoSource(video) {
      if (!video) return;
      try { video.pause(); } catch (error) { noop(); }
      video.oncanplay = null;
      video.onplaying = null;
      video.ontimeupdate = null;
      video.onprogress = null;
      video.onended = null;
      video.onerror = null;
      setVideoVisible(video, false);
      if (state.videoSourceUrl) {
        try { video.removeAttribute('src'); } catch (error) { noop(); }
        state.videoSourceUrl = null;
        try { if (isFn(video.load)) video.load(); } catch (error) { noop(); }
      }
    }
    function removeElement() {
      if (state.element === state.videoElement) clearVideoSource(state.videoElement);
      else removeImage(state.element);
      state.element = null;
    }
    function cancelPendingImage() {
      if (!state.pendingImage) return;
      removeImage(state.pendingImage);
      if (state.pendingImageUrl && state.pendingImageUrl !== state.objectUrl) releaseObjectUrl(state.pendingImageUrl);
      state.pendingImage = null;
      state.pendingImageUrl = null;
    }
    function objectUrl(blob) {
      var urlApi = win.URL || win.webkitURL;
      if (!urlApi || !isFn(urlApi.createObjectURL)) return null;
      try { return urlApi.createObjectURL(blob); } catch (error) { return null; }
    }
    function armStall(reason) {
      if (stallTimer) win.clearTimeout(stallTimer);
      stallTimer = win.setTimeout(function () {
        log('stall_watchdog', { reason: reason });
        notice('تأخر تشغيل الوسيط؛ سيتم الانتقال إلى العنصر التالي.');
        advance();
      }, watchdogMs);
    }
    function advance() {
      state.index += 1;
      render();
    }
    function advanceLater(delayMs) {
      if (imageTimer) win.clearTimeout(imageTimer);
      imageTimer = win.setTimeout(function () { advance(); }, delayMs || 1200);
    }
    function isAutoplayBlocked(error) {
      var name = error && error.name ? String(error.name) : '';
      var text = error && error.message ? String(error.message).toLowerCase() : '';
      return name === 'NotAllowedError' || name === 'SecurityError'
        || text.indexOf('user gesture') !== -1 || text.indexOf('not allowed') !== -1
        || text.indexOf('user interaction') !== -1;
    }
    function reportAudioBlocked(error) {
      state.audioBlocked = true;
      log('audio_gesture_required', { name: error && error.name ? String(error.name) : 'play_rejected' });
      onAudioBlocked(error || null);
    }
    function tryPlay(video, generation) {
      if (!video || generation !== state.playbackGeneration || !isFn(video.play)) return;
      var result;
      try {
        video.muted = false;
        video.defaultMuted = false;
        video.removeAttribute('muted');
        video.volume = 1;
        result = video.play();
      } catch (error) {
        if (isAutoplayBlocked(error)) reportAudioBlocked(error);
        else log('video_play_failed', { message: message(error, 'play failed') });
        return;
      }
      if (result && isFn(result.then)) {
        result.then(function () {
          if (generation === state.playbackGeneration) {
            state.audioBlocked = false;
            onAudioReady();
          }
        }, function (error) {
          if (generation !== state.playbackGeneration) return;
          if (isAutoplayBlocked(error)) reportAudioBlocked(error);
          else log('video_play_failed', { message: message(error, 'play failed') });
        });
      }
    }
    function activateVideo(item, source, video, generation) {
      if (generation !== state.playbackGeneration) return;
      if (state.element && state.element !== video) {
        if (state.element === state.videoElement) clearVideoSource(state.videoElement);
        else removeImage(state.element);
      }
      var oldUrl = state.objectUrl;
      state.element = video;
      state.source = source;
      state.objectUrl = source.objectUrl || null;
      state.mounted = true;
      state.mountedHash = item.hash;
      state.mountedKind = item.kind;
      setVideoVisible(video, true);
      if (oldUrl && oldUrl !== state.objectUrl) releaseObjectUrl(oldUrl);
      onItem(item, source);
      onState({ item: item, source: source.kind, index: state.index, playlistId: state.playlistId });
    }

    function mount(item, source) {
      clearTimers();
      cancelPendingImage();
      state.mounted = false;
      var generation = state.playbackGeneration + 1;
      state.playbackGeneration = generation;
      if (item.kind === 'video') renderVideo(item, source, generation);
      else renderImage(item, source, generation);
    }

    function renderImage(item, source, generation) {
      var img = doc.createElement('img');
      img.className = 'sp-media';
      img.setAttribute('alt', '');
      img.setAttribute('draggable', 'false');
      img.style.display = 'none';
      img.style.visibility = 'hidden';
      img.style.opacity = '1';
      img.style.filter = 'none';
      img.style.webkitFilter = 'none';
      img.onload = function () {
        if (generation !== state.playbackGeneration || state.pendingImage !== img) {
          removeImage(img);
          if (source.objectUrl && source.objectUrl !== state.objectUrl) releaseObjectUrl(source.objectUrl);
          return;
        }
        var previousUrl = state.objectUrl;
        if (state.element && state.element !== img) {
          if (state.element === state.videoElement) clearVideoSource(state.videoElement);
          else removeImage(state.element);
        }
        img.style.display = 'block';
        img.style.visibility = 'visible';
        state.element = img;
        state.pendingImage = null;
        state.pendingImageUrl = null;
        state.source = source;
        state.objectUrl = source.objectUrl || null;
        state.mounted = true;
        state.mountedHash = item.hash;
        state.mountedKind = item.kind;
        if (previousUrl && previousUrl !== state.objectUrl) releaseObjectUrl(previousUrl);
        if (stallTimer) { win.clearTimeout(stallTimer); stallTimer = null; }
        var duration = Number(item.durationMs);
        if (!isFinite(duration) || duration < 1000) duration = imageDurationDefaultMs;
        if (duration > 86400000) duration = 86400000;
        if (imageTimer) win.clearTimeout(imageTimer);
        imageTimer = win.setTimeout(function () { advance(); }, duration);
        onItem(item, source);
        onState({ item: item, source: source.kind, index: state.index, playlistId: state.playlistId });
      };
      img.onerror = function () { handleMediaFailure(item, source, 'image', img, generation); };
      state.pendingImage = img;
      state.pendingImageUrl = source.objectUrl || null;
      img.src = source.url;
      stage.appendChild(img);
      armStall('image');
    }

    function renderVideo(item, source, generation) {
      var video = createVideoElement();
      if (state.element !== video) setVideoVisible(video, false);
      video.setAttribute('autoplay', 'autoplay');
      video.setAttribute('playsinline', 'playsinline');
      video.setAttribute('webkit-playsinline', 'webkit-playsinline');
      video.setAttribute('preload', 'auto');
      video.controls = false;
      video.muted = false;
      video.defaultMuted = false;
      video.removeAttribute('muted');
      video.volume = 1;
      if (item.loop) video.setAttribute('loop', 'loop');
      else video.removeAttribute('loop');
      video.oncanplay = function () {
        if (generation !== state.playbackGeneration) return;
        activateVideo(item, source, video, generation);
        armStall('video');
        tryPlay(video, generation);
      };
      video.onplaying = function () {
        if (generation !== state.playbackGeneration) return;
        activateVideo(item, source, video, generation);
        state.audioBlocked = false;
        onAudioReady();
        armStall('video');
      };
      video.ontimeupdate = function () { if (generation === state.playbackGeneration) armStall('video'); };
      video.onprogress = function () { if (generation === state.playbackGeneration) armStall('video'); };
      video.onended = function () {
        if (generation !== state.playbackGeneration) return;
        if (item.loop) {
          try { video.currentTime = 0; tryPlay(video, generation); return; } catch (error) { /* advance if repeat failed */ }
        }
        advance();
      };
      video.onerror = function () { handleMediaFailure(item, source, 'video', video, generation); };
      if (state.videoSourceUrl !== source.url) {
        try { video.pause(); } catch (error) { noop(); }
        video.src = source.url;
        state.videoSourceUrl = source.url;
        try { if (isFn(video.load)) video.load(); } catch (error) { noop(); }
      }
      armStall('video');
      tryPlay(video, generation);
    }

    function handleMediaFailure(item, source, kind, failedElement, generation) {
      if (generation !== state.playbackGeneration) return;
      log('media_error', { hash: safeString(item.hash, 12), kind: kind, source: source && source.kind });
      if (failedElement && failedElement !== state.element) {
        if (failedElement === state.pendingImage) {
          removeImage(failedElement);
          state.pendingImage = null;
          state.pendingImageUrl = null;
        }
      } else if (failedElement === state.videoElement) {
        clearVideoSource(state.videoElement);
        state.element = null;
      } else if (failedElement) {
        removeImage(failedElement);
        state.element = null;
      }
      clearTimers();
      state.mounted = false;
      state.mountedHash = null;
      state.mountedKind = null;
      state.source = null;
      if (source && source.kind === 'local' && !networkRetry[item.hash]) {
        networkRetry[item.hash] = true;
        if (source.objectUrl && source.objectUrl !== state.objectUrl) releaseObjectUrl(source.objectUrl);
        if (source.objectUrl === state.objectUrl) revokeCurrent();
        notice('تعذر قراءة الوسيط المحلي؛ ستتم محاولة التشغيل من الشبكة.');
        return resolveNetworkSource(item).then(function (networkSource) {
          if (networkSource) { mount(item, networkSource); return; }
          notice('تعذر التشغيل من الشبكة أيضاً؛ الانتقال إلى العنصر التالي…');
          advanceLater(1200);
        }, function () { advanceLater(1200); });
      }
      if (source && source.objectUrl && source.objectUrl !== state.objectUrl) releaseObjectUrl(source.objectUrl);
      notice(kind === 'video' ? 'تعذر تشغيل الفيديو؛ الانتقال إلى العنصر التالي…' : 'تعذر عرض الصورة؛ الانتقال إلى العنصر التالي…');
      advanceLater(1200);
    }

    function resolveLocalSource(item) {
      return storage.getAssetBlob(item.hash).then(function (blob) {
        if (!blob) return null;
        var url = objectUrl(blob);
        if (!url) return null;
        return { kind: 'local', url: url, objectUrl: url, mimeType: item.mimeType };
      }, function () { return null; });
    }

    function bufferedNetworkSource(item) {
      if (!http || !sync) return P.resolve(null);
      var limit = options.maxBufferedBytes || MAX_FULL_BUFFER_BYTES;
      if (Number(item.size) > limit) return P.resolve(null);
      return http.request({
        method: 'GET', url: sync.sameOriginUrl(item.mediaId), responseType: 'arraybuffer', timeoutMs: 180000,
        headers: { Authorization: options.token ? 'Bearer ' + options.token : null }
      }).then(function (response) {
        if (!response.ok || !response.bytes || !isFn(win.Blob)) return null;
        var blob = new win.Blob([response.bytes], { type: item.mimeType || 'application/octet-stream' });
        var url = objectUrl(blob);
        if (!url) return null;
        return { kind: 'network-buffered', url: url, objectUrl: url, mimeType: item.mimeType };
      }, function () { return null; });
    }

    function resolveNetworkSource(item) {
      if (!item.mediaId || !sync) return P.resolve(null);
      return sync.mediaUrl(item.mediaId).then(function (signed) {
        if (signed) return { kind: 'network', url: signed, mimeType: item.mimeType };
        return bufferedNetworkSource(item);
      }, function () { return bufferedNetworkSource(item); });
    }

    function discardSource(source) {
      if (source && source.objectUrl && source.objectUrl !== state.objectUrl) releaseObjectUrl(source.objectUrl);
    }

    function render() {
      state.renderRequest += 1;
      var requestId = state.renderRequest;
      if (!state.manifest || !state.playlistId) {
        cancelPendingImage();
        removeElement();
        revokeCurrent();
        clearTimers();
        state.mounted = false;
        state.mountedHash = null;
        state.mountedKind = null;
        state.item = null;
        state.source = null;
        onState({ item: null, index: 0, playlistId: state.playlistId });
        return;
      }
      var current = activeItem(state.manifest, state.playlistId, state.index);
      if (!current) {
        cancelPendingImage();
        removeElement();
        revokeCurrent();
        clearTimers();
        state.mounted = false;
        state.mountedHash = null;
        state.mountedKind = null;
        state.item = null;
        state.source = null;
        onState({ item: null, index: 0, playlistId: state.playlistId });
        return;
      }
      var item = current.item;
      state.index = current.index;
      if (state.mounted && state.mountedHash === item.hash && state.mountedKind === item.kind && state.source
        && state.source.objectUrl && (state.source.kind === 'local' || state.source.kind === 'network-buffered')) {
        state.item = item;
        mount(item, state.source);
        return;
      }
      state.item = item;
      resolveLocalSource(item).then(function (localSource) {
        if (requestId !== state.renderRequest) { discardSource(localSource); return; }
        if (localSource) { mount(item, localSource); return; }
        return resolveNetworkSource(item).then(function (networkSource) {
          if (requestId !== state.renderRequest) { discardSource(networkSource); return; }
          if (networkSource) { mount(item, networkSource); return; }
          notice('لا توجد نسخة محلية من الوسيط ولا اتصال متاح. سيتم تجاوز العنصر.');
          advanceLater(1500);
        });
      }, function (error) {
        if (requestId !== state.renderRequest) return;
        log('local_source_failed', { code: errorCode(error) });
        notice('تعذر فتح الوسيط المحلي؛ الانتقال إلى العنصر التالي…');
        advanceLater(1200);
      });
    }

    function enableAudio() {
      var video = state.videoElement;
      if (!video) return P.resolve(false);
      var result;
      try {
        video.muted = false;
        video.defaultMuted = false;
        video.removeAttribute('muted');
        video.volume = 1;
        result = isFn(video.play) ? video.play() : null;
      } catch (error) {
        if (isAutoplayBlocked(error)) reportAudioBlocked(error);
        return P.resolve(false);
      }
      var succeeded = !result || !isFn(result.then) ? P.resolve(true) : P.resolve(result).then(function () { return true; }, function (error) {
        if (isAutoplayBlocked(error)) reportAudioBlocked(error);
        return false;
      });
      return succeeded.then(function (ok) {
        if (!ok) return false;
        state.audioEnabled = true;
        state.audioBlocked = false;
        return P.resolve(storage && isFn(storage.setAudioEnabled) ? storage.setAudioEnabled(true) : true).then(function () {
          onAudioReady();
          return true;
        }, function () {
          onAudioReady();
          return true;
        });
      });
    }

    return {
      setManifest: function (manifest) {
        state.manifest = manifest;
        if (!state.playlistId) state.playlistId = scheduledPlaylistId(win, manifest, new Date());
        return state;
      },
      setPlaylist: function (playlistId) {
        if (!playlistId) return state;
        if (state.playlistId !== playlistId) {
          state.playlistId = playlistId;
          state.index = 0;
        }
        return state;
      },
      playlistId: function () { return state.playlistId; },
      index: function () { return state.index; },
      currentItem: function () { return state.item; },
      currentSource: function () { return state.source; },
      isMounted: function () { return state.mounted; },
      enableAudio: enableAudio,
      jump: function (index) { state.index = Number(index) || 0; render(); },
      advance: advance,
      render: render,
      stop: function () {
        state.renderRequest += 1;
        state.playbackGeneration += 1;
        clearTimers();
        cancelPendingImage();
        removeElement();
        revokeCurrent();
        if (state.videoElement && state.videoElement.parentNode) {
          try { state.videoElement.parentNode.removeChild(state.videoElement); } catch (error) { noop(); }
        }
        state.videoElement = null;
        state.videoSourceUrl = null;
        state.item = null;
        state.source = null;
        state.mounted = false;
        state.mountedHash = null;
        state.mountedKind = null;
      }
    };
  }

  /* ---------------------------------------------------------------------------------------------
   * 8. Pairing, heartbeat and diagnostics
   * ------------------------------------------------------------------------------------------ */

  function deviceInfo(win) {
    var nav = (win && win.navigator) || {};
    return {
      userAgent: safeString(nav.userAgent, 500),
      platform: safeString(nav.platform || 'browser', 120),
      screenWidth: (win && win.screen && win.screen.width) || 0,
      screenHeight: (win && win.screen && win.screen.height) || 0,
      language: safeString(nav.language || '', 30)
    };
  }

  function normalizePairCode(code) {
    return safeString(code, 32).replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  }

  function pairScreen(win, http, storage, code) {
    var P = resolvePromise(null, win);
    var normalized = normalizePairCode(code);
    if (normalized.length !== 8) return P.reject(PlayerError('أدخل الرمز المكوّن من 8 أحرف.', 'invalid_pairing_code'));
    return http.request({
      method: 'POST', url: '/api/player/pair', responseType: 'text',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: normalized, deviceInfo: deviceInfo(win) }),
      timeoutMs: 30000
    }).then(function (response) {
      var payload = null;
      try { payload = response.json(); } catch (error) { payload = null; }
      if (!response.ok) throw PlayerError((payload && payload.error) || 'تعذر ربط الشاشة. تحقق من الرمز والاتصال.', 'pairing_failed');
      if (!payload || typeof payload.credential !== 'string') throw PlayerError('استجابة الربط غير صالحة.', 'pairing_failed');
      return storage.setCredential(payload.credential).then(function () {
        return { credential: payload.credential, screen: payload.screen || null };
      });
    }, function (error) {
      throw PlayerError('تعذر الوصول إلى الخادم. تحقق من اتصال التلفاز بالإنترنت.', 'network_offline', errorCode(error));
    });
  }

  function sendHeartbeat(http, token, payload) {
    return http.request({
      method: 'POST', url: '/api/player/heartbeat', responseType: 'text',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(payload),
      timeoutMs: 20000
    });
  }

  function collectDiagnostics(win, info) {
    var caps = detectCapabilities(win);
    var lines = [];
    lines.push('الرابط: ' + safeString(win.location && win.location.href, 200));
    lines.push('المتصفح: ' + (caps.userAgent || 'غير معروف'));
    lines.push('Chromium: ' + (caps.chromium === null ? 'غير معروف' : caps.chromium));
    lines.push('webOS: ' + (caps.webos.detected ? (caps.webos.version || 'مكتشف بدون رقم') : 'غير مكتشف'));
    lines.push('الدقة: ' + caps.screen.width + '×' + caps.screen.height);
    if (info) {
      if (info.storageBackend) lines.push('التخزين: ' + info.storageBackend);
      if (typeof info.cachedCount === 'number') lines.push('وسائط محفوظة: ' + info.cachedCount);
      if (info.lastSyncAt) lines.push('آخر مزامنة: ' + info.lastSyncAt);
      if (info.lastError) lines.push('آخر خطأ: ' + info.lastError);
      if (info.notes && info.notes.length) lines.push('ملاحظات: ' + info.notes.join(' · '));
    }
    return { capabilities: caps, features: capabilitiesForReport(caps), lines: lines };
  }

  return {
    VERSION: VERSION,
    DB_NAME: DB_NAME,
    DEFAULT_CHUNK_SIZE: DEFAULT_CHUNK_SIZE,
    MAX_FULL_BUFFER_BYTES: MAX_FULL_BUFFER_BYTES,
    detectCapabilities: detectCapabilities,
    capabilitiesForReport: capabilitiesForReport,
    detectWebOs: detectWebOs,
    detectChromium: detectChromium,
    createStorage: createStorage,
    createHttp: createHttp,
    createSync: createSync,
    createEngine: createEngine,
    resolveSha: resolveSha,
    createHasher: createHasher,
    readBlobBytes: readBlobBytes,
    sliceBytes: sliceBytes,
    bytesToHex: bytesToHex,
    toUint8: toUint8,
    scheduledPlaylistId: scheduledPlaylistId,
    activeItem: activeItem,
    timezoneOffsetMinutes: timezoneOffsetMinutes,
    deviceInfo: deviceInfo,
    normalizePairCode: normalizePairCode,
    pairScreen: pairScreen,
    sendHeartbeat: sendHeartbeat,
    collectDiagnostics: collectDiagnostics,
    PlayerError: PlayerError,
    errorCode: errorCode,
    message: message,
    extend: extend,
    resolvePromise: resolvePromise,
    MinimalPromise: MinimalPromise,
    noop: noop
  };
});
