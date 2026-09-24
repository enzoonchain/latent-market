/**
 * The self-contained JS injected into the agent webview bundle. It watches the
 * agent's spinner row and, while the agent is busy, adds a quiet sponsor line
 * (and swaps the spinner glyph for the advertiser icon) from the local loopback — rotating on a
 * fixed cadence and billing honestly: exactly one signed impression per ad
 * cycle (sent at the 10s view threshold, or at cycle end with the real dwell
 * time so the server's view-time gate decides the credit), plus a real <a> click
 * path through the loopback 302 chain. Wrapped in LATENT markers so the patcher
 * can find/replace/remove it precisely.
 */
export const MARK_START = "/* LATENT-START */";
export const MARK_END = "/* LATENT-END */";
export const BLOCK_BUILD = "0.5.8";

export function buildBlock(baseUrl: string, rotateSeconds: number, category: string): string {
  const cfg = JSON.stringify({ base: baseUrl, rotate: rotateSeconds * 1000, cat: category });
  // NOTE: body runs in the webview. No imports, no external hosts — only the
  // 127.0.0.1 loopback (allowed via the CSP relaxation the patcher applies).
  // The click is a REAL anchor to the loopback /click 302 chain (the server
  // credits and redirects on to the advertiser) — the fetch twin is best-effort
  // only, since some webviews block connect-src even when relaxed — never
  // trust beacon delivery from a webview, make the href).
  return `${MARK_START}
(function(){
  try {
    if (window.__latentActive) return; window.__latentActive = true;
    var LATENT_BUILD = "${BLOCK_BUILD}";
    var CFG = ${cfg};
    var PANE = Math.random().toString(16).slice(2, 10);
    var MIN_VIEW_MS = 10000, TICK_MS = 2500;
    var cur = null, viewing = false, viewSince = 0, cumMs = 0, billed = false, serverCredited = false, tickAt = 0, viewableSent = false;
    function tokenStarts(el, prefix){
      var cl = el && el.classList;
      if (!cl) return false;
      for (var i = 0; i < cl.length; i++) if (cl[i].indexOf(prefix) === 0) return true;
      return false;
    }
    function lastMatch(selector, accept){
      var els = document.querySelectorAll(selector);
      var last = null;
      for (var i = 0; i < els.length; i++) {
        if (accept && !accept(els[i])) continue;
        if (els[i].offsetParent === null && els[i] !== document.body) continue;
        last = els[i];
      }
      return last;
    }
    // Read-only. Claude's live row is spinnerRow_; Codex's live row is the
    // thinking shimmer (the hashed class still contains cadencedShimmer).
    // Never write into either: React tears the row out if a child changes.
    function spinner(){
      return lastMatch('[class*="spinnerRow_"]', function(el){
          return tokenStarts(el, "spinnerRow_") && (el.textContent || "").replace(/\\s/g, "") !== "";
        })
        || lastMatch('[class*="statusRow_"]', function(el){ return tokenStarts(el, "statusRow_"); })
        || lastMatch('[class*="cadencedShimmer"]', null)
        || document.querySelector('[data-latent-spinner]');
    }
    function busy(){ var s = spinner(); return !!(s && s.offsetParent !== null); }
    function visible(){ return document.visibilityState === 'visible'; }
    function onScreen(){ return busy() && visible(); }
    function clean(v){ return String(v == null ? '' : v).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]/g,'').slice(0,200); }
    function isHttps(v){ return String(v || '').toLowerCase().indexOf('https://') === 0; }
    function isLoopback(v){ return /^http:\\/\\/127\\.0\\.0\\.1:\\d+\\//.test(String(v || '')); }
    // The loopback inlines the advertiser icon as a data: URI (the webview's
    // img-src only allows data:). Anything else is ignored.
    function isDataImage(v){ return /^data:image\\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+\\/]+=*$/.test(String(v || '')); }
    // Swap the host's animated spinner glyph for the advertiser icon. In the
    // Claude Code webview (checked against 2.1.278) the glyph is the first of
    // two aria-hidden spans in the spinner row. The icon is a background on
    // that span with its own glyph text made transparent: the host rewrites
    // the text every ~120ms but never touches these style properties, so
    // there is nothing to race. Unknown structure or no icon: leave it alone.
    var GLYPH_STYLE = ['backgroundImage','backgroundSize','backgroundRepeat','backgroundPosition','color','display','width','height','verticalAlign','borderRadius'];
    var styledGlyph = null;
    function restoreGlyph(){
      if(!styledGlyph) return;
      for(var i = 0; i < GLYPH_STYLE.length; i++) styledGlyph.style[GLYPH_STYLE[i]] = '';
      styledGlyph.removeAttribute('data-latent-icon');
      styledGlyph = null;
    }
    function paintIcon(s){
      var spans = s.querySelectorAll('span[aria-hidden="true"]');
      var g = spans.length >= 2 ? spans[0] : null;
      var icon = cur && isDataImage(cur.iconUrl) ? cur.iconUrl : '';
      if(styledGlyph && styledGlyph !== g) restoreGlyph();
      if(!g || !icon){ restoreGlyph(); return; }
      if(g.getAttribute('data-latent-icon') === cur.adId) return;
      var st = g.style;
      st.backgroundImage = 'url("' + icon + '")';
      st.backgroundSize = 'contain'; st.backgroundRepeat = 'no-repeat'; st.backgroundPosition = 'center';
      st.color = 'transparent'; st.display = 'inline-block'; st.width = '1em'; st.height = '1em';
      st.verticalAlign = 'middle'; st.borderRadius = '3px';
      g.setAttribute('data-latent-icon', cur.adId);
      styledGlyph = g;
    }
    function metric(event, extra){
      try { fetch(CFG.base + '/metric', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(Object.assign({ event: event, adId: cur ? cur.adId : '' }, extra || {})) }); } catch(e){}
    }
    async function fetchAd(){
      try {
        var r = await fetch(CFG.base + '/ad?cat=' + encodeURIComponent(CFG.cat) + '&pane=' + encodeURIComponent(PANE));
        var j = await r.json(); return j && j.ad ? j.ad : null;
      } catch(e){ return null; }
    }
    function totalMs(){ return cumMs + (viewing ? Date.now() - viewSince : 0); }
    // Exactly one /impression per ad cycle. At MIN_VIEW_MS of real view time it
    // fires immediately (billable); if the cycle ends sooner, the honest dwell
    // time is sent anyway and the server's view-time gate decides the credit.
    function bill(){
      if(!cur || !cur.adId || billed) return; billed = true;
      var ms = totalMs();
      var ad = cur;
      metric(ms >= MIN_VIEW_MS ? 'view_threshold_met' : 'error_impression', { cumulative_ms: ms });
      fetch(CFG.base + '/impression', { method:'POST', headers:{'Content-Type':'application/json'}, keepalive: true,
        body: JSON.stringify({ adId: ad.adId, token: ad.token, displayedMs: ms, surface: 'spinner', pane: PANE }) })
        .then(function(r){ return r.json(); })
        .then(function(j){ if(j && j.status === 'tracked' && cur === ad){ serverCredited = true; paint(); } })
        .catch(function(){});
    }
    function leave(){ if(!viewing) return; cumMs += Date.now() - viewSince; viewing = false; }
    function endCycle(){
      if(!cur) return;
      leave(); bill();
      restoreGlyph();
      cur = null; cumMs = 0; billed = false; serverCredited = false; viewableSent = false; tickAt = 0;
    }
    var overlay = null;
    function hideOverlay(){ if(overlay) overlay.style.display = 'none'; }
    function ensureOverlay(){
      if(overlay && overlay.parentNode) return overlay;
      overlay = document.createElement('div');
      overlay.setAttribute('data-latent-row','1');
      overlay.style.cssText = 'position:fixed;z-index:2147483000;display:none;align-items:center;gap:6px;padding:0 8px;box-sizing:border-box;overflow:hidden;pointer-events:auto;background:transparent;color:inherit;';
      var img = document.createElement('img');
      img.setAttribute('data-latent-favicon','1');
      img.alt = '';
      img.style.cssText = 'width:14px;height:14px;border-radius:3px;display:none;object-fit:cover;flex:none;';
      var label = document.createElement('a');
      label.setAttribute('data-latent-label','1');
      label.style.cssText = 'color:inherit;text-decoration:underline;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px;';
      var tag = document.createElement('span');
      tag.setAttribute('data-latent-tag','1');
      tag.style.cssText = 'font-size:10px;opacity:.65;flex:none;';
      var open = document.createElement('a');
      open.setAttribute('data-latent-open','1');
      open.textContent = 'Open';
      open.style.cssText = 'flex:none;cursor:pointer;text-decoration:none;border:1px solid currentColor;border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px;opacity:.9;';
      function onClick(){
        try { fetch(CFG.base + '/click', { method:'POST', headers:{'Content-Type':'application/json'}, keepalive: true,
          body: JSON.stringify({ adId: cur ? cur.adId : '', surface: 'spinner' }) }); } catch(e){}
      }
      label.addEventListener('click', onClick);
      open.addEventListener('click', onClick);
      overlay.appendChild(img); overlay.appendChild(label); overlay.appendChild(tag); overlay.appendChild(open);
      (document.body || document.documentElement).appendChild(overlay);
      return overlay;
    }
    function placeOverlay(s){
      var r = s.getBoundingClientRect();
      if(!r || (!r.width && !r.height)){ hideOverlay(); return; }
      overlay.style.display = 'inline-flex';
      overlay.style.left = r.left + 'px';
      overlay.style.top = (r.bottom + 2) + 'px';
      overlay.style.width = Math.max(r.width, 280) + 'px';
      overlay.style.height = '22px';
    }
    function paint(){
      var s = spinner(); if(!s || !cur){ hideOverlay(); return; }
      var row = ensureOverlay();
      var labelEl = row.querySelector('[data-latent-label]');
      var openEl = row.querySelector('[data-latent-open]');
      var tagEl = row.querySelector('[data-latent-tag]');
      var imgEl = row.querySelector('[data-latent-favicon]');
      var url = isHttps(cur.url) ? clean(cur.url) : '';
      var href = isLoopback(cur.clickHref) ? clean(cur.clickHref) : '';
      labelEl.textContent = clean(cur.text);
      labelEl.removeAttribute('title');
      openEl.removeAttribute('title');
      if(href){ labelEl.setAttribute('href', href); openEl.setAttribute('href', href); }
      else { labelEl.removeAttribute('href'); openEl.removeAttribute('href'); }
      if(serverCredited){
        tagEl.textContent = 'credited';
        tagEl.style.color = '#16a34a';
        tagEl.style.opacity = '1';
        tagEl.style.fontWeight = '700';
      } else {
        tagEl.textContent = '\u00b7 Sponsored';
        tagEl.style.color = '';
        tagEl.style.opacity = '.65';
        tagEl.style.fontWeight = '';
      }
      var icon = isDataImage(cur.iconUrl) ? cur.iconUrl : '';
      if(icon){ imgEl.src = icon; imgEl.style.display = 'inline-block'; }
      else { imgEl.style.display = 'none'; }
      placeOverlay(s);
    }
    async function show(){
      if(cur) return;
      cur = await fetchAd();
      if(!cur) return;
      cumMs = 0; billed = false; serverCredited = false; viewableSent = false; tickAt = Date.now();
      metric('impression_rendered');
      paint();
    }
    function watch(){
      if(onScreen()){
        show().then(function(){
          if(!cur || !onScreen()) return;
          if(!viewing){ viewing = true; viewSince = Date.now(); }
          if(!viewableSent){ viewableSent = true; metric('impression_viewable'); }
          if(Date.now() - tickAt >= TICK_MS){ tickAt = Date.now(); metric('view_tick', { cumulative_ms: totalMs() }); }
          if(!billed && totalMs() >= MIN_VIEW_MS) bill();
          paint();
        });
      } else if(cur){ endCycle(); hideOverlay(); }
    }
    setInterval(watch, 500);
    setInterval(function(){ if(onScreen() && cur){ endCycle(); show(); } }, CFG.rotate);
  } catch(e) { /* fail open — never break the host webview */ }
})();
${MARK_END}`;
}
