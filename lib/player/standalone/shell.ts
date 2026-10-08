/*
 * Standalone player shell for /player.
 *
 * This module is the entire server-side contribution to the TV player: one static HTML document
 * with inline compatibility-safe CSS, an inline ES5 boot guard and three classic script tags.
 * It deliberately pulls in NO React, NO Next.js client runtime, NO module script, NO nomodule
 * script and NO modern CSS (no grid, no gap, no CSS variables, no min()/max()/clamp()).
 *
 * Why: webOS 3.5 (LG UJ634V) is Chromium 38. The previous /player was a React client component
 * whose chunks require ES2022 syntax (`globalThis`, `?.`, `??`, arrow functions), so the TV aborted
 * with a SyntaxError/ReferenceError before React mounted and the page stayed a dead screenshot.
 *
 * Guarantees this shell provides on its own, without any JavaScript succeeding:
 *   1. A visible panel (logo, title, Arabic status text) is painted from static HTML.
 *   2. A pure-HTML retry link (`<a href="/player">`) always works.
 *   3. `window.__signageGuard` reveals the diagnostic panel with the browser report if the runtime
 *      never signals `__signageBooted`, or if a player script fails to load (onerror).
 */
export const PLAYER_VERSION = '2.0.0-1';

export const PLAYER_ASSETS = ['/player/sha256.js', '/player/runtime.js', '/player/player.js'] as const;

const STYLES = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; height: 100%; background: #050a12; color: #eef3f8;
  font-family: Tahoma, Arial, "Noto Naskh Arabic", sans-serif; font-size: 15px; overflow: hidden; }
