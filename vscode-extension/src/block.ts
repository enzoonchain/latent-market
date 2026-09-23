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
    var CFG = ${cfg};
    var MIN_VIEW_MS = 10000, TICK_MS = 2500;
    var cur = null, viewing = false, viewSince = 0, cumMs = 0, billed = false, tickAt = 0, viewableSent = false;
    function spinner(){
      return document.querySelector('[class*="spinnerRow_"]')
          || document.querySelector('[class*="statusRow_"]')
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
        var r = await fetch(CFG.base + '/ad?cat=' + encodeURIComponent(CFG.cat));
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
      metric(ms >= MIN_VIEW_MS ? 'view_threshold_met' : 'error_impression', { cumulative_ms: ms });
      try { fetch(CFG.base + '/impression', { method:'POST', headers:{'Content-Type':'application/json'}, keepalive: true,
        body: JSON.stringify({ adId: cur.adId, token: cur.token, displayedMs: ms, surface: 'spinner' }) }); } catch(e){}
    }
    function leave(){ if(!viewing) return; cumMs += Date.now() - viewSince; viewing = false; }
    function endCycle(){
      if(!cur) return;
      leave(); bill();
      restoreGlyph();
      cur = null; cumMs = 0; billed = false; viewableSent = false; tickAt = 0;
    }
    function paint(){
      var s = spinner(); if(!s || !cur) return;
      var label = s.querySelector('[data-latent-label]');
      if(!label){
        label = document.createElement('a'); label.setAttribute('data-latent-label','1');
        label.style.opacity='0.85'; label.style.textDecoration='none';
        label.addEventListener('click', function(){
          // Best-effort billing twin — the href navigation is the real path.
          try { fetch(CFG.base + '/click', { method:'POST', headers:{'Content-Type':'application/json'}, keepalive: true,
            body: JSON.stringify({ adId: cur ? cur.adId : '', surface: 'spinner' }) }); } catch(e){}
        });
        s.appendChild(label);
      }
      var url = isHttps(cur.url) ? clean(cur.url) : '';
      var href = isLoopback(cur.clickHref) ? clean(cur.clickHref) : '';
      label.textContent = '  ' + clean(cur.text) + (url ? '  (' + url + ')' : '') + '  \u00b7 Sponsored';
      if(href){ label.setAttribute('href', href); }
      paintIcon(s);
    }
    async function show(){
      if(cur) return;
      cur = await fetchAd();
      if(!cur) return;
      cumMs = 0; billed = false; viewableSent = false; tickAt = Date.now();
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
      } else if(cur){ endCycle(); }
    }
    setInterval(watch, 500);
    // Rotate the creative on its own cadence while the agent stays busy.
    setInterval(function(){ if(onScreen() && cur){ endCycle(); show(); } }, CFG.rotate);
    new MutationObserver(function(){ if(cur) paint(); }).observe(document.body, {childList:true,subtree:true});
  } catch(e) { /* fail open — never break the host webview */ }
})();
${MARK_END}`;
}
