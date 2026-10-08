/*
 * Signage player UI — ES5, dependency-free, webOS 3.5 safe.
 *
 * Renders the TV player: pairing form, sync progress, playback stage, status line and the
 * compatibility diagnostics screen. Every network/protocol concern lives in runtime.js.
 *
 * Guarantees:
 *   - The first paint happens synchronously and needs no modern API, so a TV without IndexedDB,
 *     fetch, AbortController, ReadableStream, native Promise or Blob URLs still shows a usable
 *     pairing or automatic-recovery screen.
 *   - Every asynchronous step is individually guarded; a failure switches to a visible state
 *     instead of leaving a blank or frozen page, and cached media keeps playing when the network
 *     or the credential fails.
 *   - Diagnostics never cover a playable local playlist; when there is no cached playlist they
 *     remain reachable from ?diag=1, the status line, INFO, or an error.
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
    syncFoot: 'سيعيد المشغل محاولة المزامنة تلقائياً. يستمر المحتوى المحلي أثناء أي انقطاع ولا يتطلب الأمر تدخلاً.',
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
    connectionLabel: 'الاتصال والاستعادة التلقائية',
    watchdogLabel: 'حالة المشغل',
    lastHeartbeatLabel: 'آخر نبضة مؤكدة',
    lastApiLabel: 'آخر اتصال ناجح',
    appliedCommandLabel: 'الأوامر المطبقة',
    recoveryLabel: 'الاستعادة',
    healthLabel: 'فحص الحالة',
    neverLabel: 'لم يحدث',
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
    rePairScreen: 'إعادة ربط الشاشة',
    unpairedNotice: 'الشاشة غير مربوطة من لوحة الإدارة؛ يستمر العرض المحلي للوسائط المحفوظة.',
    playbackLabel: 'العرض',
    playbackFromCache: 'يعرض من التخزين المحلي',
    playbackIdle: 'لا يوجد وسيط معروض الآن',
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

  function isFn(value) {
    return typeof value === 'function';
  }

  function logLine(entry) {
    var when = '';
    try { when = new Date(entry.at).toISOString().slice(11, 19); } catch (error) { when = ''; }
    var detail = '';
    if (entry.data) {
      var safe = {};
      var allowed = { code: true, reason: true, state: true, failures: true, count: true, attempt: true, kind: true, version: true, manifestVersion: true, backoffMs: true, retryInMs: true };
      for (var key in entry.data) {
        if (!Object.prototype.hasOwnProperty.call(entry.data, key) || !allowed[key]) continue;
        var value = entry.data[key];
        if (typeof value === 'string') value = value.slice(0, 60);
        if (typeof value === 'number' || typeof value === 'string' || value === null) safe[key] = value;
      }
      try { detail = JSON.stringify(safe); } catch (error) { detail = ''; }
    }
    return when + ' ' + String(entry.event || 'event').slice(0, 60) + (detail && detail !== '{}' ? ' ' + detail : '');
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
    var watchdogFactory = options.watchdog || root.SignageWatchdog || null;
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
      latestManifest: null,
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
      diagnosticsOpen: false,
      pairFormExplicit: false,
      resume: null,
      playbackInfo: null,
      emptyTicks: 0,
      syncFailures: 0,
      lastSyncAttemptAt: 0,
      lastSyncError: '',
      lastErrorCode: ''
    };
    var nodes = {};
    var storage = null;
    var http = null;
    var sync = null;
    var engine = null;
    var watchdog = null;
    var syncLock = false;
    var heartbeatLock = false;
    var syncFailures = 0;
    var syncBackoffMs = 0;
    var heartbeatFailures = 0;
    var heartbeatBackoffMs = 0;
    // A page reload is the last-resort recovery only: it is rate limited in memory, on disk and by
    // the central watchdog, so a broken television can never end up in a reload loop.
    var RECOVERY_WINDOW_MS = 600000;
    var recoveryBlockedUntil = 0;
    var reloadInFlight = false;
    // Command acknowledgement. Loaded during boot BEFORE the first synchronization can apply a
    // command, which is what makes "the same command must never run twice" true across reloads.
    var appliedSyncVersion = 0;
    var appliedReloadVersion = 0;
    var bootAt = new Date().toISOString();
    var recoveryMeta = { count: 0, lastAt: null, reason: '', state: '', reloads: 0, reinits: 0 };
    var pendingCommandSync = 0;
    var commandStateReady = false;
    var credentialReadCancelled = false;
    var backgroundStarted = false;
    var startPromise = null;
    var localStateReady = false;
    var disposed = false;
    var eventBindings = [];
    var environmentBound = false;
    var previousUnhandledRejection = win.onunhandledrejection;
    var assignedUnhandledRejection = null;
    var lastStorageRefreshAt = 0;
    var preflightedAssetHashes = {};
    var preflightedAssetOrder = [];
    var operationalRetryTimer = null;
    var operationalWarningTimer = null;

    function record(event, data) {
      log.push({ event: event, data: data || null, at: Date.now() });
      if (log.length > 500) log.shift();
    }

    /**
     * Every watchdog call is optional: the television must keep playing even if watchdog.js did not
     * load. Nothing here is allowed to throw into the playback path.
     */
    function wd(name, args) {
      if (!watchdog || typeof watchdog[name] !== 'function') return undefined;
      try { return watchdog[name].apply(watchdog, args || []); }
      catch (error) {
        record('watchdog_call_failed', { action: name, message: runtime.message(error, 'unknown').slice(0, 160) });
        return undefined;
      }
    }

    function diagnosticInfo() {
      return {
        storageBackend: storage ? storage.backend : null,
        cachedCount: state.cachedCount,
        lastSyncAt: state.lastSyncAt,
        lastError: state.lastErrorCode,
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
      host.appendChild(stage);
      host.appendChild(overlay);
      host.appendChild(status);
      nodes.host = host;
      nodes.stage = stage;
      nodes.overlay = overlay;
      nodes.status = status;
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
      children.push(createElement(doc, 'p', null, (state.progress && state.progress.message) || (state.error ? TEXTS.syncFailed : TEXTS.syncHelp)));
      if (state.error) children.push(createElement(doc, 'div', 'sp-alert sp-alert-warn', TEXTS.syncFailed));
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
      children.push(button(TEXTS.reopenDiagnostics, 'sp-secondary', function () { openDiagnostics('manual'); }));
      return panel(children);
    }

    function renderNoContent() {
      var children = [];
      children.push(createElement(doc, 'h1', null, TEXTS.noContentTitle));
      children.push(createElement(doc, 'p', null, TEXTS.noContentHelp));
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
      statusList.appendChild(createElement(doc, 'div', 'sp-row', TEXTS.playbackLabel + ': ' + (engineStageVisible() ? TEXTS.playbackFromCache : TEXTS.playbackIdle)));
      if (state.playbackInfo && state.playbackInfo.hash) {
        statusList.appendChild(createElement(doc, 'div', 'sp-row sp-mono', 'playback: ' + String(state.playbackInfo.hash).slice(0, 12) + ' · ' + (Number(state.playbackInfo.positionMs) || 0) + 'ms'));
      }
      if (state.syncFailures) statusList.appendChild(createElement(doc, 'div', 'sp-row', TEXTS.recoveryLabel + ': ' + state.syncFailures));
      if (state.error) statusList.appendChild(createElement(doc, 'div', 'sp-row', TEXTS.errorLabel + ': ' + state.error));
      var notes = (storage && storage.notes) || [];
      for (var n = 0; n < notes.length; n += 1) statusList.appendChild(createElement(doc, 'div', 'sp-row', TEXTS.notesLabel + ': ' + notes[n]));
      box.appendChild(statusList);

      // Connection and self-healing state. Everything here is derived from real server
      // communication; navigator.onLine is never used as evidence.
      box.appendChild(createElement(doc, 'h2', null, TEXTS.connectionLabel));
      var healthList = createElement(doc, 'div', 'sp-list');
      var watch = wd('snapshot', []) || {};
      function ago(value) {
        if (!value) return TEXTS.neverLabel;
        var seconds = Math.max(0, Math.round((Date.now() - Number(value)) / 1000));
        if (seconds < 60) return seconds + ' ثانية';
        if (seconds < 3600) return Math.round(seconds / 60) + ' دقيقة';
        return Math.round(seconds / 3600) + ' ساعة';
      }
      healthList.appendChild(createElement(doc, 'div', 'sp-row', TEXTS.watchdogLabel + ': ' + (watch.state || 'boot')));
      healthList.appendChild(createElement(doc, 'div', 'sp-row', TEXTS.lastHeartbeatLabel + ': ' + ago(watch.lastHeartbeatAt)));
      healthList.appendChild(createElement(doc, 'div', 'sp-row', TEXTS.lastApiLabel + ': ' + ago(watch.lastApiSuccessAt)));
      healthList.appendChild(createElement(doc, 'div', 'sp-row sp-mono', TEXTS.appliedCommandLabel + ': sync ' + appliedSyncVersion + ' · reload ' + appliedReloadVersion));
      healthList.appendChild(createElement(doc, 'div', 'sp-row', TEXTS.recoveryLabel + ': ' + (Number(watch.recoveryCount) || 0)
        + (watch.lastRecoveryReason ? ' · ' + watch.lastRecoveryReason : '') + ' · ' + ago(watch.lastRecoveryAt)));
      healthList.appendChild(createElement(doc, 'div', 'sp-row sp-mono', 'failures: ' + (Number(watch.consecutiveFailures) || 0)
        + ' · reinits: ' + (Number(watch.runtimeReinits) || 0) + ' · reloads: ' + (Number(watch.reloads) || 0)));
      if (watch.healthStatus) {
        healthList.appendChild(createElement(doc, 'div', 'sp-row sp-mono', TEXTS.healthLabel + ': ' + watch.healthStatus + ' · ' + ago(watch.healthCheckedAt)));
      }
      box.appendChild(healthList);

      box.appendChild(createElement(doc, 'h2', null, TEXTS.eventsLabel));
      var events = createElement(doc, 'div', 'sp-list sp-log');
      var recent = log.slice(-12);
      for (var m = 0; m < recent.length; m += 1) events.appendChild(createElement(doc, 'div', 'sp-row sp-mono', logLine(recent[m])));
      if (!recent.length) events.appendChild(createElement(doc, 'div', 'sp-row', '—'));
      box.appendChild(events);

      var actions = createElement(doc, 'div', 'sp-actions');
      actions.appendChild(button(TEXTS.retry, 'sp-primary', function () { retryEverything(); }));
      actions.appendChild(button(TEXTS.rePairScreen, 'sp-secondary', function () {
        // Explicit operator action: only this path may cover playing content with the pair form.
        state.pairFormExplicit = true;
        state.showPairForm = true;
        state.diagnosticsOpen = false;
        paint();
      }));
      actions.appendChild(button(TEXTS.close, 'sp-secondary', function () {
        state.diagnosticsOpen = false;
        paint();
      }));
      box.appendChild(actions);
      wrap.appendChild(box);
      return wrap;
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
        nodes.status.appendChild(createElement(doc, 'span', 'sp-notice', TEXTS.syncFailed));
      }
      if (state.notice) {
        nodes.status.appendChild(createElement(doc, 'span', null, '·'));
        nodes.status.appendChild(createElement(doc, 'span', 'sp-notice', state.notice));
      }
      if (state.stats && state.stats.persisted === false) {
        nodes.status.appendChild(createElement(doc, 'span', 'sp-notice', '· ' + TEXTS.storageWarning));
      }
    }

    /** True when the engine is showing media or is about to (a decoded image is already prepared). */
    function engineStageVisible() {
      if (!engine) return false;
      try {
        if (isFn(engine.displayStatus)) return Boolean(engine.displayStatus().healthy);
        return Boolean(isFn(engine.isMounted) && engine.isMounted()) || Boolean(isFn(engine.isPending) && engine.isPending());
      } catch (error) { return false; }
    }

    function hasPlayableContent() {
      try { return runtime.hasPlayableContent(state.manifest); } catch (error) { return Boolean(state.manifest); }
    }

    function hasLocalPlaybackState() {
      if (!hasPlayableContent()) return false;
      if (engineStageVisible()) return true;
      try { if (engine && isFn(engine.hasLocalMedia) && engine.hasLocalMedia()) return true; } catch (error) { /* use the stored count below */ }
      return Number(state.cachedCount) > 0;
    }

    /**
     * The overlay is never allowed to cover media that is on screen. It appears only when there is
     * genuinely nothing to show, or when the operator explicitly asks for the diagnostics / pairing
     * screens. Background synchronization therefore cannot dim, blank or interrupt playback.
     */
    function paint() {
      if (!nodes.overlay) return;
      clearNode(nodes.overlay);
      var hasContent = hasPlayableContent();
      var protectPlayback = hasLocalPlaybackState();
      var stageVisible = engineStageVisible();
      // Local content always has priority over operator screens, sync progress and error prompts.
      // Pairing/diagnostics remain available only when there is no playable playlist to protect.
      if (protectPlayback) state.diagnosticsOpen = false;
      var pairVisible = state.showPairForm && !protectPlayback;
      var diagnosticVisible = state.diagnosticsOpen && !protectPlayback;
      var stalled = !protectPlayback && !stageVisible && state.emptyTicks >= 2;
      var showOverlay = diagnosticVisible || pairVisible || !protectPlayback || (!state.playing && !stageVisible && !protectPlayback) || stalled;
      nodes.overlay.className = 'sp-overlay';
      nodes.overlay.style.display = showOverlay ? 'block' : 'none';
      if (diagnosticVisible) {
        nodes.overlay.appendChild(renderDiagnostics());
      } else if (pairVisible) {
        nodes.overlay.appendChild(renderPairing(hasContent));
      } else if (!protectPlayback) {
        nodes.overlay.appendChild(state.phase === 'no_content' ? renderNoContent() : renderSync());
      } else if (!protectPlayback && !state.playing && !stageVisible) {
        nodes.overlay.appendChild(renderSync());
      }
      renderStatusBar();
    }

    function openDiagnostics(reason) {
      if (!nodes.overlay) return;
      if (hasLocalPlaybackState()) {
        record('diagnostics_suppressed_for_playback', { reason: reason || 'manual' });
        state.diagnosticsOpen = false;
        return;
      }
      state.diagnosticsReason = reason === 'fatal' ? TEXTS.fatalReason : '';
      state.diagnosticsOpen = true;
      paint();
    }

    function fatal(error, code) {
      state.lastErrorCode = code || runtime.errorCode(error);
      state.error = TEXTS.unexpected;
      state.phase = 'error';
      record('fatal', { code: state.lastErrorCode });
      paint();
      // A failure must never replace media that is already playing with an error screen: the
      // diagnostics panel is only opened when there is nothing on the screen to protect.
      if (!engineStageVisible() && !state.playing) openDiagnostics('fatal');
    }

    /* ------------------------------------------------------------------ pairing ------------------*/

    function submitPair() {
      if (disposed || state.pairing) return;
      var code = runtime.normalizePairCode(state.pairCode);
      if (code.length !== 8) {
        state.pairError = TEXTS.pairCodeError;
        state.showPairForm = true;
        paint();
        return;
      }
      state.pairing = true;
      credentialReadCancelled = true;
      state.pairError = '';
      requestFullscreen(win);
      paint();
      record('pair_start', null);
      runtime.pairScreen(win, http, storage, code).then(function (result) {
        if (disposed) return false;
        state.pairing = false;
        state.token = result.credential;
        state.screenName = (result.screen && result.screen.name) || state.screenName;
        state.pairCode = '';
        state.showPairForm = false;
        state.pairFormExplicit = false;
        state.online = false;
        state.phase = state.manifest && hasPlayableContent() ? 'playing' : 'syncing';
        record('pair_ok', { screen: state.screenName });
        attachEngine(result.credential);
        startAuthenticatedWork('pair');
        paint();
        return true;
      }, function (error) {
        if (disposed) return null;
        state.pairing = false;
        state.pairError = TEXTS.pairingFailed;
        state.lastErrorCode = runtime.errorCode(error);
        state.showPairForm = true;
        if (runtime.errorCode(error) === 'network_offline') state.online = false;
        record('pair_failed', { code: runtime.errorCode(error) });
        paint();
      });
    }

    /* ------------------------------------------------------------------ engine -------------------*/

    /** Options shared by every sync instance so garbage collection always protects live media. */
    function syncOptions(token) {
      return {
        win: win, storage: storage, http: http, token: token, Promise: P, log: record,
        deferActivation: true,
        preflightAsset: function (asset) {
          if (!asset || !asset.hash) return P.resolve(false);
          if (preflightedAssetHashes[asset.hash]) return P.resolve(true);
          var prepared;
          try {
            if (isFn(win.__SIGNAGE_PREFLIGHT_ASSET__)) prepared = win.__SIGNAGE_PREFLIGHT_ASSET__(asset);
            else if (isFn(runtime.preflightAsset)) prepared = runtime.preflightAsset(win, storage, asset, { Promise: P });
            else prepared = P.resolve(true);
          } catch (error) { return P.reject(error); }
          return P.resolve(prepared).then(function (ok) {
            if (ok === false) return false;
            preflightedAssetHashes[asset.hash] = true;
            preflightedAssetOrder.push(asset.hash);
            while (preflightedAssetOrder.length > 1000) delete preflightedAssetHashes[preflightedAssetOrder.shift()];
            return true;
          });
        },
        protectHashes: function () {
          try { return engine && isFn(engine.protectedHashes) ? engine.protectedHashes() : []; }
          catch (error) { return []; }
        },
        onProgress: function (payload) {
          state.progress = payload;
          // Never repaint while media is on screen: synchronization must not touch the picture.
          if (!state.playing) paint();
        }
      };
    }

    function persistPlaybackState(info) {
      state.playbackInfo = info || state.playbackInfo;
      if (!storage || !isFn(storage.setPlaybackState) || !state.playbackInfo) return;
      try { storage.setPlaybackState(state.playbackInfo); } catch (error) { /* never fatal */ }
    }

    function attachEngine(token) {
      state.token = token || null;
      try { sync = state.token && http ? syncFactory(syncOptions(state.token)) : null; }
      catch (error) { sync = null; record('sync_init_failed_nonblocking', { code: runtime.errorCode(error) }); }
      // Re-pairing or transport recovery updates the existing engine in place. Replacing it used to
      // tear down the active element and duplicate its media handlers during a reconnect.
      if (engine) {
        try { if (isFn(engine.setNetwork)) engine.setNetwork(sync, http, state.token); }
        catch (error) { record('engine_network_update_failed', { code: runtime.errorCode(error) }); }
        wd('setHasCredential', [Boolean(state.token && http && commandStateReady)]);
        return engine;
      }
      wd('setHasCredential', [Boolean(state.token && http && commandStateReady)]);
      engine = engineFactory({
        win: win,
        doc: doc,
        stage: nodes.stage,
        storage: storage,
        sync: sync,
        http: http,
        token: state.token,
        Promise: P,
        audioEnabled: state.audioEnabled,
        resume: state.resume || null,
        log: record,
        onNotice: function (text) {
          state.notice = text;
          if (state.playing) renderStatusBar(); else paint();
        },
        onItem: function () {
          state.playing = true;
          if (state.phase !== 'syncing') state.phase = 'playing';
          wd('markProgress', []);
          paint();
        },
        onProgress: function (info) {
          persistPlaybackState(info);
          wd('markProgress', []);
        },
        onRecoveryExhausted: function (info) {
          record('recovery_exhausted', info || null);
          wd('noteError', ['playback_recovery_exhausted']);
          if (engine && isFn(engine.advance)) engine.advance();
        }
      });
      if (state.manifest && hasPlayableContent()) {
        // Priority: cached manifest -> cached media -> playback. No network request is awaited
        // before this call, so the first frame never depends on Vercel, Supabase or auth.
        engine.setManifest(state.manifest);
        engine.setPlaylist(runtime.scheduledPlaylistId(win, state.manifest, new Date()));
        engine.render();
        state.playing = true;
        state.phase = 'playing';
      } else {
        state.playing = false;
      }
      paint();
      return engine;
    }

    /* ------------------------------------------------------------------ watchdog ----------------*/

    /** Is the stage showing (or about to show) something? Empty is only a fault when it should. */
    function runtimeStatus() {
      var playable = hasPlayableContent();
      if (!engine || !state.manifest || !playable) {
        // Nothing is supposed to be on screen: an empty stage is not an application failure.
        return { healthy: true, hasLocal: false, playable: playable };
      }
      var visible = false;
      try { visible = engineStageVisible(); } catch (error) { visible = false; }
      var hasLocal = false;
      try { hasLocal = isFn(engine.hasLocalMedia) ? Boolean(engine.hasLocalMedia()) : false; } catch (error) { hasLocal = false; }
      return { healthy: visible, hasLocal: hasLocal, playable: true };
    }

    /**
     * Rebuilds the runtime in place. This is the rung below a controlled page reload and above a
     * plain retry: it never blanks a screen that is currently showing cached media.
     */
    function reinitRuntime(reason) {
      record('runtime_reinit', { reason: String(reason || 'unknown').slice(0, 60) });
      try {
        // Rebuild the transport: a wedged XHR/fetch stack cannot be repaired any other way.
        http = httpFactory(win, { Promise: P, log: record, transport: win.__SIGNAGE_TRANSPORT__ || null });
      } catch (error) {
        http = null;
        record('runtime_reinit_http_failed', { code: runtime.errorCode(error) });
      }
      try { sync = state.token && http ? syncFactory(syncOptions(state.token)) : null; } catch (error) { sync = null; }
      if (!engine) { attachEngine(state.token); return; }
      try { if (isFn(engine.setNetwork)) engine.setNetwork(sync, http, state.token); } catch (error) { record('runtime_reinit_engine_network_failed', { code: runtime.errorCode(error) }); }
      try { if (isFn(engine.ensurePlaying)) engine.ensurePlaying(); } catch (error) { record('runtime_reinit_ensure_failed', { code: runtime.errorCode(error) }); }
      if (reason === 'watchdog_empty_stage' || reason === 'watchdog_runtime_unrecoverable') {
        // The stage is empty although local media exists: re-arm the local playlist.
        if (isFn(engine.recover)) engine.recover(reason);
        else engine.render();
      } else {
        try { engine.render(); } catch (error) { record('runtime_reinit_render_failed', { message: runtime.message(error, 'unknown').slice(0, 160) }); }
      }
      if (reason !== 'reload_command') {
        syncLock = false;
        heartbeatLock = false;
      }
    }

    /** Drops anything that can no longer succeed: locks and the transport that owns pending calls. */
    function abortStale(reason) {
      record('abort_stale', { reason: String(reason || 'unknown').slice(0, 60) });
      syncLock = false;
      heartbeatLock = false;
      try {
        http = httpFactory(win, { Promise: P, log: record, transport: win.__SIGNAGE_TRANSPORT__ || null });
      } catch (error) { record('abort_stale_http_failed', { code: runtime.errorCode(error) }); }
      try { sync = state.token && http ? syncFactory(syncOptions(state.token)) : null; } catch (error) { sync = null; }
      try { if (engine && isFn(engine.setNetwork)) engine.setNetwork(sync, http, state.token); } catch (error) { record('abort_stale_engine_network_failed', { code: runtime.errorCode(error) }); }
    }

    function resetBeatLock(reason) {
      heartbeatLock = false;
      record('beat_lock_released', { reason: String(reason || 'unknown').slice(0, 60) });
    }
    function resetSyncLock(reason) {
      syncLock = false;
      record('sync_lock_released', { reason: String(reason || 'unknown').slice(0, 60) });
    }

    /**
     * The daily (and first-startup) self-check. It verifies the whole chain the administrator cares
     * about and reports one safe operational code. It never touches the picture.
     */
    function healthCheck(when) {
      var problems = [];
      if (!storage) problems.push('no_storage');
      if (!state.token) problems.push('no_credential');
      if (!http) problems.push('no_transport');
      if (!state.manifest) problems.push('no_manifest');
      else if (!hasPlayableContent()) problems.push('no_content');
      if (snapRecoveryState() === 'auth_error') problems.push('auth_error');
      if (snapRecoveryState() === 'config_error') problems.push('config_error');
      var snap = wd('snapshot', []) || {};
      if (snap.lastHeartbeatAt && Date.now() - snap.lastHeartbeatAt > 5 * 60 * 1000) problems.push('heartbeat_stale');
      if (snap.consecutiveFailures > 0) problems.push('pending_failures');
      if (pendingCommandSync > 0) problems.push('command_pending');
      if (!runtimeStatus().healthy) problems.push('stage_empty');
      if (storage && storage.backend === 'memory') problems.push('volatile_storage');
      var status = problems.length ? 'degraded:' + problems.slice(0, 6).join(',') : 'ok';
      wd('setHealthStatus', [status]);
      record('health_check', { when: String(when || 'scheduled'), status: status });
      if (problems.length) {
        // A degraded self-check is a legitimate reason to prove connectivity again right now.
        wd('requestRecovery', ['health_check_' + problems[0]]);
      }
      return status;
    }

    function snapRecoveryState() {
      var snap = wd('snapshot', []) || {};
      return snap.state || 'boot';
    }

    function persistRecoveryMeta(reason) {
      if (!storage || !isFn(storage.setRecoveryMeta)) return;
      var snap = wd('snapshot', []) || {};
      recoveryMeta = {
        count: Number(snap.recoveryCount) || 0,
        lastAt: snap.lastRecoveryAt ? new Date(snap.lastRecoveryAt).toISOString() : null,
        reason: String(reason || snap.lastRecoveryReason || '').slice(0, 60),
        state: String(snap.state || '').slice(0, 40),
        reloads: Number(snap.reloads) || 0,
        reinits: Number(snap.runtimeReinits) || 0
      };
      try { storage.setRecoveryMeta(recoveryMeta); } catch (error) { record('recovery_meta_failed', { message: runtime.message(error, 'unknown').slice(0, 160) }); }
    }

    function persistCommandState() {
      if (!storage || !isFn(storage.setCommandState)) return P.resolve(false);
      try {
        return P.resolve(storage.setCommandState({ appliedSyncVersion: appliedSyncVersion, appliedReloadVersion: appliedReloadVersion })).then(function (saved) {
          return saved !== false;
        }, function (error) {
          record('command_state_persist_failed', { code: runtime.errorCode(error) });
          return false;
        });
      } catch (error) {
        record('command_state_persist_failed', { code: runtime.errorCode(error) });
        return P.resolve(false);
      }
    }

    function setupWatchdog() {
      if (!watchdogFactory || !isFn(watchdogFactory.create)) {
        record('watchdog_missing', null);
        return false;
      }
      try {
        watchdog = watchdogFactory.create({
          win: win,
          log: record,
          timing: options.watchdogTiming || null,
          actions: {
            beat: function (reason) {
              try { heartbeat(reason); }
              catch (error) { heartbeatFailed(0, runtime.errorCode(error)); }
            },
            sync: function (reason) {
              if (!state.token || !commandStateReady) { wd('scheduleSync', [15000]); return; }
              performSync(state.token).then(null, function () { wd('noteSyncFailure', ['sync_internal_error']); });
            },
            housekeeping: function () {
              try { tickSchedule(); } catch (error) { record('schedule_failed', { message: runtime.message(error, 'unknown') }); }
              ensurePlaybackAlive();
            },
            runtimeStatus: runtimeStatus,
            reinitRuntime: reinitRuntime,
            abortStale: abortStale,
            resetBeat: resetBeatLock,
            resetSync: resetSyncLock,
            reload: function (reason) { return reloadNow(reason); },
            healthCheck: healthCheck,
            onResume: function (reason) { restorePlayback(reason); },
            onState: function (next, previous, snapshot) {
              record('player_state', { state: next, from: previous, failures: snapshot.consecutiveFailures });
              // The status line is the only visible surface; it never covers media.
              if (state.playing) renderStatusBar();
              if (next === 'recovering' || next === 'controlled_reload') persistRecoveryMeta(snapshot.lastRecoveryReason || next);
            }
          }
        });
      } catch (error) {
        watchdog = null;
        record('watchdog_init_failed', { message: runtime.message(error, 'unknown').slice(0, 160) });
        return false;
      }
      watchdog.start();
      record('watchdog_started', { version: watchdogFactory.STATES ? 'ok' : 'unknown' });
      return true;
    }

    /* ------------------------------------------------------------------ sync ---------------------*/

    function samePlaybackContent(first, second) {
      if (!first || !second || !first.screen || !second.screen || first.screen.id !== second.screen.id) return false;
      if (first.defaultPlaylistId !== second.defaultPlaylistId || first.screen.timezone !== second.screen.timezone) return false;
      var firstPlaylists = first.playlists || [];
      var secondPlaylists = second.playlists || [];
      if (firstPlaylists.length !== secondPlaylists.length) return false;
      for (var i = 0; i < firstPlaylists.length; i += 1) {
        var left = firstPlaylists[i];
        var right = null;
        for (var j = 0; j < secondPlaylists.length; j += 1) if (secondPlaylists[j].id === left.id) { right = secondPlaylists[j]; break; }
        if (!right || left.enabled !== right.enabled || left.items.length !== right.items.length) return false;
        for (var k = 0; k < left.items.length; k += 1) {
          var a = left.items[k];
          var b = right.items[k];
          if (!b || a.mediaId !== b.mediaId || a.hash !== b.hash || a.kind !== b.kind
            || a.durationMs !== b.durationMs || Boolean(a.loop) !== Boolean(b.loop)) return false;
        }
      }
      var firstSchedules = first.schedules || [];
      var secondSchedules = second.schedules || [];
      if (firstSchedules.length !== secondSchedules.length) return false;
      for (var n = 0; n < firstSchedules.length; n += 1) {
        var x = firstSchedules[n];
        var y = secondSchedules[n];
        if (!y || x.id !== y.id || x.playlistId !== y.playlistId || x.startTime !== y.startTime
          || x.endTime !== y.endTime || x.timezone !== y.timezone || Number(x.priority || 0) !== Number(y.priority || 0)
          || Boolean(x.enabled) !== Boolean(y.enabled)) return false;
        var xd = x.weekdays || [];
        var yd = y.weekdays || [];
        if (xd.length !== yd.length) return false;
        for (var d = 0; d < xd.length; d += 1) if (Number(xd[d]) !== Number(yd[d])) return false;
      }
      return true;
    }

    function applyManifest(manifest, lastSyncAt) {
      if (!manifest) return P.resolve(false);
      var previous = state.manifest;
      var previousHash = previous && previous.manifestHash ? previous.manifestHash : null;
      var sameManifest = Boolean(previousHash && manifest.manifestHash && previousHash === manifest.manifestHash);
      var sameContent = samePlaybackContent(previous, manifest);
      var playable = runtime.hasPlayableContent(manifest);
      state.latestManifest = manifest;
      state.screenName = (manifest.screen && manifest.screen.name) || state.screenName;

      function commitStoredManifest(candidate) {
        if (!storage || !isFn(storage.activateManifest)) return P.resolve(false);
        return P.resolve(storage.activateManifest(candidate)).then(function (activated) {
          if (activated === false) return false;
          state.manifest = candidate;
          state.latestManifest = candidate;
          state.screenName = (candidate.screen && candidate.screen.name) || state.screenName;
          state.playing = playable;
          if (playable) state.phase = 'playing';
          state.message = '';
          state.lastSyncAt = lastSyncAt || new Date().toISOString();
          var saveSyncAt = isFn(storage.setLastSyncAt) ? storage.setLastSyncAt(state.lastSyncAt) : true;
          return P.resolve(saveSyncAt).then(function () { paint(); return true; }, function () { paint(); return true; });
        });
      }

      function afterCommands(activated) {
        if (!activated) {
          state.manifest = previous;
          state.playing = Boolean(previous && runtime.hasPlayableContent(previous));
          if (state.playing) state.phase = 'playing';
          record('manifest_render_rejected', { manifestVersion: manifest.manifestVersion, hash: String(manifest.manifestHash || '').slice(0, 12) });
        }
        return P.resolve(applyCommands(manifest)).then(function () {
          if (activated && storage && engine && isFn(storage.deleteUnreferenced) && isFn(engine.protectedHashes)) {
            var keep = engine.protectedHashes();
            var assets = manifest.assets || [];
            for (var i = 0; i < assets.length; i += 1) if (assets[i].hash && keep.indexOf(assets[i].hash) === -1) keep.push(assets[i].hash);
            return P.resolve(storage.deleteUnreferenced(keep)).then(function () { return activated; }, function () { return activated; });
          }
          return activated;
        }).then(function (result) { paint(); return result; });
      }

      if (sameContent) {
        var at = lastSyncAt || state.lastSyncAt || new Date().toISOString();
        var updateExisting = function () {
          state.manifest = manifest;
          state.latestManifest = manifest;
          state.lastSyncAt = at;
          if (engine && isFn(engine.setManifest)) {
            engine.setManifest(manifest);
            var scheduled = runtime.scheduledPlaylistId(win, manifest, new Date());
            if (scheduled && engine.playlistId() !== scheduled) {
              engine.setPlaylist(scheduled);
              engine.render();
            }
          }
          state.playing = playable;
          if (playable) state.phase = 'playing';
          state.message = '';
          var savedAt = storage && isFn(storage.setLastSyncAt) ? storage.setLastSyncAt(at) : true;
          return P.resolve(savedAt).then(function () { paint(); return true; }, function () { paint(); return true; });
        };
        var activation = sameManifest ? P.resolve(true) : commitStoredManifest(manifest);
        return P.resolve(activation).then(function (activated) {
          if (activated) {
            try { return updateExisting(); }
            catch (error) { record('same_content_manifest_update_failed', { code: runtime.errorCode(error) }); return false; }
          }
          return false;
        }, function (error) {
          record('same_content_manifest_commit_failed', { code: runtime.errorCode(error) });
          state.latestManifest = manifest;
          return false;
        }).then(function (activated) {
          return P.resolve(applyCommands(manifest)).then(function () { return Boolean(activated); });
        });
      }

      if (engine && isFn(engine.switchManifest)) {
        return engine.switchManifest(manifest, commitStoredManifest).then(function (activated) {
          return afterCommands(Boolean(activated));
        }, function (error) {
          record('manifest_switch_failed', { code: runtime.errorCode(error) });
          return afterCommands(false);
        });
      }

      return commitStoredManifest(manifest).then(function (activated) {
        if (activated && engine) {
          engine.setManifest(manifest);
          engine.setPlaylist(runtime.scheduledPlaylistId(win, manifest, new Date()));
          engine.render();
        }
        return afterCommands(Boolean(activated));
      }, function (error) {
        record('manifest_activation_failed', { code: runtime.errorCode(error) });
        return afterCommands(false);
      });
    }

    /**
     * Command versioning and acknowledgement.
     *
     * The server is authoritative: `manifest.commands` carries the latest `syncVersion` and
     * `reloadVersion`. The player compares them with the versions it has ALREADY applied (persisted
     * locally, restored during boot) and:
     *
     *   - applies only strictly newer versions,
     *   - persists + ACKs the version after the command was actually executed,
     *   - never re-runs a version it has already acknowledged after a reconnect or a reload.
     *
     * An obsolete command is skipped, not queued: when a newer state supersedes it, running the old
     * one would be wrong. The player always converges on the LATEST authoritative state.
     */
    function applyCommands(manifest) {
      var commands = (manifest && manifest.commands) || null;
      if (!commands || !storage) return P.resolve(true);
      var wantedSync = Number(commands.syncVersion) || 0;
      var wantedReload = Number(commands.reloadVersion) || 0;
      var ack = commands.applied || null;
      var ackSync = ack ? (Number(ack.syncVersion) || 0) : 0;
      var ackReload = ack ? (Number(ack.reloadVersion) || 0) : 0;
      var adopted = false;

      // A server-echoed ACK is authoritative after local storage loss. Adoption only skips work;
      // it can never regress a version or execute a command on the server's behalf.
      if (ackSync >= wantedSync && ackSync > appliedSyncVersion) {
        appliedSyncVersion = ackSync;
        adopted = true;
        wd('markCommand', [ackSync]);
        record('command_adopted_server_ack', { kind: 'sync', version: ackSync });
      }
      if (ackReload >= wantedReload && ackReload > appliedReloadVersion) {
        appliedReloadVersion = ackReload;
        adopted = true;
        wd('markCommand', [ackReload]);
        record('command_adopted_server_ack', { kind: 'reload', version: ackReload });
      }

      function consume(kind, version) {
        var previousSync = appliedSyncVersion;
        var previousReload = appliedReloadVersion;
        if (kind === 'sync') appliedSyncVersion = version;
        else appliedReloadVersion = version;
        return persistCommandState().then(function (saved) {
          if (!saved) {
            appliedSyncVersion = previousSync;
            appliedReloadVersion = previousReload;
            record('command_deferred_storage_unavailable', { kind: kind, version: version });
            return false;
          }
          wd('markCommand', [version]);
          record(kind === 'sync' ? 'sync_command_received' : 'reload_command_received', { version: version });
          return true;
        });
      }

      function saveSeenReload(version) {
        if (!isFn(storage.setSeenReloadVersion)) return P.resolve(true);
        try { return P.resolve(storage.setSeenReloadVersion(version)).then(function () { return true; }, function () { return false; }); }
        catch (error) { return P.resolve(false); }
      }

      var chain = adopted ? persistCommandState() : P.resolve(true);
      chain = chain.then(function () {
        if (wantedReload <= appliedReloadVersion) return null;
        return consume('reload', wantedReload).then(function (saved) {
          if (!saved) return null;
          return saveSeenReload(wantedReload).then(function () {
            wd('scheduleBeat', [0]);
            if (engine && hasPlayableContent()) {
              // The version was durably consumed before the soft in-place recovery; if a page restart
              // happens here, the server ACK prevents this same command from running twice.
              record('reload_command_softened', { version: wantedReload });
              try {
                if (isFn(engine.ensurePlaying)) engine.ensurePlaying();
                reinitRuntime('reload_command');
              } catch (error) {
                record('reload_command_reinit_failed', { code: runtime.errorCode(error) });
              }
              return null;
            }
            reloadNow('command_without_cached_content');
            return null;
          });
        });
      }).then(function () {
        if (wantedSync <= appliedSyncVersion) return null;
        return consume('sync', wantedSync).then(function (saved) {
          if (saved) {
            wd('scheduleBeat', [0]);
            wd('scheduleSync', [0]);
          }
          return null;
        });
      });

      return chain.then(function () {
        pendingCommandSync = Math.max(0, wantedSync - appliedSyncVersion) + Math.max(0, wantedReload - appliedReloadVersion);
        return true;
      }, function (error) {
        pendingCommandSync = Math.max(0, wantedSync - appliedSyncVersion) + Math.max(0, wantedReload - appliedReloadVersion);
        record('command_apply_failed', { code: runtime.errorCode(error) });
        return false;
      });
    }

    /**
     * Background synchronization. It is deliberately fire-and-forget from the playback point of
     * view: every failure ends in a recorded diagnostic plus a retry later, never in a paused
     * player, a cleared cache, a redirect or a blocking screen.
     */
    function performSync(requestedToken) {
      if (disposed) return P.resolve(false);
      var token = requestedToken || state.token;
      if (!token || !storage) return P.resolve(false);
      if (!localStateReady) return P.resolve(false);
      if (!commandStateReady) { record('sync_waiting_command_state', null); return P.resolve(false); }
      if (syncLock) return P.resolve(false);
      if (!http) {
        state.online = false;
        if (!state.manifest) state.error = TEXTS.syncFailed;
        state.lastErrorCode = 'no_transport';
        syncBackoffMs = Math.min(600000, Math.max(60000, syncBackoffMs * 2));
        record('sync_deferred_no_http', { backoffMs: syncBackoffMs });
        wd('noteSyncFailure', ['no_transport']);
        if (!state.playing) paint();
        return P.resolve(false);
      }
      syncLock = true;
      state.phase = state.manifest ? 'playing' : 'syncing';
      state.error = '';
      record('sync_start', null);
      if (!state.playing) paint();
      var activeSync;
      try {
        activeSync = syncFactory(syncOptions(token));
      } catch (error) {
        syncLock = false;
        state.lastErrorCode = runtime.errorCode(error);
        state.error = TEXTS.syncFailed;
        record('sync_init_failed', { code: state.lastErrorCode });
        wd('noteSyncFailure', ['sync_init_failed']);
        return P.resolve(false);
      }
      var syncOperation;
      try { syncOperation = activeSync.run(); }
      catch (error) {
        syncLock = false;
        state.lastErrorCode = runtime.errorCode(error);
        state.error = TEXTS.syncFailed;
        wd('noteSyncFailure', [state.lastErrorCode]);
        record('sync_run_failed', { code: state.lastErrorCode });
        return P.resolve(false);
      }
      return P.resolve(syncOperation).then(function (result) {
        if (disposed) { syncLock = false; return false; }
        syncFailures = 0;
        syncBackoffMs = 0;
        state.syncFailures = 0;
        state.online = true;
        state.progress = null;
        state.error = '';
        state.lastSyncError = '';
        state.lastErrorCode = '';
        state.latestManifest = result.manifest || state.latestManifest;
        if (result.lastSyncAt) state.lastSyncAt = result.lastSyncAt;
        record('sync_ok', { changed: Boolean(result.changed), candidate: Boolean(result.candidate) });
        // A successful synchronization is proof of real, authenticated connectivity. The active
        // manifest pointer is committed later, only after a candidate's first render succeeds.
        wd('markSync', [true]);
        return P.resolve(applyManifest(result.manifest, result.lastSyncAt)).then(function (activated) {
          if (result.candidate && !activated) record('candidate_kept_pending', { hash: String(result.manifest.manifestHash || '').slice(0, 12) });
          syncLock = false;
          return refreshStorageState(true);
        }).then(function () { return true; });
      }, function (error) {
        syncLock = false;
        if (disposed) return false;
        var code = runtime.errorCode(error);
        state.progress = null;
        state.error = TEXTS.syncFailed;
        state.lastSyncError = code;
        state.lastErrorCode = code;
        syncFailures += 1;
        state.syncFailures = syncFailures;
        syncBackoffMs = Math.min(600000, 60000 * Math.pow(2, Math.min(syncFailures - 1, 4)));
        record('sync_failed', { code: code, backoffMs: syncBackoffMs });
        wd('noteSyncFailure', [code]);
        if (code === 'screen_unauthorized') {
          state.token = null;
          wd('setHasCredential', [false]);
          wd('setAuthError', [code]);
          return storage.clearCredential().then(function () {
            // Cached content is never replaced by a pairing screen: the operator re-pairs from the
            // diagnostics panel, and until then playback continues from the local cache.
            if (!state.manifest || !hasPlayableContent()) { state.showPairForm = true; state.phase = 'pair'; }
            else state.notice = TEXTS.unpairedNotice;
            paint();
            return false;
          }, function () {
            if (!state.manifest || !hasPlayableContent()) { state.showPairForm = true; state.phase = 'pair'; }
            paint();
            return false;
          });
        }
        if (code === 'screen_disabled') {
          // The server refused the screen itself, not the network: this is a configuration fault.
          wd('setConfigError', [code]);
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
      })['catch'](function (error) {
        // The promise chain itself must never produce an unhandled rejection.
        syncLock = false;
        if (disposed) return false;
        record('sync_internal_error', { code: runtime.errorCode(error) });
        wd('noteSyncFailure', ['sync_internal_error']);
        paint();
        return false;
      });
    }

    function refreshStorageState(force) {
      if (!storage) return P.resolve(true);
      var now = Date.now();
      if (!force && lastStorageRefreshAt && now - lastStorageRefreshAt < 300000) return P.resolve(true);
      lastStorageRefreshAt = now;
      return P.all([
        storage.countCachedAssets().then(function (count) { state.cachedCount = count; }, function () { return null; }),
        storage.getStats().then(function (stats) { state.stats = stats; }, function () { return null; }),
        storage.getLastSyncAt().then(function (at) { if (at) state.lastSyncAt = at; }, function () { return null; })
      ]).then(function () {
        if (disposed) return false;
        if (state.playing) { renderStatusBar(); paint(); } else paint();
        return true;
      }, function () { return false; });
    }

    /**
     * The ONLY place that reloads the page. It is used for the last-resort watchdog recovery and
     * for an explicit reload command from the admin app — never for a failed API request. It is
     * rate limited in memory and on disk so a television can never enter a reload loop.
     */
    function reloadNow(reason) {
      if (reloadInFlight) return false;
      reloadInFlight = true;
      var now = Date.now();
      if (now < recoveryBlockedUntil) {
        record('reload_suppressed', { reason: reason });
        reloadInFlight = false;
        return false;
      }
      // Exponential backoff across repeated recoveries, on top of the fixed window: a television
      // that keeps failing gets progressively longer to settle instead of looping.
      var reloads = Number(recoveryMeta.reloads) || 0;
      var backoff = Math.min(1800000, 60000 * Math.pow(2, Math.min(reloads, 5)));
      recoveryBlockedUntil = now + Math.max(RECOVERY_WINDOW_MS, backoff);
      record('reload', { reason: reason, reloads: reloads, blockedForMs: Math.max(RECOVERY_WINDOW_MS, backoff) });
      if (state.playbackInfo) persistPlaybackState(state.playbackInfo);
      persistRecoveryMeta(reason);
      var armed = false;
      function go() {
        if (armed) return;
        armed = true;
        try { win.location.reload(); }
        catch (error) { reloadInFlight = false; }
      }
      try {
        if (storage && isFn(storage.setRecoveryState)) {
          storage.setRecoveryState({ at: now, reason: String(reason || 'unknown').slice(0, 60), reloads: reloads + 1 }).then(go, go);
          win.setTimeout(go, 500);
          return true;
        }
      } catch (error) { /* fall through to the immediate reload */ }
      go();
      return true;
    }

    /**
     * Periodic playback keep-alive. It only ever resumes something that should already be playing
     * (a paused video after a firmware hiccup); it never restarts the picture and never reloads.
     * Escalation is the central watchdog's job.
     */
    function ensurePlaybackAlive() {
      try {
        if (!engine || !state.manifest) return;
        if (!hasPlayableContent()) return;
        if (isFn(engine.ensurePlaying)) engine.ensurePlaying();
      } catch (error) {
        record('playback_keepalive_failed', { message: runtime.message(error, 'unknown') });
      }
    }

    function retryEverything() {
      if (disposed) return;
      state.error = '';
      state.notice = '';
      state.emptyTicks = 0;
      if (!storage) {
        state.showPairForm = true;
        state.phase = 'pair';
        paint();
        return;
      }
      if (state.token) {
        try { if (engine && isFn(engine.ensurePlaying)) engine.ensurePlaying(); } catch (error) { record('manual_retry_render_failed', { message: runtime.message(error, 'unknown') }); }
        startAuthenticatedWork('manual_retry');
        return;
      }
      storage.getCredential().then(function (token) {
        if (token) {
          attachEngine(token);
          startAuthenticatedWork('manual_retry');
          return true;
        }
        if (state.manifest && hasPlayableContent()) {
          // Cached content keeps playing: pairing is offered through the diagnostics panel.
          state.notice = TEXTS.unpairedNotice;
          return null;
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

    function restorePlayback(reason) {
      if (!engine || !hasPlayableContent()) return;
      record('playback_focus_restore', { reason: reason });
      try {
        if (isFn(engine.ensurePlaying)) engine.ensurePlaying();
        else engine.render();
        state.playing = true;
        state.phase = 'playing';
        renderStatusBar();
      } catch (error) {
        record('playback_focus_restore_failed', { message: runtime.message(error, 'unknown') });
      }
    }

    function heartbeatFailed(status, code) {
      heartbeatLock = false;
      if (disposed) return;
      heartbeatFailures = Math.min(heartbeatFailures + 1, 7);
      heartbeatBackoffMs = Math.min(600000, 15000 * Math.pow(2, Math.min(heartbeatFailures - 1, 6)));
      state.online = false;
      record('heartbeat_retry_scheduled', { status: status || 0, code: code || 'heartbeat_failed', retryInMs: heartbeatBackoffMs });
      renderStatusBar();
      wd('noteBeatFailure', [code || 'heartbeat_failed']);
    }

    function heartbeat(force) {
      if (disposed || !localStateReady) return;
      if (!state.token || !http) { wd('scheduleBeat', [60000]); return; }
      if (!commandStateReady) { wd('scheduleBeat', [15000]); return; }
      if (heartbeatLock) {
        // A beat is already in flight. The watchdog owns the in-flight timeout, so the lock is
        // always released and the next attempt is scheduled by the watchdog itself. Nothing is
        // queued here: a flapping `online` event must never stack up retries.
        return;
      }
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
      var watch = wd('snapshot', []) || {};
      var payload = {
        currentPlaylistId: playlistId || null,
        currentPlaylistVersion: playlistVersion,
        currentItemId: item && item.id ? item.id : null,
        syncStatus: syncLock ? 'syncing' : (state.error ? 'failed' : 'ready'),
        syncError: state.error ? String(state.lastErrorCode || 'sync_failed').slice(0, 80) : null,
        cachedMediaCount: state.cachedCount,
        storageUsageBytes: isFiniteNumber(state.stats.usage) ? state.stats.usage : null,
        storageQuotaBytes: isFiniteNumber(state.stats.quota) ? state.stats.quota : null,
        lastSyncAt: state.lastSyncAt || null,
        deviceInfo: runtime.deviceInfo(win),
        // --- 24/7 self-healing telemetry -------------------------------------------------------
        // `playerState` is derived locally but is only ever PESSIMISTIC here: the server ignores it
        // for "online" and computes that from this authenticated heartbeat's own timestamp.
        playerState: watch.state || 'boot',
        appliedSyncVersion: appliedSyncVersion,
        appliedReloadVersion: appliedReloadVersion,
        consecutiveFailures: Number(watch.consecutiveFailures) || 0,
        recovery: {
          count: Number(watch.recoveryCount) || 0,
          lastAt: watch.lastRecoveryAt ? new Date(watch.lastRecoveryAt).toISOString() : null,
          reason: String(watch.lastRecoveryReason || '').slice(0, 120) || null,
          state: String(watch.state || '').slice(0, 40) || null
        },
        healthStatus: watch.healthStatus || null,
        healthCheckedAt: watch.healthCheckedAt ? new Date(watch.healthCheckedAt).toISOString() : null,
        bootAt: bootAt
      };
      var request;
      try { request = runtime.sendHeartbeat(http, state.token, payload); }
      catch (error) { heartbeatFailed(0, runtime.errorCode(error)); return; }
      request.then(function (response) {
        if (disposed) { heartbeatLock = false; return null; }
        if (response.status === 401) {
          var errorPayload = null;
          try { errorPayload = response.json(); } catch (error) { errorPayload = null; }
          if (!errorPayload || errorPayload.code !== 'screen_unauthorized') {
            heartbeatFailed(response.status, 'unconfirmed_unauthorized');
            return;
          }
          heartbeatLock = false;
          state.token = null;
          wd('setHasCredential', [false]);
          wd('setAuthError', ['screen_unauthorized']);
          return storage.clearCredential().then(function () {
            if (!state.manifest || !hasPlayableContent()) { state.showPairForm = true; state.phase = 'pair'; }
            else state.notice = TEXTS.unpairedNotice;
            paint();
            return null;
          }, function () { return null; });
        }
        if (!response.ok) { heartbeatFailed(response.status, 'http_error'); return; }
        heartbeatLock = false;
        heartbeatFailures = 0;
        heartbeatBackoffMs = 0;
        if (!state.online) {
          state.online = true;
          renderStatusBar();
        }
        // Success: the server validated the credential and recorded this instant. The watchdog then
        // re-arms the next beat and, after an outage, drives RECONNECTING -> SYNC -> ONLINE.
        wd('markHeartbeat', []);
        return null;
      }, function (error) {
        heartbeatFailed(0, runtime.errorCode(error));
      });
    }

    /*
     * There is deliberately no `startTimers()` any more.
     *
     * The heartbeat, the synchronization, the schedule switch, the playback keep-alive and the
     * daily self-check are all scheduled from the ONE interval owned by the central watchdog
     * (public/player/watchdog.js). Four independent timers used to race each other; worse, each of
     * them could die silently on a single unsettled request and no code would ever notice.
     */
    function startTimers() {
      record('timers_moved_to_watchdog', null);
    }

    function listen(target, type, handler, capture) {
      if (!target || !isFn(target.addEventListener)) return;
      try {
        target.addEventListener(type, handler, Boolean(capture));
        eventBindings.push({ target: target, type: type, handler: handler, capture: Boolean(capture) });
      } catch (error) { record('event_listener_attach_failed', { type: type }); }
    }

    function bindEnvironment() {
      if (environmentBound || !win.addEventListener) return;
      environmentBound = true;
      listen(win, 'online', function () {
        record('browser_online_event', { onLine: navigatorOnline() });
        wd('requestRecovery', ['browser_online']);
        restorePlayback('online');
      }, false);
      listen(win, 'offline', function () {
        state.online = false;
        renderStatusBar();
        record('browser_offline_event', null);
        wd('markProgress', []);
      }, false);
      listen(win, 'focus', function () { restorePlayback('focus'); }, false);
      listen(win, 'pageshow', function () { restorePlayback('pageshow'); wd('requestRecovery', ['pageshow']); }, false);
      if (doc.addEventListener) {
        listen(doc, 'visibilitychange', function () {
          var visible = true;
          try { visible = doc.visibilityState ? doc.visibilityState === 'visible' : !doc.hidden; } catch (error) { visible = true; }
          if (visible) {
            restorePlayback('visible');
            wd('requestRecovery', ['visible']);
          } else record('playback_visibility_hidden', null);
        }, false);
      }
      listen(win, 'error', function (event) {
        var messageText = event && event.message ? String(event.message).slice(0, 200) : 'unknown';
        record('window_error', { message: messageText });
        wd('noteError', ['window_error']);
      }, false);
      assignedUnhandledRejection = function (event) {
        record('unhandled_rejection', { code: runtime.errorCode(event && event.reason) });
        wd('noteError', ['unhandled_rejection']);
      };
      try { win.onunhandledrejection = assignedUnhandledRejection; } catch (error) { assignedUnhandledRejection = null; }
      listen(win, 'keydown', function (event) {
        requestFullscreen(win);
        var target = event && event.target;
        var inField = target && target.tagName === 'INPUT';
        var key = event ? (event.key || event.keyCode) : null;
        if (!inField && (key === 'i' || key === 'I' || key === 457)) openDiagnostics('manual');
      }, false);
      listen(win, 'click', function () { requestFullscreen(win); }, false);
    }

    /* ------------------------------------------------------------------ boot ---------------------*/

    function start() {
      if (startPromise) return startPromise;
      if (disposed) return P.resolve(false);
      try {
        buildShell();
        paint();
        win.__signageBooted = true;
      } catch (error) {
        record('shell_failed', { code: runtime.errorCode(error) });
        startPromise = P.resolve(false);
        return startPromise;
      }
      record('boot', { chromium: caps.chromium, webos: caps.webos.version });
      bindEnvironment();
      try {
        http = httpFactory(win, { Promise: P, log: record, transport: win.__SIGNAGE_TRANSPORT__ || null });
      } catch (error) {
        http = null;
        state.online = false;
        state.error = TEXTS.unexpected;
        state.lastErrorCode = runtime.errorCode(error);
        record('http_init_failed_nonblocking', { code: state.lastErrorCode });
      }
      if (wantsDiagnostics(win)) win.setTimeout(function () { openDiagnostics('manual'); }, 0);
      // The watchdog is created once and remains credential-gated until command/recovery state has
      // been restored from disk. It never applies a command using a speculative zero version.
      setupWatchdog();
      var storagePromise;
      try {
        storagePromise = storageFactory(win, { Promise: P, log: record });
      } catch (error) {
        fatal(error, 'storage_init_failed');
        startPromise = P.resolve(false);
        return startPromise;
      }

      function readOptional(adapter, name, fallback) {
        if (!adapter || !isFn(adapter[name])) return P.resolve(fallback);
        try { return P.resolve(adapter[name]()).then(function (value) { return value; }, function () { return fallback; }); }
        catch (error) { return P.resolve(fallback); }
      }
      function readOperational(adapter, name, fallback) {
        if (!adapter || !isFn(adapter[name])) return P.resolve(fallback);
        try { return P.resolve(adapter[name]()); }
        catch (error) { return P.reject(error); }
      }
      function settleWithin(promise, timeoutMs, fallback) {
        return new P(function (resolve) {
          var settled = false;
          var timer = win.setTimeout(function () {
            if (settled) return;
            settled = true;
            resolve(fallback);
          }, timeoutMs);
          P.resolve(promise).then(function (value) {
            if (settled) return;
            settled = true;
            win.clearTimeout(timer);
            resolve(value);
          }, function () {
            if (settled) return;
            settled = true;
            win.clearTimeout(timer);
            resolve(fallback);
          });
        });
      }
      function applyOperationalState(values) {
        if (disposed || commandStateReady) return;
        if (operationalRetryTimer) { win.clearTimeout(operationalRetryTimer); operationalRetryTimer = null; }
        var commandState = values[0];
        var recovery = values[1];
        var recoveryStored = values[2];
        var seenReload = Number(values[3]) || 0;
        appliedSyncVersion = Number(commandState && commandState.appliedSyncVersion) || 0;
        appliedReloadVersion = Number(commandState && commandState.appliedReloadVersion) || 0;
        if (!appliedReloadVersion && seenReload) appliedReloadVersion = seenReload;
        if (recoveryStored && typeof recoveryStored === 'object') {
          recoveryMeta = recoveryStored;
          if (recoveryStored.lastAt) {
            var age = Date.now() - new Date(recoveryStored.lastAt).getTime();
            if (age === age && age >= 0 && age < RECOVERY_WINDOW_MS) {
              recoveryBlockedUntil = new Date(recoveryStored.lastAt).getTime() + RECOVERY_WINDOW_MS;
            }
          }
        }
        if (recovery && recovery.at && (Date.now() - Number(recovery.at)) < RECOVERY_WINDOW_MS) {
          recoveryBlockedUntil = Math.max(recoveryBlockedUntil, Number(recovery.at) + RECOVERY_WINDOW_MS);
        }
        commandStateReady = true;
        record('boot_operational_state', {
          appliedSyncVersion: appliedSyncVersion,
          appliedReloadVersion: appliedReloadVersion,
          recoveryCount: Number(recoveryMeta.count) || 0,
          recoveryReason: String(recoveryMeta.reason || '').slice(0, 60)
        });
        if (localStateReady) {
          attachEngine(state.token);
          if (state.token) startAuthenticatedWork('boot');
        }
      }
      function readOperationalState(adapter) {
        var loads = P.all([
          readOperational(adapter, 'getCommandState', null),
          readOperational(adapter, 'getRecoveryState', null),
          readOperational(adapter, 'getRecoveryMeta', null),
          readOperational(adapter, 'getSeenReloadVersion', 0)
        ]);
        loads.then(applyOperationalState, function (error) {
          record('boot_operational_state_unavailable', { code: runtime.errorCode(error) });
          if (!disposed && !commandStateReady && !operationalRetryTimer) {
            operationalRetryTimer = win.setTimeout(function () {
              operationalRetryTimer = null;
              readOperationalState(adapter);
            }, 30000);
          }
        });
      }

      startPromise = P.resolve(storagePromise).then(function (adapter) {
        if (disposed) return false;
        storage = adapter;
        state.storage = adapter;
        state.online = false; // network hints never claim a confirmed heartbeat or authenticated sync
        record('storage', { backend: adapter.backend });

        // Credentials and command bookkeeping are read in parallel with the cached playlist, but
        // neither can delay local playback. Only the cached manifest + a bounded resume lookup are
        // on the first-frame path; a slow telemetry query can never keep an offline TV blank.
        var manifestPromise = readOptional(adapter, 'getActiveManifest', null);
        var localBootstrapped = false;
        manifestPromise.then(function (lateManifest) {
          if (!localBootstrapped || state.manifest || disposed || !lateManifest) return;
          if (isFn(runtime.validateManifest) && !runtime.validateManifest(lateManifest)) return;
          if (!runtime.hasPlayableContent(lateManifest)) return;
          state.manifest = lateManifest;
          state.latestManifest = lateManifest;
          state.screenName = (lateManifest.screen && lateManifest.screen.name) || state.screenName;
          if (engine) {
            engine.setManifest(lateManifest);
            engine.setPlaylist(runtime.scheduledPlaylistId(win, lateManifest, new Date()));
            engine.render();
          }
          state.playing = true;
          state.phase = 'playing';
          paint();
          record('late_cached_manifest_restored', { version: lateManifest.manifestVersion });
        });
        var playbackPromise = readOptional(adapter, 'getPlaybackState', null);
        var credentialPromise = readOptional(adapter, 'getCredential', null);
        credentialPromise.then(function (token) {
          if (disposed || credentialReadCancelled) return;
          state.token = token || null;
          if (localStateReady) attachEngine(state.token);
          if (state.token && localStateReady) {
            if (!state.pairFormExplicit) state.showPairForm = false;
            if (state.phase === 'pair' && !state.manifest) state.phase = 'syncing';
            if (commandStateReady) startAuthenticatedWork('boot');
            paint();
          }
        }, function (error) { record('credential_restore_failed', { code: runtime.errorCode(error) }); });
        readOperationalState(adapter);
        operationalWarningTimer = win.setTimeout(function () {
          operationalWarningTimer = null;
          if (!commandStateReady) record('boot_command_state_still_loading', null);
        }, 5000);

        return P.all([
          settleWithin(manifestPromise, 2500, null),
          settleWithin(playbackPromise, 1200, null)
        ]).then(function (local) {
          if (disposed) return false;
          if (operationalWarningTimer) { win.clearTimeout(operationalWarningTimer); operationalWarningTimer = null; }
          localBootstrapped = true;
          var manifest = local[0];
          var playback = local[1];
          if (manifest && isFn(runtime.validateManifest) && !runtime.validateManifest(manifest)) {
            record('cached_manifest_rejected', { reason: 'integrity_or_schema' });
            manifest = null;
          }
          state.manifest = manifest || null;
          state.latestManifest = manifest || null;
          state.resume = playback || null;
          state.playbackInfo = playback || null;
          state.screenName = (manifest && manifest.screen && manifest.screen.name) || '';
          localStateReady = true;
          var playable = runtime.hasPlayableContent(manifest);
          // Start and render the local engine before optional storage statistics, credential restore,
          // network sync, or command hydration finish.
          attachEngine(state.token);
          if (playable && engine) {
            engine.setManifest(state.manifest);
            engine.setPlaylist(runtime.scheduledPlaylistId(win, state.manifest, new Date()));
            engine.render();
          }
          startTimers();
          if (playable) {
            state.playing = true;
            state.phase = 'playing';
            if (!state.token) state.notice = TEXTS.unpairedNotice;
          } else if (!state.token) {
            state.phase = 'pair';
            state.showPairForm = true;
          } else {
            state.phase = 'syncing';
          }
          paint();
          backgroundWork();
          return true;
        }, function (error) {
          if (operationalWarningTimer) { win.clearTimeout(operationalWarningTimer); operationalWarningTimer = null; }
          throw error;
        });
      }).then(function (result) {
        return result;
      }, function (error) {
        fatal(error, 'boot_failed');
        return false;
      });
      return startPromise;
    }

    /**
     * Everything that is optional for playback. Each call is individually guarded: a failure here
     * is a diagnostic, never a stopped player.
     */
    function startAuthenticatedWork(reason) {
      if (!state.token || !commandStateReady || !localStateReady) return false;
      wd('setHasCredential', [Boolean(state.token && http)]);
      var firstStart = !backgroundStarted;
      backgroundStarted = true;
      if (!firstStart && (!reason || reason === 'boot')) return true;
      // requestRecovery owns the single immediate heartbeat + synchronization path.
      wd('requestRecovery', [reason || 'boot']);
      if (wd('isRunning', []) !== true) {
        // Compatibility fallback for an older cached shell without watchdog.js; player-level locks
        // still ensure only one request of each type can be in flight.
        try { heartbeat(true); } catch (error) { heartbeatFailed(0, runtime.errorCode(error)); }
        performSync(state.token).then(function () { return null; }, function () { return null; });
      }
      return true;
    }

    function backgroundWork() {
      if (disposed) return;
      try { refreshStorageState(true); } catch (error) { record('storage_state_failed', { code: runtime.errorCode(error) }); }
      if (storage && isFn(storage.getAudioEnabled)) {
        storage.getAudioEnabled().then(function (value) {
          state.audioEnabled = Boolean(value);
        }, function () { return null; });
      }
      startAuthenticatedWork('boot');
    }

    function destroy() {
      if (disposed) return;
      disposed = true;
      if (operationalRetryTimer) { win.clearTimeout(operationalRetryTimer); operationalRetryTimer = null; }
      if (operationalWarningTimer) { win.clearTimeout(operationalWarningTimer); operationalWarningTimer = null; }
      for (var i = eventBindings.length - 1; i >= 0; i -= 1) {
        var binding = eventBindings[i];
        try { binding.target.removeEventListener(binding.type, binding.handler, binding.capture); } catch (error) { /* best effort */ }
      }
      eventBindings = [];
      if (assignedUnhandledRejection && win.onunhandledrejection === assignedUnhandledRejection) {
        try { win.onunhandledrejection = previousUnhandledRejection || null; } catch (error) { /* best effort */ }
      }
      try { if (watchdog && isFn(watchdog.destroy)) watchdog.destroy(); else if (watchdog && isFn(watchdog.stop)) watchdog.stop(); } catch (error) { record('watchdog_destroy_failed', { code: runtime.errorCode(error) }); }
      try { if (engine && isFn(engine.stop)) engine.stop(); } catch (error) { record('engine_destroy_failed', { code: runtime.errorCode(error) }); }
      try { if (storage && isFn(storage.close)) storage.close(); } catch (error) { record('storage_close_failed', { code: runtime.errorCode(error) }); }
      if (win.SignagePlayerInstance && win.SignagePlayerInstance.state === state) win.SignagePlayerInstance = null;
    }

    return {
      start: start,
      destroy: destroy,
      state: state,
      record: record,
      paint: paint,
      openDiagnostics: openDiagnostics,
      retryEverything: retryEverything,
      engine: function () { return engine; },
      storage: function () { return storage; },
      sync: function () { return sync; },
      watchdog: function () { return watchdog; },
      healthCheck: function (when) { return healthCheck(when || 'manual'); },
      appliedCommandVersions: function () {
        return { appliedSyncVersion: appliedSyncVersion, appliedReloadVersion: appliedReloadVersion };
      },
      texts: TEXTS,
      log: function () { return log.slice(); }
    };
  }

  function autoBoot() {
    if (!root || !root.document || root.__SIGNAGE_NO_AUTOBOOT) return null;
    if (!root.SignagePlayerRuntime) return null;
    if (root.SignagePlayerInstance && isFn(root.SignagePlayerInstance.start)) return root.SignagePlayerInstance;
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
