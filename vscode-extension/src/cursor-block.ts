/**
 * Cursor workbench overlay — ad block in the agent composer area.
 *
 * Unlike the Claude Code / Codex bundle patch, Cursor's workbench DOESN'T
 * execute appended bundle code. Instead we inject a `<script src>` tag into
 * `workbench.html` pointing at a sibling `latent-cursor-block.js` file.
 *
 * Busy detection: Cursor's send button becomes `span.codicon-debug-stop`
 * while the agent is generating (verified on 3.9.x). Fallback: `[data-streaming]`.
 *
 * The block communicates ONLY with the local loopback via `sendBeacon`
 * (text/plain Blob to avoid CORS preflight from the vscode-file:// origin).
 */

export function buildCursorBlock(
  baseUrl: string,
  rotateSeconds: number,
  category: string,
): string {
  const cfg = JSON.stringify({ base: baseUrl, rotate: rotateSeconds * 1000, cat: category });
  return `/* LATENT-CURSOR-START */
(function(){
  "use strict";
  if (window.__latentCursorBoot) return;
  window.__latentCursorBoot = true;
  var CFG = ${cfg};
  var el = null, cur = null, shownAt = 0, rotateTimer = null;
  var viewTickTimer = null, cumulativeMs = 0, lastResume = 0;

  function ping(path, body) {
    try {
      var payload = JSON.stringify(body || {});
      if (navigator && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(CFG.base + path, new Blob([payload], { type: "text/plain" }));
      } else {
        fetch(CFG.base + path, { method: "POST", body: payload, keepalive: true }).catch(function(){});
      }
    } catch(e){}
  }

  function isBusy() {
    var stopBtn = document.querySelector("span.codicon-debug-stop");
    if (stopBtn && stopBtn.offsetParent !== null) return true;
    var composer = document.querySelector("[data-streaming]");
    return !!(composer && composer.getAttribute("data-streaming") === "true");
  }

  function ensureEl() {
    if (el && el.parentNode) return el;
    el = document.createElement("div");
    el.id = "latent-cursor-overlay";
    el.style.cssText = "position:fixed;bottom:80px;left:50%;transform:translateX(-50%);"
      + "background:var(--vscode-editorWidget-background,#1e1e1e);color:var(--vscode-foreground,#ccc);"
      + "border:1px solid var(--vscode-widget-border,rgba(128,128,128,.35));border-radius:6px;"
      + "padding:4px 12px;font-size:11px;z-index:99999;pointer-events:auto;max-width:420px;"
      + "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:none;";
    document.body.appendChild(el);
    return el;
  }

  async function fetchAd() {
    try {
      var r = await fetch(CFG.base + "/ad?cat=" + encodeURIComponent(CFG.cat));
      var j = await r.json();
      return j && j.ad ? j.ad : null;
    } catch(e) { return null; }
  }

  function reportImpression(ms) {
    if (!cur || !cur.adId) return;
    ping("/impression", { adId: cur.adId, token: cur.token, displayedMs: ms });
  }

  function reportViewable() {
    if (!cur || !cur.adId) return;
    ping("/metric", { event: "impression_viewable", adId: cur.adId });
  }

  function reportViewTick() {
    if (!cur || !cur.adId) return;
    ping("/metric", { event: "view_tick", adId: cur.adId, cumulative_ms: cumulativeMs });
  }

  function reportThresholdMet() {
    if (!cur || !cur.adId) return;
    ping("/metric", { event: "view_threshold_met", adId: cur.adId, cumulative_ms: cumulativeMs });
  }

  function show() {
    if (!cur) return;
    var container = ensureEl();
    container.textContent = "\\uD83D\\uDCA1 " + (cur.text || "").slice(0, 60);
    container.title = cur.url || "Latent Protocol";
    container.style.display = "block";
    container.onclick = function() {
      if (cur && cur.url) window.open(cur.url, "_blank");
    };
  }

  function hide() {
    if (el) el.style.display = "none";
  }

  function rotate() {
    if (!isBusy()) { hide(); return; }
    reportImpression(Date.now() - shownAt);
    fetchAd().then(function(ad) {
      cur = ad;
      shownAt = Date.now();
      if (ad) {
        show();
        reportViewable();
        startViewTicks();
      } else {
        hide();
      }
    });
  }

  function startViewTicks() {
    stopViewTicks();
    lastResume = Date.now();
    viewTickTimer = setInterval(function() {
      if (!isBusy()) { pauseViewTicks(); return; }
      cumulativeMs += Date.now() - lastResume;
      lastResume = Date.now();
      reportViewTick();
      if (cumulativeMs >= 10000 && !cur._thresholdMet) {
        cur._thresholdMet = true;
        reportThresholdMet();
      }
    }, 2500);
  }

  function pauseViewTicks() {
    if (viewTickTimer) { clearInterval(viewTickTimer); viewTickTimer = null; }
    if (lastResume) {
      cumulativeMs += Date.now() - lastResume;
      lastResume = 0;
    }
  }

  function stopViewTicks() {
    pauseViewTicks();
  }

  // Monitor busy state changes
  var lastBusy = false;
  setInterval(function() {
    var nowBusy = isBusy();
    if (nowBusy && !lastBusy) {
      cumulativeMs = 0;
      cur = null;
      rotate();
      rotateTimer = setInterval(rotate, Math.max(3000, CFG.rotate));
    } else if (!nowBusy && lastBusy) {
      reportImpression(Date.now() - shownAt);
      stopViewTicks();
      if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
      hide();
      cur = null;
      cumulativeMs = 0;
    }
    lastBusy = nowBusy;
  }, 500);
})();
/* LATENT-CURSOR-END */`;
}

export const CURSOR_MARK_START = "/* LATENT-CURSOR-START */";
export const CURSOR_MARK_END = "/* LATENT-CURSOR-END */";
