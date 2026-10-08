/*
 * Signage player watchdog — the single brain of the 24/7 self-healing player.
 *
 * ES5, dependency-free, webOS 3.5 (Chromium 38) safe: no Promise, no AbortController, no Map/Set,
 * no Array.prototype.includes, no arrow functions, no template literals, no Object.assign.
 *
 * There must only ever be ONE heartbeat loop, ONE synchronization loop and ONE watchdog. This
 * module therefore owns the only interval timer in the player and *schedules* the heartbeat and
 * the synchronization instead of letting each of them keep a private self-rescheduling timer (a
 * private timer dies with a single unsettled request and silently stops the player forever).
 *
 * The watchdog never talks to the network itself. It decides WHEN the player must beat, sync,
 * reinitialize its runtime or reload the page, and it tracks the evidence:
 *
 *   lastHeartbeatAt            last successful authenticated heartbeat
 *   lastApiSuccessAt           last successful server round trip (heartbeat, manifest, media)
 *   lastSyncAt                 last successful synchronization
 *   lastCommandAt              last command the player executed
 *   lastAppliedCommandVersion  last acknowledged command version
 *   lastProgressAt             last proof that the application runtime is still progressing
 *   state                      ONLINE -> DEGRADED -> RECONNECTING -> SYNCING -> RECOVERING
 *   consecutiveFailures        consecutive failed server attempts
 *   lastRecoveryAt / Reason    the last healing action
 *
 * Two independent failure classes are detected:
 *
 *   A. NETWORK FAILURE    — no successful server communication for `staleMs`, or repeated failed
 *                           heartbeat/sync attempts. `navigator.onLine` is never trusted: only a
 *                           real authenticated round trip counts.
 *   B. APPLICATION FAILURE — the runtime stopped progressing (nothing on the stage although local
 *                           media exists), the event loop was suspended for a long wall-clock gap,
 *                           or the page is throwing errors faster than it can recover.
 *
 * Escalation ladder (every rung is separately rate limited; a reload is the last resort and is
 * NEVER taken merely because the server could not be reached while cached content is playing):
 *
 *   ONLINE -> DEGRADED -> RECONNECTING -> SYNC -> ONLINE
 *                             \\-> RECOVERING -> (runtime reinitialize) -> ONLINE
 *                                     \\-> CONTROLLED_RELOAD -> BOOT -> REGISTER -> SYNC -> ONLINE
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module !== null && module.exports) module.exports = api;
  if (root) root.SignageWatchdog = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function (root) {
  'use strict';

  var STATES = {
    BOOT: 'boot',
    REGISTER: 'register',
    SYNC: 'sync',
    ONLINE: 'online',
    DEGRADED: 'degraded',
    RECONNECTING: 'reconnecting',
    RECOVERING: 'recovering',
    CONTROLLED_RELOAD: 'controlled_reload',
    OFFLINE: 'offline',
    AUTH_ERROR: 'auth_error',
    CONFIG_ERROR: 'config_error'
  };

  var DEFAULTS = {
    // One ticker for everything: short enough to react inside a stale window, long enough to be
    // free on a 2016 television. Every other cadence below is scheduled from this tick.
    tickMs: 5000,
    // Runtime (empty stage) checks keep the television-proven 15 s cadence.
    runtimeCheckMs: 15000,
    // Cheap periodic work (playlist schedule switch) rides the same ticker.
    housekeepingMs: 15000,
    heartbeatMs: 30000,
    syncMs: 60000,
    // No successful server contact for this long means the connection is not healthy.
    staleMs: 90000,
    // No successful server contact for this long and the player is reported OFFLINE.
    offlineMs: 900000,
    // A heartbeat/sync that never settles must not stall the loop forever.
    beatTimeoutMs: 25000,
    syncTimeoutMs: 900000,
    // Minimum spacing so a reconnect can never turn into a request storm.
    minBeatGapMs: 5000,
    minSyncGapMs: 15000,
    // Backoff: base * 2^(n-1), capped, with jitter.
    beatBackoffBaseMs: 15000,
    syncBackoffBaseMs: 30000,
    maxBackoffMs: 900000,
    jitterRatio: 0.25,
    // Escalation thresholds, counted in consecutive failed attempts.
    degradedAfter: 1,
    reconnectAfter: 3,
    recoverAfter: 8,
    // Runtime reinitialization is not free; never repeat it inside this gap.
    reinitGapMs: 3600000,
    reinitGapWhenUnhealthyMs: 600000,
    // Application failure: nothing has progressed for this long.
    appStaleMs: 180000,
    // A wall-clock jump larger than this means the page was suspended (TV standby), not broken.
    suspendGapMs: 120000,
    // Reload policy: only when the runtime itself cannot be repaired, and never in a loop.
    reloadAfterFailures: 24,
    reloadArmDelayMs: 5000,
    reloadWindowMs: 600000,
    reloadMaxPerWindow: 2,
    // Once the per-window budget is spent, a hard cooldown applies. A permanently broken television
    // keeps showing its last cached frame instead of reloading twice every ten minutes forever.
    reloadCooldownMs: 3600000,
    // Stable operation resets the counters and clears the recovery bookkeeping.
    stableMs: 900000,
    healthEveryMs: 86400000,
    healthFirstDelayMs: 300000
  };

  function noop() { /* intentionally empty */ }
  function isFn(value) { return typeof value === 'function'; }
  function nowMs() { return Date.now(); }
  function short(value, limit) { return String(value === undefined || value === null ? '' : value).slice(0, limit || 60); }

  /**
   * Creates the watchdog. `options.actions` is the player's muscle:
   *
   *   beat(reason)              send exactly one heartbeat
   *   sync(reason)              run exactly one synchronization
   *   resetBeat(reason)         force-release the heartbeat lock (in-flight guard)
   *   resetSync(reason)         force-release the sync lock (in-flight guard)
   *   abortStale(reason)        drop requests/subscriptions that can no longer succeed
   *   runtimeStatus()           -> { healthy, hasLocal, playable }
   *   reinitRuntime(reason)     rebuild the runtime in place (never blanks a playing screen)
   *   reload(reason)            -> true when a controlled page reload was started
   *   healthCheck(when)         run the daily self-check
   *   onState(next, prev, snap) state change notification
   *   log(event, data)          diagnostic sink
   */
  function createWatchdog(options) {
    var opts = options || {};
    var win = opts.win || root;
    // There must never be two live watchdogs (two heartbeat loops) in one page. If the player is
    // rebuilt in place — or a recovered script reloads player.js — the previous watchdog is torn
    // down first so only one interval timer can ever exist.
    if (win && win.__signageWatchdogInstance && win.__signageWatchdogInstance !== undefined) {
      try { win.__signageWatchdogInstance.destroy(); } catch (error) { noop(); }
      win.__signageWatchdogInstance = null;
    }
    var actions = opts.actions || {};
    var log = isFn(opts.log) ? opts.log : (isFn(actions.log) ? actions.log : noop);
    var cfg = {};
    var key;
    for (key in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) cfg[key] = DEFAULTS[key];
    }
    if (opts.timing) {
      for (key in opts.timing) {
        if (Object.prototype.hasOwnProperty.call(opts.timing, key) && typeof opts.timing[key] === 'number') {
          cfg[key] = opts.timing[key];
        }
      }
    }

    var started = false;
    var destroyed = false;
    var timer = null;
    var reloadTimer = null;
    var lastTickWall = 0;

    var nextBeatAt = 0;
    var nextSyncAt = 0;
    var nextRuntimeCheckAt = 0;
    var nextHousekeepingAt = 0;
    var nextHealthAt = 0;
    var lastBeatSentAt = 0;
    var lastSyncSentAt = 0;
    var lastBeatFailed = false;
    var lastSyncFailed = false;
    var beatInFlightAt = 0;
    var syncInFlightAt = 0;
    var beatFailures = 0;
    var syncFailures = 0;
    var consecutiveFailures = 0;
    var lastBackoffMs = 0;
    var lastReinitAt = 0;
    var lastReloadAt = 0;
    var reloadsInWindow = 0;
    var reloadWindowStart = 0;
    var reloadCooldownUntil = 0;
    var emptyStreak = 0;
    var localRecoveries = 0;

    var bootedAt = nowMs();
    var snap = {
      state: STATES.BOOT,
      prevState: null,
      stateSince: bootedAt,
      bootedAt: bootedAt,
      lastHeartbeatAt: 0,
      lastApiSuccessAt: 0,
      lastSyncAt: 0,
      lastCommandAt: 0,
      lastAppliedCommandVersion: 0,
      lastProgressAt: bootedAt,
      lastTickAt: 0,
      lastFailureAt: 0,
      lastFailureCode: '',
      lastRecoveryAt: 0,
      lastRecoveryReason: '',
      recoveryCount: 0,
      consecutiveFailures: 0,
      beatFailures: 0,
      syncFailures: 0,
      runtimeReinits: 0,
      reloads: 0,
      emptyStreak: 0,
      frozenGaps: 0,
      suspendGaps: 0,
      errorStreak: 0,
      healthStatus: '',
      healthCheckedAt: 0,
      authError: '',
      configError: '',
      hasCredential: false
    };

    /* ------------------------------------------------------------------ helpers ---------------*/

    function call(name, args) {
      var fn = actions[name];
      if (!isFn(fn)) return undefined;
      try { return fn.apply(null, args || []); }
      catch (error) {
        log('watchdog_action_failed', { action: name, message: short(error && error.message ? error.message : error, 160) });
        return undefined;
      }
    }

    /**
     * Minimum spacing between two attempts. The gap is deliberately ignored while the previous
     * attempt FAILED: after an outage the player must be allowed to prove connectivity the moment
     * the browser reports it, and the backoff (not the floor) is what paces repeated failures.
     */
    function beatGapElapsed(now) { return lastBeatFailed || now - lastBeatSentAt >= cfg.minBeatGapMs; }
    function syncGapElapsed(now) { return lastSyncFailed || now - lastSyncSentAt >= cfg.minSyncGapMs; }

    function jittered(value) {
      var spread = Math.round(value * cfg.jitterRatio);
      if (spread <= 0) return value;
      return value - spread + Math.floor(Math.random() * (spread * 2 + 1));
    }

    function backoffFor(failures, base) {
      var exponent = Math.min(Math.max(failures - 1, 0), 8);
      var value = base * Math.pow(2, exponent);
      if (value > cfg.maxBackoffMs) value = cfg.maxBackoffMs;
      // The cap is applied AFTER the jitter: the ladder must never overshoot the maximum wait,
      // otherwise a fleet of televisions would drift past the configured ceiling.
      var result = jittered(value);
      return result > cfg.maxBackoffMs ? cfg.maxBackoffMs : result;
    }

    function transition(next, reason) {
      if (snap.state === next) return;
      var prev = snap.state;
      snap.state = next;
      snap.prevState = prev;
      snap.stateSince = nowMs();
      log('watchdog_state', { from: prev, to: next, reason: short(reason, 60) });
      call('onState', [next, prev, snapshot()]);
    }

    function noteRecovery(kind, reason) {
      snap.recoveryCount += 1;
      snap.lastRecoveryAt = nowMs();
      snap.lastRecoveryReason = short(reason || kind, 60);
      log('watchdog_recovery', { kind: kind, reason: snap.lastRecoveryReason, count: snap.recoveryCount });
    }

    function resetFailureCounters(reason) {
      // A player that is healthy again earns its reload budget back.
      if (consecutiveFailures === 0 && beatFailures === 0 && syncFailures === 0) return;
      consecutiveFailures = 0;
      beatFailures = 0;
      syncFailures = 0;
      lastBackoffMs = 0;
      snap.consecutiveFailures = 0;
      snap.beatFailures = 0;
      snap.syncFailures = 0;
      log('watchdog_counters_reset', { reason: short(reason, 60) });
    }

    function snapshot() {
      return {
        state: snap.state,
        prevState: snap.prevState,
        stateSince: snap.stateSince,
        bootedAt: snap.bootedAt,
        lastHeartbeatAt: snap.lastHeartbeatAt,
        lastApiSuccessAt: snap.lastApiSuccessAt,
        lastSyncAt: snap.lastSyncAt,
        lastCommandAt: snap.lastCommandAt,
        lastAppliedCommandVersion: snap.lastAppliedCommandVersion,
        lastProgressAt: snap.lastProgressAt,
        lastTickAt: snap.lastTickAt,
        lastFailureAt: snap.lastFailureAt,
        lastFailureCode: snap.lastFailureCode,
        lastRecoveryAt: snap.lastRecoveryAt,
        lastRecoveryReason: snap.lastRecoveryReason,
        recoveryCount: snap.recoveryCount,
        consecutiveFailures: consecutiveFailures,
        beatFailures: beatFailures,
        syncFailures: syncFailures,
        runtimeReinits: snap.runtimeReinits,
        reloads: snap.reloads,
        emptyStreak: snap.emptyStreak,
        frozenGaps: snap.frozenGaps,
        suspendGaps: snap.suspendGaps,
        errorStreak: snap.errorStreak,
        healthStatus: snap.healthStatus,
        healthCheckedAt: snap.healthCheckedAt,
        authError: snap.authError,
        configError: snap.configError,
        hasCredential: snap.hasCredential,
        running: started && !destroyed
      };
    }

    /* ------------------------------------------------------------------ success signals -------*/

    /** Any successful, server-validated round trip. This — not navigator.onLine — is the truth. */
    function markApiSuccess() {
      var now = nowMs();
      snap.lastApiSuccessAt = now;
      snap.lastProgressAt = now;
      snap.lastFailureCode = '';
      snap.errorStreak = 0;
      var wasFailing = consecutiveFailures > 0;
      resetFailureCounters('api_success');
      if (snap.lastRecoveryAt && now - snap.lastRecoveryAt > cfg.stableMs) {
        // A long, stable run clears the recovery bookkeeping the administrator sees.
        snap.recoveryCount = 0;
        snap.lastRecoveryReason = '';
      }
      if (!wasFailing && snap.state === STATES.ONLINE) return;
      // A pending controlled reload stays visible: a single lucky round trip must not hide the fact
      // that the page is on its way down and coming back.
      if (snap.state !== STATES.SYNC && snap.state !== STATES.CONTROLLED_RELOAD) {
        transition(STATES.ONLINE, 'api_success');
      }
    }

    function markHeartbeat() {
      snap.lastHeartbeatAt = nowMs();
      beatInFlightAt = 0;
      lastBeatFailed = false;
      // After an outage the player must re-synchronize before it may claim ONLINE again.
      if (snap.state === STATES.DEGRADED || snap.state === STATES.RECONNECTING
        || snap.state === STATES.RECOVERING || snap.state === STATES.OFFLINE) {
        transition(STATES.SYNC, 'heartbeat_confirmed');
        nextSyncAt = nowMs();
      }
      markApiSuccess();
      nextBeatAt = nowMs() + cfg.heartbeatMs;
    }

    function markSync(ok) {
      syncInFlightAt = 0;
      lastSyncFailed = false;
      if (ok === false) { noteSyncFailure('sync_failed'); return; }
      snap.lastSyncAt = nowMs();
      nextSyncAt = nowMs() + cfg.syncMs;
      markApiSuccess();
      if (snap.state === STATES.SYNC) transition(STATES.ONLINE, 'sync_confirmed');
    }

    /* ------------------------------------------------------------------ failure signals -------*/

    function noteFailure(code) {
      var now = nowMs();
      consecutiveFailures += 1;
      snap.consecutiveFailures = consecutiveFailures;
      snap.lastFailureAt = now;
      snap.lastFailureCode = short(code || 'unknown', 60);
      lastBackoffMs = backoffFor(consecutiveFailures, cfg.beatBackoffBaseMs);
    }

    function noteBeatFailure(code) {
      beatInFlightAt = 0;
      lastBeatFailed = true;
      beatFailures += 1;
      snap.beatFailures = beatFailures;
      noteFailure(code);
      // Always re-arm the loop: a heartbeat that failed may never be retried otherwise.
      nextBeatAt = nowMs() + Math.max(cfg.minBeatGapMs, backoffFor(beatFailures, cfg.beatBackoffBaseMs));
    }

    function noteSyncFailure(code) {
      syncInFlightAt = 0;
      lastSyncFailed = true;
      syncFailures += 1;
      snap.syncFailures = syncFailures;
      noteFailure(code);
      nextSyncAt = nowMs() + Math.max(cfg.minSyncGapMs, backoffFor(syncFailures, cfg.syncBackoffBaseMs));
    }

    /** Proof of life from the application: playback advanced, a file downloaded, a timer fired. */
    function markProgress() {
      snap.lastProgressAt = nowMs();
      snap.errorStreak = 0;
    }

    function markCommand(version) {
      snap.lastCommandAt = nowMs();
      if (typeof version === 'number' && version > snap.lastAppliedCommandVersion) {
        snap.lastAppliedCommandVersion = version;
      }
      markProgress();
    }

    function noteError(code) {
      snap.errorStreak += 1;
      snap.lastFailureCode = short(code || 'runtime_error', 60);
      if (snap.errorStreak >= 10) {
        // Ten runtime errors in a row with no progress: the runtime itself is the problem, so it is
        // rebuilt in place before anything else is attempted.
        snap.errorStreak = 0;
        noteRecovery('error_storm', snap.lastFailureCode);
        reinitRuntime('error_storm');
      }
    }

    function setAuthError(code) {
      snap.authError = short(code || 'screen_unauthorized', 60);
      transition(STATES.AUTH_ERROR, 'auth_error');
    }

    function setConfigError(code) {
      snap.configError = short(code || 'config_invalid', 60);
      transition(STATES.CONFIG_ERROR, 'config_error');
    }

    function setHasCredential(value) {
      snap.hasCredential = Boolean(value);
      if (snap.hasCredential && snap.state === STATES.AUTH_ERROR) {
        snap.authError = '';
        transition(STATES.REGISTER, 'credential_restored');
      }
    }

    function setHealthStatus(status) {
      snap.healthStatus = short(status || '', 120);
      snap.healthCheckedAt = nowMs();
      nextHealthAt = snap.healthCheckedAt + cfg.healthEveryMs;
      log('watchdog_health_check', { status: snap.healthStatus });
    }

    /** Runs one synchronization right now, unless one is already in flight. */
    function requestSync(reason) {
      var now = nowMs();
      if (snap.hasCredential && !syncInFlightAt && syncGapElapsed(now)) {
        syncInFlightAt = now;
        lastSyncSentAt = now;
        call('sync', [reason || 'manual']);
      } else {
        nextSyncAt = now - 1;
      }
    }

    /** External trigger: the browser announced the network, the page became visible, ... */
    function requestRecovery(reason) {
      var now = nowMs();
      log('watchdog_recovery_requested', { reason: short(reason, 60) });
      // Optimism is not evidence: only the next successful round trip proves connectivity, but both
      // the beat and the resynchronization must be attempted now instead of at the end of a backoff
      // window. RECONNECTING -> SYNC -> ONLINE needs a real synchronization, not just a pulse.
      nextBeatAt = now - 1;
      nextSyncAt = now - 1;
      if (snap.state === STATES.ONLINE || snap.state === STATES.DEGRADED || snap.state === STATES.OFFLINE) {
        transition(STATES.RECONNECTING, reason || 'external');
      }
      // Prove it now instead of waiting for the next tick, but never twice inside the minimum gap:
      // a flapping `online` event must not become a request storm.
      if (!beatInFlightAt && beatGapElapsed(now) && snap.hasCredential) {
        beatInFlightAt = now;
        lastBeatSentAt = now;
        call('beat', ['recovery_request']);
      }
      if (!syncInFlightAt && syncGapElapsed(now) && snap.hasCredential) {
        syncInFlightAt = now;
        lastSyncSentAt = now;
        call('sync', ['recovery_request']);
      }
    }

    /* ------------------------------------------------------------------ escalation ------------*/

    function runtimeHealthy() {
      var status = call('runtimeStatus', []);
      if (!status) return true;
      return status.healthy !== false;
    }

    function reinitRuntime(reason) {
      var now = nowMs();
      var gap = runtimeHealthy() ? cfg.reinitGapMs : cfg.reinitGapWhenUnhealthyMs;
      if (now - lastReinitAt < gap) {
        log('watchdog_reinit_suppressed', { reason: short(reason, 60), gapMs: gap });
        return false;
      }
      lastReinitAt = now;
      snap.runtimeReinits += 1;
      call('reinitRuntime', [reason]);
      return true;
    }

    function reloadAllowed() {
      var now = nowMs();
      if (now - reloadWindowStart > cfg.reloadWindowMs) { reloadWindowStart = now; reloadsInWindow = 0; }
      if (now < reloadCooldownUntil) {
        log('watchdog_reload_budget_exhausted', { inWindow: reloadsInWindow, cooldownMs: cfg.reloadCooldownMs });
        return false;
      }
      if (reloadsInWindow >= cfg.reloadMaxPerWindow) {
        // The budget for this window is spent: a hard cooldown starts NOW, so a permanently broken
        // television shows its last cached frame instead of reloading twice per window forever.
        // The cooldown is armed ONCE and is only cleared when the player proves stable again —
        // a suppressed reload must never extend it, or the page could never reload at all.
        if (!reloadCooldownUntil) reloadCooldownUntil = now + cfg.reloadCooldownMs;
        log('watchdog_reload_budget_exhausted', { inWindow: reloadsInWindow, cooldownMs: cfg.reloadCooldownMs });
        return false;
      }
      return now - lastReloadAt >= 5000;
    }

    function executeReload(reason) {
      if (!reloadAllowed()) {
        log('watchdog_reload_suppressed', { reason: short(reason, 60), inWindow: reloadsInWindow });
        return false;
      }
      transition(STATES.CONTROLLED_RELOAD, reason);
      var accepted = call('reload', [reason]);
      if (accepted === false) {
        log('watchdog_reload_refused', { reason: short(reason, 60) });
        return false;
      }
      snap.reloads += 1;
      lastReloadAt = nowMs();
      if (lastReloadAt - reloadWindowStart > cfg.reloadWindowMs) { reloadWindowStart = lastReloadAt; reloadsInWindow = 0; }
      reloadsInWindow += 1;
      noteRecovery('controlled_reload', reason);
      return true;
    }

    /**
     * Reloading is the last resort, so it is only ever *armed*: if the runtime repairs itself
     * before the delay elapses the reload is cancelled. That is what prevents reload loops.
     */
    function armReload(reason) {
      if (reloadTimer !== null && reloadTimer !== undefined) return false;
      if (snap.state === STATES.AUTH_ERROR || snap.state === STATES.CONFIG_ERROR) {
        // A revoked credential or an unusable configuration cannot be fixed by reloading the page;
        // doing it anyway would produce an endless reload loop against the same broken state.
        log('watchdog_reload_suppressed', { reason: short(reason, 60), state: snap.state });
        return false;
      }
      if (!reloadAllowed()) {
        log('watchdog_reload_suppressed', { reason: short(reason, 60), inWindow: reloadsInWindow });
        return false;
      }
      log('watchdog_reload_armed', { reason: short(reason, 60), delayMs: cfg.reloadArmDelayMs });
      reloadTimer = win.setTimeout(function () {
        reloadTimer = null;
        if (runtimeHealthy()) {
          log('watchdog_reload_cancelled', { reason: short(reason, 60) });
          localRecoveries = 0;
          return;
        }
        executeReload(reason);
      }, cfg.reloadArmDelayMs);
      return true;
    }

    function cancelReload(reason) {
      if (reloadTimer === null || reloadTimer === undefined) return;
      try { win.clearTimeout(reloadTimer); } catch (error) { noop(); }
      reloadTimer = null;
      log('watchdog_reload_disarmed', { reason: short(reason, 60) });
    }

    function controlledReload(reason) {
      cancelReload('superseded');
      return executeReload(reason);
    }

    /* ------------------------------------------------------------------ tick -------------------*/

    function tick() {
      if (destroyed || !started) return;
      var now = nowMs();
      snap.lastTickAt = now;

      // --- B1. Wall-clock gap: the event loop was suspended (TV standby, firmware freeze). -----
      if (lastTickWall) {
        var gap = now - lastTickWall;
        if (gap > cfg.suspendGapMs) {
          snap.suspendGaps += 1;
          snap.lastProgressAt = now;
          log('watchdog_clock_gap', { gapMs: gap });
          // A suspension is NOT a failure: restart the cycle at once, without backoff.
          resetFailureCounters('clock_gap');
          // "Immediate" is expressed relative to the current observation, not as an absolute
          // timestamp: after a suspension the next work must run on this very tick.
          nextBeatAt = now - 1;
          nextSyncAt = now - 1;
          call('abortStale', ['clock_gap']);
          call('onResume', ['clock_gap']);
        } else if (gap > cfg.tickMs * 6) {
          snap.frozenGaps += 1;
          log('watchdog_event_loop_stall', { gapMs: gap });
          markProgress();
        }
      }
      lastTickWall = now;

      // --- B2. In-flight guards: a request that never settles must not stop the loop. ---------
      if (beatInFlightAt && now - beatInFlightAt > cfg.beatTimeoutMs) {
        var beatWaited = now - beatInFlightAt;
        beatInFlightAt = 0;
        log('watchdog_beat_timeout', { waitedMs: beatWaited });
        noteBeatFailure('heartbeat_timeout');
        call('resetBeat', ['heartbeat_timeout']);
      }
      if (syncInFlightAt && now - syncInFlightAt > cfg.syncTimeoutMs) {
        syncInFlightAt = 0;
        log('watchdog_sync_timeout', { waitedMs: cfg.syncTimeoutMs });
        noteSyncFailure('sync_timeout');
        call('resetSync', ['sync_timeout']);
      }

      // --- B3. Application (runtime) progress, at the television-proven 15 s cadence. ----------
      if (now >= nextRuntimeCheckAt) {
        nextRuntimeCheckAt = now + cfg.runtimeCheckMs;
        var status = call('runtimeStatus', []);
        var healthy = !status || status.healthy !== false;
        var hasLocal = !status || status.hasLocal !== false;
        if (healthy) {
          if (snap.emptyStreak !== 0 || emptyStreak !== 0) {
            emptyStreak = 0;
            snap.emptyStreak = 0;
            localRecoveries = 0;
            cancelReload('runtime_healthy');
            // The runtime proved it can render again, so the reload budget is restored. A successful
            // heartbeat alone is NOT proof: a television that cannot paint still has to be reloaded.
            reloadCooldownUntil = 0;
          }
          markProgress();
        } else {
          emptyStreak += 1;
          snap.emptyStreak = emptyStreak;
          log('watchdog_empty_stage', { ticks: emptyStreak, hasLocal: hasLocal, failures: consecutiveFailures });
          if (emptyStreak === 2) {
            // Re-arm the local playlist once before anything heavier is attempted. Rate limited: an
            // empty stage must never turn into a reinitialization loop.
            reinitRuntime('watchdog_empty_stage');
          } else if (emptyStreak >= 4 && hasLocal) {
            emptyStreak = 0;
            localRecoveries += 1;
            if (localRecoveries < 3) {
              noteRecovery('runtime_recover', 'empty_stage');
              reinitRuntime('watchdog_empty_stage');
            } else {
              // Local recovery failed repeatedly: try the network once, then reload the page.
              noteRecovery('runtime_reinitialize', 'empty_stage');
              log('watchdog_runtime_reinitialize', { failures: localRecoveries });
              log('watchdog_page_reload_final', { failures: localRecoveries });
              nextBeatAt = now;
              reinitRuntime('watchdog_runtime_unrecoverable');
              if (!armReload('watchdog_runtime_unrecoverable')) localRecoveries = 0;
            }
          }
        }
      }

      // --- A. Network health: derive the state from real, authenticated communication. ---------
      var sinceSuccess = snap.lastApiSuccessAt ? now - snap.lastApiSuccessAt : (now - snap.bootedAt);
      if (snap.state !== STATES.AUTH_ERROR && snap.state !== STATES.CONFIG_ERROR
        && snap.state !== STATES.CONTROLLED_RELOAD) {
        if (!snap.hasCredential) {
          if (snap.state !== STATES.BOOT && snap.state !== STATES.REGISTER) transition(STATES.REGISTER, 'no_credential');
        } else if (consecutiveFailures === 0 && sinceSuccess <= cfg.staleMs) {
          if (snap.state === STATES.DEGRADED || snap.state === STATES.RECONNECTING
            || snap.state === STATES.RECOVERING || snap.state === STATES.OFFLINE) {
            transition(STATES.ONLINE, 'healthy');
          }
        } else if (sinceSuccess > cfg.offlineMs) {
          if (snap.state !== STATES.OFFLINE) transition(STATES.OFFLINE, 'no_contact');
        } else if (consecutiveFailures >= cfg.recoverAfter) {
          if (snap.state !== STATES.RECOVERING) transition(STATES.RECOVERING, 'repeated_failures');
        } else if (consecutiveFailures >= cfg.reconnectAfter) {
          if (snap.state !== STATES.RECONNECTING) transition(STATES.RECONNECTING, 'repeated_failures');
        } else if (consecutiveFailures >= cfg.degradedAfter || sinceSuccess > cfg.staleMs) {
          if (snap.state === STATES.ONLINE || snap.state === STATES.SYNC || snap.state === STATES.BOOT
            || snap.state === STATES.REGISTER) {
            transition(STATES.DEGRADED, sinceSuccess > cfg.staleMs ? 'stale_connection' : 'first_failure');
          }
        }
      }

      // RECOVERING: rebuild the runtime in place (rate limited). A page reload is only allowed
      // when the runtime is ALSO broken — a long server outage must never reload a playing TV.
      if (snap.state === STATES.RECOVERING) {
        reinitRuntime('repeated_failures');
        if (!runtimeHealthy() && consecutiveFailures >= cfg.reloadAfterFailures) {
          armReload('communication_unrecoverable');
        }
      }

      // --- Schedule the beats, the synchronizations and the daily self-check. ------------------
      if (snap.hasCredential && snap.state !== STATES.AUTH_ERROR) {
        if (!beatInFlightAt && now >= nextBeatAt) {
          beatInFlightAt = now;
          lastBeatSentAt = now;
          call('beat', [snap.state === STATES.ONLINE ? 'scheduled' : snap.state]);
        }
        if (!syncInFlightAt && now >= nextSyncAt && syncGapElapsed(now)) {
          syncInFlightAt = now;
          lastSyncSentAt = now;
          call('sync', [snap.state === STATES.ONLINE ? 'scheduled' : 'recovery']);
        }
      }

      if (now >= nextHousekeepingAt) {
        nextHousekeepingAt = now + cfg.housekeepingMs;
        call('housekeeping', []);
      }

      if (!nextHealthAt) nextHealthAt = snap.bootedAt + cfg.healthFirstDelayMs;
      if (now >= nextHealthAt) {
        // Re-armed BEFORE the call, unconditionally: a self-check that never reports back must not
        // be retried every tick. `setHealthStatus()` then re-schedules it precisely.
        nextHealthAt = now + cfg.healthEveryMs;
        call('healthCheck', [snap.healthCheckedAt ? 'daily' : 'startup']);
      }
    }

    /* ------------------------------------------------------------------ lifecycle --------------*/

    function start() {
      if (started || destroyed) return false;
      started = true;
      var now = nowMs();
      snap.bootedAt = now;
      snap.stateSince = now;
      snap.lastProgressAt = now;
      lastTickWall = now;
      nextBeatAt = now;
      nextSyncAt = now + cfg.minSyncGapMs;
      nextRuntimeCheckAt = now + cfg.runtimeCheckMs;
      reloadWindowStart = now;
      // ONE interval timer for the whole player. Everything else is scheduled from this tick, so
      // there is exactly one heartbeat loop, one synchronization loop and one watchdog.
      timer = win.setInterval(function () {
        try { tick(); }
        catch (error) {
          log('watchdog_tick_failed', { message: short(error && error.message ? error.message : error, 160) });
        }
      }, cfg.tickMs);
      // Run the first evaluation immediately: a television must announce itself as soon as it has a
      // credential, not one tick later.
      try { tick(); }
      catch (error) {
        log('watchdog_tick_failed', { message: short(error && error.message ? error.message : error, 160) });
      }
      return true;
    }

    function stop() {
      started = false;
      if (timer !== null && timer !== undefined) {
        try { win.clearInterval(timer); } catch (error) { noop(); }
      }
      timer = null;
      cancelReload('stopped');
    }

    function destroy() {
      stop();
      destroyed = true;
      if (win && win.__signageWatchdogInstance === publicApi) win.__signageWatchdogInstance = null;
    }

    var publicApi = {
      STATES: STATES,
      start: start,
      stop: stop,
      destroy: destroy,
      isRunning: function () { return started && !destroyed; },
      intervalId: function () { return timer; },
      markHeartbeat: markHeartbeat,
      markSync: markSync,
      markApiSuccess: markApiSuccess,
      markProgress: markProgress,
      markCommand: markCommand,
      noteBeatFailure: noteBeatFailure,
      noteSyncFailure: noteSyncFailure,
      noteFailure: noteFailure,
      noteError: noteError,
      setAuthError: setAuthError,
      setConfigError: setConfigError,
      setHasCredential: setHasCredential,
      setHealthStatus: setHealthStatus,
      requestRecovery: requestRecovery,
      requestSync: requestSync,
      reinitRuntime: reinitRuntime,
      controlledReload: controlledReload,
      reloadAllowed: reloadAllowed,
      lastBackoff: function () { return lastBackoffMs; },
      scheduleBeat: function (delayMs) {
        beatInFlightAt = 0;
        nextBeatAt = nowMs() + Math.max(0, Number(delayMs) || 0);
      },
      scheduleSync: function (delayMs) {
        syncInFlightAt = 0;
        nextSyncAt = nowMs() + Math.max(0, Number(delayMs) || 0);
      },
      snapshot: snapshot,
      state: function () { return snap.state; },
      config: function () { return cfg; }
    };
    if (win) win.__signageWatchdogInstance = publicApi;
    return publicApi;
  }

  return { create: createWatchdog, STATES: STATES, DEFAULTS: DEFAULTS };
});
