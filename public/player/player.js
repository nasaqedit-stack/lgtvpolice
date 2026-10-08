/*
 * Signage player UI — ES5, dependency-free, webOS 3.5 safe.
 *
 * Renders the TV player: pairing form, sync progress, playback stage, status line and the
 * compatibility diagnostics screen. Every network/protocol concern lives in runtime.js.
 *
 * Guarantees:
 *   - The first paint happens synchronously and needs no modern API, so a TV without IndexedDB,
 *     fetch, AbortController, ReadableStream, native Promise or Blob URLs still shows a usable
 *     screen with a pairing form, a retry action and a diagnostics screen.
 *   - Every asynchronous step is individually guarded; a failure switches to a visible state
 *     instead of leaving a blank or frozen page, and cached media keeps playing when the network
 *     or the credential fails.
 *   - The diagnostics screen is reachable at all times (?diag=1, a click on the status line, the
 *     remote's INFO key, or automatically after a fatal error).
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
  if (root) root.SignagePlayerUI = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function (root) {
  'use strict';

  var TEXTS = {
    incompatibleTitle: 'مشغل الشاشة غير متوافق مع إصدار المتصفح الحالي',
    diagnosing: 'تشخيص حالة المشغل',
    booting: 'جارٍ تشغيل المشغل…',
    pairingTitle: 'اربط هذه الشاشة',
    pairingHelp: 'من لوحة الإدارة أنشئ شاشة، ثم أدخل رمز الربط المؤقت أدناه. بعد الربط ستُنزل الوسائط وتحفظ محلياً.',
    pairingCodeLabel: 'رمز الربط',
    pairAction: 'ربط الشاشة',
    pairing: 'جارٍ الربط…',
    pairingFoot: 'يُستخدم الرمز مرة واحدة وينتهي خلال 15 دقيقة. لا تدخل بيانات حساب المدير على التلفاز.',
    rePairTitle: 'إعادة ربط الشاشة',
    rePairHelp: 'يستمر المحتوى المخزّن محلياً أثناء إعادة الربط.',
    rePairAction: 'تأكيد الربط',
    backToPlayback: 'العودة إلى العرض',
    syncTitle: 'مزامنة المحتوى',
    syncHelp: 'يتم تنزيل الوسائط المطلوبة إلى التخزين المحلي.',
    syncFoot: 'أبقِ التلفاز متصلاً حتى يكتمل التنزيل والتحقق. لن يُفعّل المحتوى الجديد قبل اكتمال جميع الملفات.',
    noContentTitle: 'لا يوجد محتوى منشور',
    noContentHelp: 'عيّن قائمة تشغيل منشورة لهذه الشاشة أو أضف جدولاً زمنياً من لوحة الإدارة.',
    retry: 'إعادة المحاولة',
    reload: 'إعادة التحميل',
    reopenDiagnostics: 'التشخيص',
    close: 'إغلاق',
    playbackLocal: 'تشغيل محلي',
    playbackOffline: 'تشغيل محلي دون اتصال',
    screenFallback: 'الشاشة',
    storageWarning: 'تنبيه: المتصفح لم يؤكد الاحتفاظ الدائم بالتخزين.',
    browserInfo: 'معلومات المتصفح',
    capabilityInfo: 'قدرات المتصفح المكتشفة',
    supported: 'متوفر',
    unsupported: 'غير متوفر',
    statusLabel: 'الحالة',
    storageLabel: 'التخزين',
    cachedLabel: 'وسائط محفوظة محلياً',
    lastSyncLabel: 'آخر مزامنة',
    errorLabel: 'آخر خطأ',
    notesLabel: 'ملاحظات',
    eventsLabel: 'آخر الأحداث',
    lastSyncNever: 'لم تتم بعد',
    missingCritical: 'هذا المتصفح لا يدعم أي وسيلة اتصال يمكن للمشغل استخدامها.',
    pairCodeError: 'أدخل الرمز المكوّن من 8 أحرف.',
    pairingFailed: 'تعذر ربط الشاشة. تحقق من الرمز والاتصال.',
    syncFailed: 'تعذرت المزامنة.',
    unexpected: 'خطأ غير متوقع.',
    fatalReason: 'أوقف خطأ غير متوقع التشغيل الطبيعي للمشغل.',
    enableAudio: 'تشغيل الصوت',
    audioHint: 'اضغط لتفعيل صوت الفيديو.'
  };

  function createElement(doc, tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.appendChild(doc.createTextNode(String(text)));
    return node;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function logLine(entry) {
    var when = '';
    try { when = new Date(entry.at).toISOString().slice(11, 19); } catch (error) { when = ''; }
    var detail = '';
    if (entry.data) {
      try { detail = JSON.stringify(entry.data); } catch (error) { detail = ''; }
    }
    return when + ' ' + entry.event + (detail ? ' ' + detail : '');
  }

  function wantsDiagnostics(win) {
    try { return /(?:^|[?&])diag=1(?:&|$)/.test(String(win.location && win.location.search ? win.location.search : '')); }
    catch (error) { return false; }
  }

  function requestFullscreen(win) {
    try {
      var element = (win.document && win.document.documentElement) || null;
      if (!element) return;
      var call = element.requestFullscreen || element.webkitRequestFullscreen || element.mozRequestFullScreen || element.msRequestFullscreen;
      if (typeof call === 'function') {
        var result = call.call(element);
        if (result && typeof result['catch'] === 'function') result['catch'](function () { /* needs a user gesture on some TVs */ });
      }
    } catch (error) { /* fullscreen is cosmetic only */ }
  }

  function createPlayer(options) {
    var win = options.win;
    var doc = options.doc || win.document;
    var runtime = options.runtime;
    var httpFactory = options.createHttp || runtime.createHttp;
    var storageFactory = options.createStorage || runtime.createStorage;
    var syncFactory = options.createSync || runtime.createSync;
    var engineFactory = options.createEngine || runtime.createEngine;
    var P = runtime.resolvePromise(options.Promise, win);

    var caps = runtime.detectCapabilities(win);
    var log = [];
    var state = {
      phase: 'boot',
      message: TEXTS.booting,
      error: '',
      notice: '',
      progress: null,
      token: null,
      screenName: '',
      manifest: null,
      storage: null,
      stats: { usage: null, quota: null, persisted: null, backend: null, notes: [] },
      cachedCount: 0,
      lastSyncAt: null,
      pairing: false,
      pairCode: '',
      pairError: '',
      showPairForm: false,
      diagnosticsReason: '',
      online: true,
      playing: false,
      audioEnabled: false,
      audioUnlockRequired: false,
      diagnosticsOpen: false
    };
    var nodes = {};
    var storage = null;
    var http = null;
    var sync = null;
    var engine = null;
    var syncLock = false;
    var heartbeatLock = false;
    var syncTimer = null;
    var heartbeatTimer = null;
    var scheduleTimer = null;
    var reloadVersion = 0;

    function record(event, data) {
      log.push({ event: event, data: data || null, at: Date.now() });
      if (log.length > 200) log.shift();
    }

    function diagnosticInfo() {
      return {
        storageBackend: storage ? storage.backend : null,
        cachedCount: state.cachedCount,
        lastSyncAt: state.lastSyncAt,
        lastError: state.error,
        notes: (storage && storage.notes) || []
      };
    }

    /* ------------------------------------------------------------------ rendering -----------------*/

    function buildShell() {
      var host = doc.getElementById('signage-root') || doc.body;
      clearNode(host);
      var guard = doc.getElementById('signage-fatal');
      if (guard && guard.parentNode) guard.parentNode.removeChild(guard);
      var stage = createElement(doc, 'div', 'sp-stage');
      var overlay = createElement(doc, 'div', 'sp-overlay');
      var status = createElement(doc, 'div', 'sp-status');
      status.onclick = function () { openDiagnostics('manual'); };
      status.setAttribute('role', 'button');
      var audioControl = createElement(doc, 'button', 'sp-audio-control', TEXTS.enableAudio);
      audioControl.setAttribute('type', 'button');
      audioControl.setAttribute('aria-label', TEXTS.enableAudio);
      audioControl.style.display = 'none';
      audioControl.onclick = function (event) {
        if (event && event.preventDefault) event.preventDefault();
        activateAudioFromGesture();
      };
      host.appendChild(stage);
      host.appendChild(overlay);
      host.appendChild(status);
      host.appendChild(audioControl);
      nodes.host = host;
      nodes.stage = stage;
      nodes.overlay = overlay;
      nodes.status = status;
      nodes.audioControl = audioControl;
    }

    function panel(children) {
      var wrap = createElement(doc, 'div', 'sp-ui');
      var box = createElement(doc, 'div', 'sp-panel');
      box.appendChild(createElement(doc, 'div', 'sp-logo', 'ش'));
      for (var i = 0; i < children.length; i += 1) box.appendChild(children[i]);
      wrap.appendChild(box);
      return wrap;
    }

    function button(label, className, onClick) {
      var node = createElement(doc, 'button', 'sp-button' + (className ? ' ' + className : ''), label);
      node.setAttribute('type', 'button');
      node.onclick = onClick;
      return node;
    }

    function formatNumber(value, digits) {
      try {
        if (win.Intl && win.Intl.NumberFormat) return new win.Intl.NumberFormat('ar', { maximumFractionDigits: digits }).format(value);
      } catch (error) { /* Intl is optional; the fallback below is always available */ }
      var factor = Math.pow(10, digits || 0);
      return String(Math.round(Number(value) * factor) / factor);
    }

    function bytesLabel(value) {
      var mb = Number(value) / 1024 / 1024;
      if (!isFiniteNumber(mb)) return '—';
      return formatNumber(mb, 1) + ' م.ب';
    }

    function isFiniteNumber(value) {
      return typeof value === 'number' && isFinite(value);
    }

    function renderPairing(isRepair) {
      var children = [];
      children.push(createElement(doc, 'h1', null, isRepair ? TEXTS.rePairTitle : TEXTS.pairingTitle));
      children.push(createElement(doc, 'p', null, isRepair ? TEXTS.rePairHelp : TEXTS.pairingHelp));
      if (state.pairError) children.push(createElement(doc, 'div', 'sp-alert sp-alert-error', state.pairError));
      var form = createElement(doc, 'form', 'sp-form');
      var field = createElement(doc, 'div', 'sp-field');
      var label = createElement(doc, 'label', null, TEXTS.pairingCodeLabel);
      label.setAttribute('for', 'signage-pair-code');
      var input = createElement(doc, 'input');
      input.setAttribute('id', 'signage-pair-code');
      input.setAttribute('maxlength', '9');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('autocapitalize', 'characters');
      input.setAttribute('placeholder', 'ABCD-EFGH');
      input.value = state.pairCode || '';
      input.oninput = function () { state.pairCode = String(input.value || '').toUpperCase(); };
      field.appendChild(label);
      field.appendChild(input);
      form.appendChild(field);
      form.appendChild(button(state.pairing ? TEXTS.pairing : (isRepair ? TEXTS.rePairAction : TEXTS.pairAction), 'sp-primary', function (event) {
        if (event && event.preventDefault) event.preventDefault();
        submitPair();
      }));
      form.onsubmit = function (event) { if (event && event.preventDefault) event.preventDefault(); submitPair(); };
      children.push(form);
      if (isRepair) {
        children.push(button(TEXTS.backToPlayback, 'sp-secondary', function () {
          state.showPairForm = false;
          paint();
        }));
      }
      children.push(createElement(doc, 'p', 'sp-note', TEXTS.pairingFoot));
      return panel(children);
    }

    function renderSync() {
      var children = [];
      children.push(createElement(doc, 'h1', null, TEXTS.syncTitle));
      children.push(createElement(doc, 'p', null, (state.progress && state.progress.message) || state.error || TEXTS.syncHelp));
      if (state.error) children.push(createElement(doc, 'div', 'sp-alert sp-alert-warn', state.error));
      if (state.progress && state.progress.totalBytes > 0) {
        var percent = Math.min(100, Math.round((state.progress.downloadedBytes / state.progress.totalBytes) * 100));
        var track = createElement(doc, 'div', 'sp-track');
        var fill = createElement(doc, 'div', 'sp-fill');
        fill.style.width = percent + '%';
        track.appendChild(fill);
        children.push(track);
        children.push(createElement(doc, 'div', 'sp-note', percent + '% · ' + bytesLabel(state.progress.downloadedBytes) + ' من ' + bytesLabel(state.progress.totalBytes) + (state.progress.currentName ? ' · ' + state.progress.currentName : '')));
      } else if (state.cachedCount) {
        children.push(createElement(doc, 'div', 'sp-note', TEXTS.cachedLabel + ': ' + state.cachedCount));
      }
      children.push(createElement(doc, 'p', 'sp-note', TEXTS.syncFoot));
      children.push(button(TEXTS.retry, 'sp-secondary', function () { retryEverything(); }));
      children.push(button(TEXTS.reopenDiagnostics, 'sp-secondary', function () { openDiagnostics('manual'); }));
      return panel(children);
    }

    function renderNoContent() {
      var children = [];
      children.push(createElement(doc, 'h1', null, TEXTS.noContentTitle));
      children.push(createElement(doc, 'p', null, TEXTS.noContentHelp));
      children.push(button(TEXTS.retry, 'sp-primary', function () { retryEverything(); }));
      children.push(button(TEXTS.reopenDiagnostics, 'sp-secondary', function () { openDiagnostics('manual'); }));
      return panel(children);
    }

    function renderDiagnostics() {
      var wrap = createElement(doc, 'div', 'sp-ui sp-ui-diagnostics');
      var box = createElement(doc, 'div', 'sp-panel sp-panel-wide');
      var critical = caps.features.xmlHttpRequest === false && caps.features.fetch === false;
      box.appendChild(createElement(doc, 'h1', null, critical ? TEXTS.incompatibleTitle : TEXTS.diagnosing));
      if (state.diagnosticsReason) box.appendChild(createElement(doc, 'p', null, state.diagnosticsReason));
      if (critical) box.appendChild(createElement(doc, 'div', 'sp-alert sp-alert-error', TEXTS.missingCritical));

      var info = runtime.collectDiagnostics(win, diagnosticInfo());
      box.appendChild(createElement(doc, 'h2', null, TEXTS.browserInfo));
      var infoList = createElement(doc, 'div', 'sp-list');
      for (var i = 0; i < info.lines.length; i += 1) infoList.appendChild(createElement(doc, 'div', 'sp-row sp-mono', info.lines[i]));
      box.appendChild(infoList);

      box.appendChild(createElement(doc, 'h2', null, TEXTS.capabilityInfo));
      var capabilityList = createElement(doc, 'div', 'sp-list sp-list-columns');
      for (var j = 0; j < info.features.length; j += 1) {
        var feature = info.features[j];
        var row = createElement(doc, 'div', 'sp-row');
        row.appendChild(createElement(doc, 'span', 'sp-key', feature.feature));
        row.appendChild(createElement(doc, 'span', feature.supported ? 'sp-ok' : 'sp-no', feature.supported ? TEXTS.supported : TEXTS.unsupported));
        capabilityList.appendChild(row);
      }
      box.appendChild(capabilityList);

      box.appendChild(createElement(doc, 'h2', null, TEXTS.statusLabel));
      var statusList = createElement(doc, 'div', 'sp-list');
      statusList.appendChild(createElement(doc, 'div', 'sp-row', TEXTS.storageLabel + ': ' + ((storage && storage.backend) || '—')));
      statusList.appendChild(createElement(doc, 'div', 'sp-row', TEXTS.cachedLabel + ': ' + state.cachedCount));
      statusList.appendChild(createElement(doc, 'div', 'sp-row', TEXTS.lastSyncLabel + ': ' + (state.lastSyncAt || TEXTS.lastSyncNever)));
      if (state.error) statusList.appendChild(createElement(doc, 'div', 'sp-row', TEXTS.errorLabel + ': ' + state.error));
      var notes = (storage && storage.notes) || [];
      for (var n = 0; n < notes.length; n += 1) statusList.appendChild(createElement(doc, 'div', 'sp-row', TEXTS.notesLabel + ': ' + notes[n]));
      box.appendChild(statusList);

      box.appendChild(createElement(doc, 'h2', null, TEXTS.eventsLabel));
      var events = createElement(doc, 'div', 'sp-list sp-log');
      var recent = log.slice(-12);
      for (var m = 0; m < recent.length; m += 1) events.appendChild(createElement(doc, 'div', 'sp-row sp-mono', logLine(recent[m])));
      if (!recent.length) events.appendChild(createElement(doc, 'div', 'sp-row', '—'));
      box.appendChild(events);

      var actions = createElement(doc, 'div', 'sp-actions');
      actions.appendChild(button(TEXTS.retry, 'sp-primary', function () { retryEverything(); }));
      var reload = button(TEXTS.reload, 'sp-secondary', function () {
        try { win.location.reload(); } catch (error) { /* some TV browsers block reload */ }
      });
      actions.appendChild(reload);
      actions.appendChild(button(TEXTS.close, 'sp-secondary', function () {
        state.diagnosticsOpen = false;
        paint();
      }));
      box.appendChild(actions);
      wrap.appendChild(box);
      return wrap;
    }

    function renderAudioControl() {
      if (!nodes.audioControl) return;
      nodes.audioControl.style.display = state.audioUnlockRequired && state.playing && !state.showPairForm && !state.diagnosticsOpen ? 'block' : 'none';
      nodes.audioControl.textContent = TEXTS.enableAudio;
      nodes.audioControl.setAttribute('aria-label', TEXTS.enableAudio);
      nodes.audioControl.title = TEXTS.audioHint;
    }

    function activateAudioFromGesture() {
      if (!engine || typeof engine.enableAudio !== 'function') return;
      var activation;
      try { activation = engine.enableAudio(); }
      catch (error) { state.audioUnlockRequired = true; renderAudioControl(); return; }
      P.resolve(activation).then(function (enabled) {
        if (enabled) {
          state.audioEnabled = true;
          state.audioUnlockRequired = false;
          record('audio_enabled', { persisted: true });
        } else {
          state.audioUnlockRequired = true;
          record('audio_enable_failed', null);
        }
        renderAudioControl();
      }, function () {
        state.audioUnlockRequired = true;
        renderAudioControl();
      });
    }

    function renderStatusBar() {
      if (!nodes.status) return;
      nodes.status.style.display = state.playing && !state.showPairForm && !state.diagnosticsOpen ? 'none' : 'block';
      clearNode(nodes.status);
      nodes.status.appendChild(createElement(doc, 'span', 'sp-dot' + (state.online ? ' sp-dot-on' : ''), '●'));
      nodes.status.appendChild(createElement(doc, 'span', null, state.playing
        ? (state.online ? TEXTS.playbackLocal : TEXTS.playbackOffline)
        : (state.message || TEXTS.booting)));
      var name = state.screenName || (state.manifest && state.manifest.screen && state.manifest.screen.name) || '';
      if (state.playing && name) {
        nodes.status.appendChild(createElement(doc, 'span', null, '·'));
        nodes.status.appendChild(createElement(doc, 'span', null, name || TEXTS.screenFallback));
      }
      if (state.error) {
        nodes.status.appendChild(createElement(doc, 'span', null, '·'));
        nodes.status.appendChild(createElement(doc, 'span', 'sp-notice', String(state.error).slice(0, 160)));
      }
      if (state.notice) {
        nodes.status.appendChild(createElement(doc, 'span', null, '·'));
        nodes.status.appendChild(createElement(doc, 'span', 'sp-notice', state.notice));
      }
      if (state.stats && state.stats.persisted === false) {
        nodes.status.appendChild(createElement(doc, 'span', 'sp-notice', '· ' + TEXTS.storageWarning));
      }
    }

    function paint() {
      if (!nodes.overlay) return;
      clearNode(nodes.overlay);
      var hasContent = Boolean(state.manifest);
      var showOverlay = state.diagnosticsOpen || state.showPairForm || !hasContent || !state.playing;
      nodes.overlay.className = 'sp-overlay';
      nodes.overlay.style.display = showOverlay ? 'block' : 'none';
      if (state.diagnosticsOpen) {
        nodes.overlay.appendChild(renderDiagnostics());
      } else if (state.showPairForm) {
        nodes.overlay.appendChild(renderPairing(hasContent));
      } else if (!hasContent) {
        nodes.overlay.appendChild(state.phase === 'no_content' ? renderNoContent() : renderSync());
      } else if (!state.playing) {
        nodes.overlay.appendChild(renderSync());
      }
      renderStatusBar();
      renderAudioControl();
    }

    function openDiagnostics(reason) {
      if (!nodes.overlay) return;
      state.diagnosticsReason = reason === 'fatal' ? TEXTS.fatalReason : '';
      state.diagnosticsOpen = true;
      paint();
    }

    function fatal(error, code) {
      state.error = runtime.message(error, TEXTS.unexpected);
      state.phase = 'error';
      state.playing = state.playing && Boolean(state.manifest);
      record('fatal', { code: code || runtime.errorCode(error), message: String(state.error).slice(0, 200) });
      paint();
      openDiagnostics('fatal');
    }

    /* ------------------------------------------------------------------ pairing ------------------*/

    function submitPair() {
      if (state.pairing) return;
      var code = runtime.normalizePairCode(state.pairCode);
      if (code.length !== 8) {
        state.pairError = TEXTS.pairCodeError;
        state.showPairForm = true;
        paint();
        return;
      }
      state.pairing = true;
      state.pairError = '';
      requestFullscreen(win);
      paint();
      record('pair_start', null);
      runtime.pairScreen(win, http, storage, code).then(function (result) {
        state.pairing = false;
        state.token = result.credential;
        state.screenName = (result.screen && result.screen.name) || state.screenName;
        state.pairCode = '';
        state.showPairForm = false;
        state.online = true;
        record('pair_ok', { screen: state.screenName });
        attachEngine(result.credential);
        return performSync(result.credential);
      }, function (error) {
        state.pairing = false;
        state.pairError = runtime.message(error, TEXTS.pairingFailed);
        state.showPairForm = true;
        if (runtime.errorCode(error) === 'network_offline') state.online = false;
        record('pair_failed', { code: runtime.errorCode(error) });
        paint();
      });
    }

    /* ------------------------------------------------------------------ engine -------------------*/

    function attachEngine(token) {
      if (engine) {
        try { engine.stop(); } catch (error) { /* a stop failure must not block re-attachment */ }
      }
      sync = token ? syncFactory({ win: win, storage: storage, http: http, token: token, Promise: P, log: record }) : null;
      engine = engineFactory({
        win: win,
        doc: doc,
        stage: nodes.stage,
        storage: storage,
        sync: sync,
        http: http,
        token: token || null,
        Promise: P,
        audioEnabled: state.audioEnabled,
        log: record,
        onAudioBlocked: function () {
          state.audioUnlockRequired = true;
          renderAudioControl();
        },
        onAudioReady: function () {
          state.audioUnlockRequired = false;
          renderAudioControl();
        },
        onNotice: function (text) {
          state.notice = text;
          if (state.playing) renderStatusBar(); else paint();
        },
        onItem: function () {
          state.playing = true;
          if (state.phase !== 'syncing') state.phase = 'playing';
        }
      });
      if (state.manifest) {
        engine.setManifest(state.manifest);
        engine.setPlaylist(runtime.scheduledPlaylistId(win, state.manifest, new Date()));
        engine.render();
        state.playing = true;
        state.phase = 'playing';
        paint();
      }
      return engine;
    }

    /* ------------------------------------------------------------------ sync ---------------------*/

    function applyManifest(manifest) {
      if (!manifest) return null;
      state.manifest = manifest;
      state.screenName = (manifest.screen && manifest.screen.name) || state.screenName;
      state.playing = true;
      state.phase = 'playing';
      state.message = '';
      if (engine) {
        engine.setManifest(manifest);
        engine.setPlaylist(runtime.scheduledPlaylistId(win, manifest, new Date()));
        engine.render();
      }
      paint();
      var requested = manifest.commands && Number(manifest.commands.reloadVersion);
      if (requested && requested > reloadVersion) {
        reloadVersion = requested;
        return storage.setSeenReloadVersion(requested).then(function () {
          try { win.location.reload(); } catch (error) { /* offline TVs keep the cached shell running */ }
          return null;
        }, function () { return null; });
      }
      return null;
    }

    function performSync(requestedToken) {
      var token = requestedToken || state.token;
      if (!token || !storage) return P.resolve(false);
      if (syncLock) return P.resolve(false);
      syncLock = true;
      state.phase = state.manifest ? 'playing' : 'syncing';
      state.error = '';
      record('sync_start', null);
      paint();
      var activeSync = syncFactory({ win: win, storage: storage, http: http, token: token, Promise: P, log: record });
      return activeSync.run().then(function (result) {
        syncLock = false;
        state.online = true;
        state.progress = null;
        if (result.lastSyncAt) state.lastSyncAt = result.lastSyncAt;
        record('sync_ok', { changed: Boolean(result.changed) });
        return P.resolve(applyManifest(result.manifest)).then(function () {
          return refreshStorageState();
        }).then(function () { return true; });
      }, function (error) {
        syncLock = false;
        var code = runtime.errorCode(error);
        state.progress = null;
        state.error = runtime.message(error, TEXTS.syncFailed);
        record('sync_failed', { code: code, message: String(state.error).slice(0, 200) });
        if (code === 'screen_unauthorized') {
          state.token = null;
          return storage.clearCredential().then(function () {
            if (!state.manifest) { state.showPairForm = true; state.phase = 'pair'; }
            paint();
            return false;
          }, function () {
            if (!state.manifest) { state.showPairForm = true; state.phase = 'pair'; }
            paint();
            return false;
          });
        }
        if (code === 'network_offline' || code === 'screen_disabled') state.online = false;
        if (state.manifest) {
          // Cached content keeps playing through network and server failures.
          state.phase = 'playing';
          state.playing = true;
          paint();
          return P.resolve(refreshStorageState()).then(function () { return false; });
        }
        state.phase = code === 'no_published_content' ? 'no_content' : 'error';
        paint();
        return false;
      });
    }

    function refreshStorageState() {
      if (!storage) return P.resolve(true);
      return P.all([
        storage.countCachedAssets().then(function (count) { state.cachedCount = count; }, function () { return null; }),
        storage.getStats().then(function (stats) { state.stats = stats; }, function () { return null; }),
        storage.getLastSyncAt().then(function (at) { if (at) state.lastSyncAt = at; }, function () { return null; })
      ]).then(function () {
        if (state.playing) renderStatusBar(); else paint();
        return true;
      }, function () { return false; });
    }

    function retryEverything() {
      state.error = '';
      state.notice = '';
      if (!storage) {
        try { win.location.reload(); } catch (error) { /* fall through to the pairing form */ }
        return;
      }
      if (state.token) {
        performSync(state.token).then(function () { paint(); });
        return;
      }
      storage.getCredential().then(function (token) {
        if (token) {
          state.token = token;
          attachEngine(token);
          return performSync(token);
        }
        state.showPairForm = true;
        state.phase = 'pair';
        paint();
        return null;
      }, function (error) {
        fatal(error, 'storage_retry_failed');
      }).then(function () { paint(); });
    }

    /* ------------------------------------------------------------------ timers -------------------*/

    function tickSchedule() {
      if (!engine || !state.manifest) return;
      var next = runtime.scheduledPlaylistId(win, state.manifest, new Date());
      if (!next || engine.playlistId() === next) return;
      record('schedule_switch', { playlistId: next });
      engine.setPlaylist(next);
      engine.render();
    }

    function navigatorOnline() {
      try { return win.navigator.onLine !== false; } catch (error) { return true; }
    }

    function heartbeat() {
      if (!state.token || heartbeatLock || !navigatorOnline()) return;
      heartbeatLock = true;
      var item = engine ? engine.currentItem() : null;
      var playlistId = engine ? engine.playlistId() : null;
      var playlistVersion = null;
      if (state.manifest && playlistId) {
        var playlists = state.manifest.playlists || [];
        for (var i = 0; i < playlists.length; i += 1) {
          if (playlists[i].id === playlistId) { playlistVersion = Number(playlists[i].version) || null; break; }
        }
      }
      var payload = {
        currentPlaylistId: playlistId || null,
        currentPlaylistVersion: playlistVersion,
        currentItemId: item && item.id ? item.id : null,
        syncStatus: syncLock ? 'syncing' : (state.error ? 'failed' : 'ready'),
        syncError: state.error ? String(state.error).slice(0, 300) : null,
        cachedMediaCount: state.cachedCount,
        storageUsageBytes: isFiniteNumber(state.stats.usage) ? state.stats.usage : null,
        storageQuotaBytes: isFiniteNumber(state.stats.quota) ? state.stats.quota : null,
        lastSyncAt: state.lastSyncAt || null,
        deviceInfo: runtime.deviceInfo(win)
      };
      runtime.sendHeartbeat(http, state.token, payload).then(function (response) {
        heartbeatLock = false;
        if (response.status === 401) {
          state.token = null;
          return storage.clearCredential().then(function () {
            if (!state.manifest) { state.showPairForm = true; state.phase = 'pair'; }
            paint();
            return null;
          }, function () { return null; });
        }
        if (response.ok && !state.online) {
          state.online = true;
          renderStatusBar();
        }
        return null;
      }, function () {
        heartbeatLock = false;
        state.online = false;
        renderStatusBar();
      });
    }

    function startTimers() {
      if (syncTimer) win.clearInterval(syncTimer);
      if (heartbeatTimer) win.clearInterval(heartbeatTimer);
      if (scheduleTimer) win.clearInterval(scheduleTimer);
      syncTimer = win.setInterval(function () {
        if (state.token && state.online && !syncLock) performSync(state.token);
      }, 60000);
      heartbeatTimer = win.setInterval(heartbeat, 60000);
      scheduleTimer = win.setInterval(tickSchedule, 15000);
    }

    function bindEnvironment() {
      if (!win.addEventListener) return;
      win.addEventListener('online', function () {
        state.online = true;
        renderStatusBar();
        if (state.token) performSync(state.token);
      });
      win.addEventListener('offline', function () {
        state.online = false;
        renderStatusBar();
      });
      win.addEventListener('error', function (event) {
        record('window_error', { message: event && event.message ? String(event.message).slice(0, 200) : 'unknown' });
      });
      win.onunhandledrejection = function (event) {
        record('unhandled_rejection', { message: runtime.message(event && event.reason, 'unknown') });
      };
      win.addEventListener('keydown', function (event) {
        requestFullscreen(win);
        var target = event && event.target;
        var inField = target && target.tagName === 'INPUT';
        var key = event ? (event.key || event.keyCode) : null;
        if (!inField && (key === 'i' || key === 'I' || key === 457)) openDiagnostics('manual');
      }, false);
      win.addEventListener('click', function () { requestFullscreen(win); }, false);
    }

    /* ------------------------------------------------------------------ boot ---------------------*/

    function start() {
      try {
        buildShell();
        paint();
        win.__signageBooted = true;
      } catch (error) {
        record('shell_failed', { message: runtime.message(error, 'unknown') });
        return P.resolve(false);
      }
      record('boot', { chromium: caps.chromium, webos: caps.webos.version });
      bindEnvironment();
      try {
        http = httpFactory(win, { Promise: P, log: record, transport: win.__SIGNAGE_TRANSPORT__ || null });
      } catch (error) {
        fatal(error, 'http_init_failed');
        return P.resolve(false);
      }
      if (wantsDiagnostics(win)) win.setTimeout(function () { openDiagnostics('manual'); }, 0);
      var storagePromise;
      try {
        storagePromise = storageFactory(win, { Promise: P, log: record });
      } catch (error) {
        fatal(error, 'storage_init_failed');
        return P.resolve(false);
      }
      return storagePromise.then(function (adapter) {
        storage = adapter;
        state.storage = adapter;
        record('storage', { backend: adapter.backend });
        return P.all([
          adapter.getCredential(),
          adapter.getActiveManifest(),
          adapter.getStats(),
          adapter.getLastSyncAt(),
          adapter.countCachedAssets(),
          adapter.getSeenReloadVersion(),
          typeof adapter.getAudioEnabled === 'function' ? adapter.getAudioEnabled() : P.resolve(false)
        ]);
      }).then(function (values) {
        var token = values[0];
        var manifest = values[1];
        state.stats = values[2] || state.stats;
        state.lastSyncAt = values[3] || null;
        state.cachedCount = values[4] || 0;
        reloadVersion = Number(values[5]) || 0;
        state.audioEnabled = Boolean(values[6]);
        state.token = token || null;
        state.manifest = manifest || null;
        state.screenName = (manifest && manifest.screen && manifest.screen.name) || '';
        attachEngine(state.token);
        if (!state.token) {
          state.showPairForm = true;
          if (!manifest) state.phase = 'pair';
          paint();
          startTimers();
          return false;
        }
        startTimers();
        heartbeat();
        return performSync(state.token).then(function () { paint(); return true; });
      }).then(function (ready) {
        if (!ready && state.token) paint();
        return ready;
      }, function (error) {
        fatal(error, 'boot_failed');
        return false;
      });
    }

    return {
      start: start,
      state: state,
      record: record,
      paint: paint,
      openDiagnostics: openDiagnostics,
      retryEverything: retryEverything,
      engine: function () { return engine; },
      storage: function () { return storage; },
      sync: function () { return sync; },
      texts: TEXTS,
      log: function () { return log.slice(); }
    };
  }

  function autoBoot() {
    if (!root || !root.document || root.__SIGNAGE_NO_AUTOBOOT) return null;
    if (!root.SignagePlayerRuntime) return null;
    var player = createPlayer({ win: root, runtime: root.SignagePlayerRuntime });
    root.SignagePlayerInstance = player;
    try {
      player.start();
    } catch (error) {
      try { player.openDiagnostics('fatal'); } catch (inner) { /* the HTML shell guard still shows a panel */ }
    }
    return player;
  }

  if (root && root.document) {
    if (root.document.readyState === 'loading' && typeof root.document.addEventListener === 'function') {
      root.document.addEventListener('DOMContentLoaded', function () { autoBoot(); }, false);
    } else {
      autoBoot();
    }
  }

  return { create: createPlayer, TEXTS: TEXTS, autoBoot: autoBoot, requestFullscreen: requestFullscreen };
});