img { border: 0; }
h1 { font-size: 24px; margin: 0 0 10px; }
h2 { font-size: 14px; margin: 18px 0 8px; color: #9fb4cc; font-weight: normal; }
p { line-height: 1.8; margin: 0 0 12px; color: #c3d2e3; }
#signage-root { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 1; }
.sp-stage { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: #050a12; overflow: hidden; }
.sp-media, .sp-video { position: absolute; top: 50%; left: 50%; max-width: 100%; max-height: 100%;
  -webkit-transform: translate(-50%, -50%); transform: translate(-50%, -50%); background: #050a12; }
.sp-video { background: transparent; }
.sp-overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; padding: 4%;
  text-align: center; background: #050a12; overflow: hidden; }
.sp-overlay-quiet { background: rgba(5, 10, 18, .82); }
.sp-overlay:before { content: ""; display: inline-block; height: 100%; width: 0; vertical-align: middle; }
.sp-ui { display: inline-block; vertical-align: middle; text-align: right; max-width: 100%; max-height: 100%; }
.sp-panel { display: inline-block; text-align: right; width: 620px; max-width: 92%; background: #101e33;
  border: 1px solid #24374f; border-radius: 16px; padding: 24px 26px; }
.sp-panel-wide { width: 1080px; max-height: 100%; overflow: auto; }
.sp-logo { width: 54px; height: 54px; line-height: 54px; text-align: center; margin: 0 0 14px;
  border-radius: 16px; background: #28b9a8; color: #08272c; font-size: 24px; font-weight: bold; }
.sp-note { font-size: 12px; color: #91a6bf; }
.sp-alert { border-radius: 10px; padding: 10px 12px; margin: 0 0 12px; font-size: 13px; }
.sp-alert-error { background: #34161c; border: 1px solid #6d2b36; color: #ffd7dc; }
.sp-alert-warn { background: #33290f; border: 1px solid #6d5a1f; color: #ffeec2; }
.sp-form { margin: 14px 0 6px; }
.sp-field { margin: 0 0 14px; }
.sp-field label { display: block; font-size: 12px; color: #9fb4cc; margin: 0 0 6px; }
.sp-field input { width: 100%; min-height: 48px; padding: 0 12px; background: #0b1626; color: #fff;
  border: 1px solid #314660; border-radius: 10px; font-size: 22px; text-align: center; letter-spacing: 4px; }
.sp-button { display: inline-block; min-height: 44px; line-height: 44px; padding: 0 18px; margin: 8px 0 0 8px;
  border: 1px solid #2f4a6b; border-radius: 10px; background: #1b2c45; color: #eef3f8;
  font-size: 15px; font-family: inherit; text-decoration: none; cursor: pointer; }
.sp-button.sp-primary { background: #28b9a8; border-color: #28b9a8; color: #061d22; font-weight: bold; }
.sp-button.sp-secondary { background: #16253c; border-color: #2b4260; }
.sp-track { height: 10px; background: #0b1626; border: 1px solid #24374f; border-radius: 6px; overflow: hidden; }
.sp-fill { height: 100%; width: 0; background: #28b9a8; }
.sp-status { position: absolute; left: 3%; bottom: 3%; z-index: 3; max-width: 94%; padding: 6px 10px;
  background: rgba(5, 10, 18, .55); border-radius: 8px; font-size: 12px; color: #cfdceb;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; cursor: pointer; }
.sp-dot { color: #7d8ea3; margin-left: 6px; }
.sp-dot-on { color: #2dd4bf; }
.sp-notice { color: #ffd9a0; }
.sp-list { border-top: 1px solid #22334a; }
.sp-list-columns { display: block; }
.sp-row { padding: 6px 0; border-bottom: 1px solid #1b2a3e; font-size: 13px; word-wrap: break-word; }
.sp-list-columns .sp-row { display: inline-block; width: 49%; vertical-align: top; }
.sp-key { color: #9fb4cc; margin-left: 10px; display: inline-block; min-width: 170px; }
.sp-ok { color: #4ade80; }
.sp-no { color: #f59e9e; }
.sp-mono { font-family: Consolas, Menlo, monospace; direction: ltr; text-align: left; font-size: 12px; }
.sp-log { max-height: 180px; overflow: auto; }
.sp-actions { margin-top: 16px; }
#signage-fatal { position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 9; padding: 4%;
  text-align: center; background: #050a12; overflow: auto; }
#signage-fatal:before { content: ""; display: inline-block; height: 100%; width: 0; vertical-align: middle; }
#signage-fatal .sp-panel { vertical-align: middle; }
`;

const GUARD_SCRIPT = `
(function () {
  var w = window;
  w.__signageBooted = false;
  function setText(id, value) {
    try {
      var node = document.getElementById(id);
      if (node) node.innerHTML = '';
      if (node && value) node.appendChild(document.createTextNode(String(value)));
    } catch (e) { }
  }
  function chromiumVersion() {
    try {
      var m = /(?:Chrome|Chromium)\\/([0-9]+)/i.exec(navigator.userAgent || '');
      if (m) return m[1];
      var q = /QtWebEngine\\/([0-9.]+)/i.exec(navigator.userAgent || '');
      if (q) return q[1];
    } catch (e) { }
    return 'unknown';
  }
  w.__signageGuard = function (reason) {
    try {
      if (w.__signageBooted) return;
      var panel = document.getElementById('signage-fatal');
      if (!panel) return;
      var details = [];
      details.push('UA: ' + (navigator.userAgent || 'unknown'));
      details.push('Chromium: ' + chromiumVersion());
      details.push('sha256.js: ' + (w.SignageSha256 ? 'loaded' : 'missing'));
      details.push('runtime.js: ' + (w.SignagePlayerRuntime ? 'loaded' : 'missing'));
      details.push('player.js: ' + (w.SignagePlayerUI ? 'loaded' : 'missing'));
      details.push('indexedDB: ' + (w.indexedDB ? 'yes' : 'no') + ' / fetch: ' + (w.fetch ? 'yes' : 'no') +
        ' / XMLHttpRequest: ' + (w.XMLHttpRequest ? 'yes' : 'no') + ' / Promise: ' + (w.Promise ? 'yes' : 'no'));
      setText('signage-fatal-reason', reason || 'script execution stopped before the player reported readiness');
      setText('signage-fatal-ua', details.join(' | '));
      setText('signage-fatal-href', (w.location && w.location.href) || '');
      panel.style.display = 'block';
    } catch (e) { }
  };
  setTimeout(function () { try { w.__signageGuard('the player did not report readiness within 15 seconds'); } catch (e) { } }, 15000);
  // Optional, best effort: an offline shell for browsers that support service workers. webOS 3.5
  // has none, and the player works exactly the same without it (cached media lives in IndexedDB).
  try {
    if (w.navigator && w.navigator.serviceWorker && w.navigator.serviceWorker.register) {
      w.navigator.serviceWorker.register('/sw.js', { scope: '/' })['catch'](function () { });
    }
  } catch (e) { }
})();
`;

function onErrorTag(source: string, label: string): string {
  return `<script src="${source}?v=${PLAYER_VERSION}" onerror="window.__signageGuard && window.__signageGuard('تعذر تحميل ملف المشغل: ${label}')"></script>`;
}

export function renderPlayerShell(): string {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#101e33">
<title>مشغل الشاشة</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>${STYLES}</style>
</head>
<body>
<div id="signage-root">
  <div class="sp-stage"></div>
  <div class="sp-overlay">
    <div class="sp-ui">
      <div class="sp-panel">
        <div class="sp-logo">ش</div>
        <h1>مشغل الشاشة</h1>
        <p>جارٍ تشغيل المشغل…</p>
        <div class="sp-list">
          <div class="sp-row sp-note">التلفاز يشغّل واجهة متوافقة مع webOS 3.5 ومتصفحات التلفاز القديمة.</div>
          <div class="sp-row sp-note">إذا لم تتغير هذه الشاشة تلقائياً، استخدم زر إعادة المحاولة.</div>
        </div>
        <div class="sp-actions">
          <a class="sp-button sp-primary" href="/player?diag=1">إعادة المحاولة والتحقق</a>
        </div>
      </div>
    </div>
  </div>
  <div class="sp-status">● جارٍ التحميل…</div>
</div>

<div id="signage-fatal" style="display:none">
  <div class="sp-ui">
    <div class="sp-panel sp-panel-wide">
      <div class="sp-logo">ش</div>
      <h1>مشغل الشاشة غير متوافق مع إصدار المتصفح الحالي</h1>
      <div class="sp-alert sp-alert-error" id="signage-fatal-reason"></div>
      <p>تعذر تشغيل المشغل أو استكمال التحميل في هذا المتصفح. البيانات التالية تساعد على تحديد السبب على هذا الطراز.</p>
      <h2>معلومات المتصفح وإصدار webOS</h2>
      <div class="sp-list">
        <div class="sp-row sp-mono" id="signage-fatal-ua"></div>
        <div class="sp-row sp-mono" id="signage-fatal-href"></div>
        <div class="sp-row sp-note">ملاحظة: طرازات LG 2016 (webOS 3.x) تعمل بمحرك Chromium 38، وهو لا يدعم وحدات ES الحديثة أو الوعود المتقدمة. هذا المشغل مصمم للعمل عليه، وإذا ظهرت هذه الرسالة فغالباً أحد ملفات المشغل لم يُحمّل أو لم يُنفّذ.</div>
      </div>
      <h2>ما يمكن فعله الآن</h2>
      <div class="sp-list">
        <div class="sp-row">1. اضغط «إعادة المحاولة» أدناه لتحميل المشغل من جديد.</div>
        <div class="sp-row">2. تأكد من وصول التلفاز إلى الإنترنت عبر HTTPS ثم أعد التشغيل.</div>
        <div class="sp-row">3. من متصفح الحاسوب افتح نفس الرابط للتأكد من أن الشاشة مربوطة وأن المحتوى منشور.</div>
        <div class="sp-row">4. إذا تكررت الرسالة، فقد يحتاج هذا الطراز إلى تطبيق webOS أصلي بدلاً من متصفح الويب.</div>
      </div>
      <div class="sp-actions">
        <a class="sp-button sp-primary" href="/player?diag=1">إعادة المحاولة</a>
        <a class="sp-button sp-secondary" href="/player">تحميل المشغل فقط</a>
      </div>
    </div>
  </div>
</div>

<noscript>
  <div class="sp-ui" style="position:fixed;top:0;left:0;right:0;bottom:0;z-index:10;background:#050a12;text-align:center;padding:6%">
    <div class="sp-panel">
      <h1>المتصفح لا يشغّل الجافاسكربت</h1>
      <p>يجب تمكين الجافاسكربت في متصفح التلفاز لتشغيل المشغل. بعد التمكين أعد فتح الرابط.</p>
    </div>
  </div>
</noscript>

<script>${GUARD_SCRIPT}</script>
${onErrorTag('/player/sha256.js', 'sha256.js')}
${onErrorTag('/player/runtime.js', 'runtime.js')}
${onErrorTag('/player/player.js', 'player.js')}
</body>
</html>
`;
}
