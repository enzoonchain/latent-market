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
 * Billing mirrors block.ts: exactly one signed impression per displayed
 * creative with honest cumulative view time (the server's view-time gate
 * decides the credit), and clicks through the loopback /click 302 chain.
 */

/** Baked into the workbench script. A running window that still reports an older id needs a reload. */
export const CURSOR_BUILD = "0.5.6";

export function buildCursorBlock(
  baseUrl: string,
  rotateSeconds: number,
  category: string,
  buildId: string = CURSOR_BUILD,
): string {
  const cfg = JSON.stringify({ base: baseUrl, rotate: rotateSeconds * 1000, cat: category });
  const build = JSON.stringify(buildId);
  return `/* LATENT-CURSOR-START */
(function(){
  "use strict";
  if (window.__latentCursorBoot) return;
  window.__latentCursorBoot = true;
  var CFG = ${cfg};
  var BUILD = ${build};
  function hello() {
    try { fetch(CFG.base + "/hello?build=" + encodeURIComponent(BUILD)).catch(function(){}); } catch (e) {}
  }
  hello();
  setInterval(hello, 30000);
  var el = null, cur = null, rotateTimer = null, billed = false;
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

  function clean(v) {
    return String(v == null ? "" : v).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]/g, "").slice(0, 200);
  }

  function isBusy() {
    var stopBtn = document.querySelector("span.codicon-debug-stop");
    if (stopBtn && stopBtn.offsetParent !== null) return true;
    var composer = document.querySelector("[data-streaming]");
    return !!(composer && composer.getAttribute("data-streaming") === "true");
  }

  function visibleBox(node) {
    if (!node || !node.getBoundingClientRect) return false;
    var r = node.getBoundingClientRect();
    return r.width > 80 && r.height > 16 && r.bottom > 0 && r.top < window.innerHeight;
  }

  function pickLowest(list) {
    var best = null, bestBottom = -1;
    for (var i = 0; i < list.length; i++) {
      var node = list[i];
      if (!visibleBox(node)) continue;
      var bottom = node.getBoundingClientRect().bottom;
      if (bottom >= bestBottom) { bestBottom = bottom; best = node; }
    }
    return best;
  }

  // The agent input is .full-input-box. Prefer the pane that is actually
  // generating, then the lowest visible composer. Read-only: never mutate it.
  function findComposer() {
    var stop = document.querySelector("span.codicon-debug-stop");
    if (stop) {
      var owned = stop.closest(".full-input-box");
      if (visibleBox(owned)) return owned;
      var scope = stop.closest(".split-view-view") || stop.closest(".editor-group-container") || document;
      var local = pickLowest(scope.querySelectorAll(".full-input-box"));
      if (local) return local;
    }
    return pickLowest(document.querySelectorAll(".full-input-box"));
  }

  // The "N Files / Undo All / Review" strip sits just above the input, outside
  // .full-input-box. Anchor above that strip when it is present.
  function anchorTop(input) {
    var top = input.top;
    var bars = document.querySelectorAll("#composer-toolbar-section, .composer-toolbar-section");
    for (var i = 0; i < bars.length; i++) {
      var bar = bars[i];
      if (!visibleBox(bar)) continue;
      var b = bar.getBoundingClientRect();
      var overlaps = b.left < input.right - 8 && b.right > input.left + 8;
      var stacked = b.bottom <= input.top + 12 && input.top - b.bottom < 80;
      if (overlaps && stacked && b.top < top) top = b.top;
    }
    return top;
  }

  function pointOccupied(x, y) {
    if (typeof document.elementsFromPoint !== "function") return false;
    var stack;
    try { stack = document.elementsFromPoint(x, y); } catch (e) { return true; }
    if (!stack) return true;
    for (var i = 0; i < stack.length; i++) {
      var node = stack[i];
      if (!node || node.nodeType !== 1) continue;
      if (node.id === "latent-cursor-overlay" || (node.closest && node.closest("#latent-cursor-overlay"))) continue;
      if (node.hasAttribute && node.hasAttribute("data-latent-dock")) continue;
      var tag = (node.tagName || "").toLowerCase();
      if (tag === "html" || tag === "body" || tag === "style") continue;
      if (/^(button|a|input|textarea|select|svg|img)$/.test(tag)) return true;
      for (var c = 0; c < node.childNodes.length; c++) {
        var child = node.childNodes[c];
        if (child.nodeType === 3 && child.textContent && child.textContent.trim()) return true;
      }
    }
    return false;
  }

  function stripOccupied(rect) {
    var bars = document.querySelectorAll("#composer-toolbar-section, .composer-toolbar-section");
    for (var i = 0; i < bars.length; i++) {
      if (!visibleBox(bars[i])) continue;
      var b = bars[i].getBoundingClientRect();
      var overlaps = b.left < rect.right && b.right > rect.left && b.top < rect.bottom && b.bottom > rect.top;
      if (overlaps) return true;
    }
    var xs = [rect.left + 8, rect.left + rect.width / 2, rect.right - 8];
    var ys = [rect.top + 4, rect.top + rect.height / 2, rect.bottom - 4];
    for (var y = 0; y < ys.length; y++) {
      for (var x = 0; x < xs.length; x++) {
        if (pointOccupied(xs[x], ys[y])) return true;
      }
    }
    return false;
  }

  var dockStyle = null;
  function syncDock(box, px) {
    if (!dockStyle) {
      dockStyle = document.getElementById("latent-dock-style");
      if (!dockStyle) {
        dockStyle = document.createElement("style");
        dockStyle.id = "latent-dock-style";
        (document.head || document.documentElement).appendChild(dockStyle);
      }
    }
    var prev = document.querySelectorAll("[data-latent-dock]");
    for (var i = 0; i < prev.length; i++) if (prev[i] !== box) prev[i].removeAttribute("data-latent-dock");
    if (!box || px <= 0) {
      if (box) box.removeAttribute("data-latent-dock");
      dockStyle.textContent = "";
      return;
    }
    box.setAttribute("data-latent-dock", "1");
    dockStyle.textContent = '[data-latent-dock="1"]::before{content:"";display:block;height:'
      + Math.round(px) + 'px;flex:none;pointer-events:none;}';
  }

  function place() {
    if (!el || el.style.display === "none") { syncDock(null, 0); return; }
    var box = findComposer();
    if (!box) { el.style.visibility = "hidden"; syncDock(null, 0); return; }
    var r = box.getBoundingClientRect();
    var h = el.offsetHeight || 32;
    var gap = 8;
    var top = Math.max(8, anchorTop(r) - h - gap);
    var width = Math.max(180, Math.min(r.width, 640));
    var left = r.left + Math.max(0, (r.width - width) / 2);
    var rect = { left: left, top: top, right: left + width, bottom: top + h, width: width, height: h };
    var occupied = stripOccupied(rect);
    syncDock(box, h + gap);
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
    el.style.bottom = "auto";
    el.style.right = "auto";
    el.style.transform = "none";
    el.style.width = Math.round(width) + "px";
    el.style.visibility = occupied ? "hidden" : "visible";
  }

  function isDataImage(v) {
    return /^data:image\\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+\\/]+=*$/.test(String(v || ""));
  }

  function pageUrl() {
    return cur && /^https:\\/\\/[^\\s]+$/i.test(String(cur.url || "")) ? String(cur.url) : "";
  }

  function openCurrent() {
    if (!cur) return;
    ping("/click", { adId: cur.adId, surface: "cursor" });
    // Only ever navigate to our own loopback chain or a plain https URL —
    // this runs in the privileged workbench, never hand window.open a
    // javascript:/file:/vscode: URL from ad data. Prefer the advertiser https
    // URL so the browser does not stop on the local click redirect.
    var href = /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\//.test(String(cur.clickHref || "")) ? cur.clickHref
      : /^https:\\/\\/[^\\s]+$/i.test(String(cur.url || "")) ? cur.url : "";
    var page = pageUrl() || href;
    if (page) window.open(page, "_blank");
  }

  function copyCurrent(btn) {
    var url = pageUrl();
    if (!url || !btn) return;
    var done = function() {
      var prev = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(function() { if (btn.textContent === "Copied") btn.textContent = prev; }, 1200);
    };
    var fallback = function() {
      try {
        var ta = document.createElement("textarea");
        ta.value = url;
        ta.style.cssText = "position:fixed;left:-9999px;";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      } catch (e) {}
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(function() { fallback(); done(); });
    } else { fallback(); done(); }
  }

  function ensureEl() {
    if (el && el.parentNode) return el;
    el = document.createElement("div");
    el.id = "latent-cursor-overlay";
    el.style.cssText = "position:fixed;z-index:2147483000;display:none;visibility:hidden;left:0;top:0;"
      + "font-family:var(--vscode-font-family,sans-serif);pointer-events:auto;";

    var chip = document.createElement("div");
    chip.style.cssText = "display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;"
      + "background:var(--vscode-editorWidget-background,#252526);color:var(--vscode-foreground,#ccc);"
      + "border:1px solid var(--vscode-widget-border,rgba(128,128,128,.4));border-radius:8px;"
      + "padding:5px 6px 5px 8px;box-shadow:0 6px 20px rgba(0,0,0,.35);";

    var img = document.createElement("img");
    img.setAttribute("data-latent-icon", "1");
    img.alt = "";
    img.style.cssText = "width:16px;height:16px;border-radius:4px;flex:0 0 auto;display:none;object-fit:cover;";

    var mark = document.createElement("span");
    mark.setAttribute("data-latent-mark", "1");
    mark.textContent = "\\u2197";
    mark.style.cssText = "width:16px;height:16px;border-radius:4px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;"
      + "background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);font-size:11px;";

    var text = document.createElement("span");
    text.setAttribute("data-latent-text", "1");
    text.style.cssText = "font-size:12px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;cursor:pointer;text-decoration:none;";

    var tag = document.createElement("span");
    tag.setAttribute("data-latent-tag", "1");
    tag.textContent = "Sponsored";
    tag.style.cssText = "font-size:10px;opacity:.6;flex:0 0 auto;";

    var open = document.createElement("button");
    open.type = "button";
    open.setAttribute("data-latent-open", "1");
    open.textContent = "Open";
    open.style.cssText = "flex:0 0 auto;cursor:pointer;border:0;border-radius:4px;padding:3px 8px;font-size:11px;font-weight:600;"
      + "background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);";

    var copy = document.createElement("button");
    copy.type = "button";
    copy.setAttribute("data-latent-copy", "1");
    copy.textContent = "Copy";
    copy.style.cssText = "flex:0 0 auto;cursor:pointer;border-radius:4px;padding:3px 8px;font-size:11px;"
      + "border:1px solid var(--vscode-widget-border,rgba(128,128,128,.45));background:transparent;color:inherit;";

    chip.appendChild(img);
    chip.appendChild(mark);
    chip.appendChild(text);
    chip.appendChild(tag);
    chip.appendChild(open);
    chip.appendChild(copy);
    el.appendChild(chip);
    open.addEventListener("click", function(ev) { ev.preventDefault(); ev.stopPropagation(); openCurrent(); });
    copy.addEventListener("click", function(ev) { ev.preventDefault(); ev.stopPropagation(); copyCurrent(copy); });
    text.addEventListener("click", function() { openCurrent(); });
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

  // Exactly one /impression per displayed creative: billable at the 10s view
  // threshold (fires immediately), otherwise honest cumulative dwell at cycle
  // end and the server's view-time gate decides the credit.
  function markEarned() {
    if (!cur || !el) return;
    var tag = el.querySelector("[data-latent-tag]");
    var earned = Number(cur.earnAmount);
    var label = isFinite(earned) && earned > 0 ? "+$" + earned.toFixed(earned >= 0.01 ? 2 : 4) : "";
    if (tag && label) {
      tag.textContent = label;
      tag.style.color = "#3cc36b";
      tag.style.opacity = "1";
      tag.style.fontWeight = "700";
    }
  }

  function bill() {
    if (!cur || !cur.adId || billed) return;
    billed = true;
    var ms = cumulativeMs;
    var ad = cur;
    ping("/metric", { event: ms >= 10000 ? "view_threshold_met" : "error_impression", adId: cur.adId, cumulative_ms: ms });
    var payload = JSON.stringify({ adId: ad.adId, token: ad.token, displayedMs: ms, surface: "cursor" });
    fetch(CFG.base + "/impression", { method: "POST", body: payload, keepalive: true })
      .then(function(r) { return r.json(); })
      .then(function(j) {
        if (j && j.status === "tracked" && cur === ad) markEarned();
      })
      .catch(function() {});
  }

  function reportViewable() {
    if (!cur || !cur.adId) return;
    ping("/metric", { event: "impression_viewable", adId: cur.adId });
  }

  function reportViewTick() {
    if (!cur || !cur.adId) return;
    ping("/metric", { event: "view_tick", adId: cur.adId, cumulative_ms: cumulativeMs });
  }

  function show() {
    if (!cur) return;
    var container = ensureEl();
    var img = container.querySelector("[data-latent-icon]");
    var mark = container.querySelector("[data-latent-mark]");
    var text = container.querySelector("[data-latent-text]");
    var icon = isDataImage(cur.iconUrl) ? cur.iconUrl : "";
    if (icon && img) { img.src = icon; img.style.display = "block"; if (mark) mark.style.display = "none"; }
    else if (img && mark) { img.style.display = "none"; mark.style.display = "inline-flex"; }
    if (text) { text.textContent = clean(cur.text).slice(0, 72); text.removeAttribute("title"); }
    container.removeAttribute("title");
    var tag = container.querySelector("[data-latent-tag]");
    if (tag) { tag.textContent = "Sponsored"; tag.style.color = ""; tag.style.opacity = ".6"; tag.style.fontWeight = ""; }
    container.style.display = "block";
    place();
  }

  function hide() {
    if (el) el.style.display = "none";
    syncDock(null, 0);
  }

  function lineVisible() {
    if (document.visibilityState === "hidden") return false;
    if (!el || el.style.display === "none" || el.style.visibility === "hidden") return false;
    return true;
  }

  function rotate() {
    if (!isBusy()) return;
    bill();
    fetchAd().then(function(ad) {
      cur = ad;
      billed = false;
      cumulativeMs = 0;
      if (ad) {
        ping("/metric", { event: "impression_rendered", adId: ad.adId });
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
    lastResume = 0;
    viewTickTimer = setInterval(function() {
      if (!isBusy()) { pauseViewTicks(); return; }
      place();
      if (!lineVisible()) { lastResume = 0; return; }
      var now = Date.now();
      if (lastResume) cumulativeMs += now - lastResume;
      lastResume = now;
      reportViewTick();
      if (cumulativeMs >= 10000) bill();
    }, 2500);
  }

  function pauseViewTicks() {
    if (viewTickTimer) { clearInterval(viewTickTimer); viewTickTimer = null; }
    if (lastResume && lineVisible()) cumulativeMs += Date.now() - lastResume;
    lastResume = 0;
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
      billed = false;
      rotate();
      rotateTimer = setInterval(rotate, Math.max(3000, CFG.rotate));
    } else if (!nowBusy && lastBusy) {
      // Idle dock: settle the open view, then keep the last creative above the
      // composer. No new /ad request and no view ticks until the agent is busy.
      bill();
      stopViewTicks();
      if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
    }
    if (cur) place();
    lastBusy = nowBusy;
  }, 500);
})();
/* LATENT-CURSOR-END */`;
}

export const CURSOR_MARK_START = "/* LATENT-CURSOR-START */";
export const CURSOR_MARK_END = "/* LATENT-CURSOR-END */";
