// Latent Protocol Ads -- Hermes WebUI extension (installed by `npx latent-protocol init`).
//
// Loaded by the WebUI's own extension system (docs/EXTENSIONS.md) from the
// managed extension dir; no WebUI source file is edited. It talks to the
// Latent API directly -- init adds the API origin to the documented
// HERMES_WEBUI_CSP_CONNECT_EXTRA knob in the WebUI's .env.
//
// Surface: after each finished turn (the `turn:complete` lifecycle event), one
// labelled "Sponsored" line is added under the latest assistant reply. It is
// page DOM only: it never enters the transcript, so the model never sees it.
// Billing honesty: the impression is reported only after the line is in the
// DOM and the tab is visible. Only a category slug is sent -- never chat text.
//
// The placeholders below are JSON-encoded at install time. Source is ASCII
// only; glyphs are \u escapes.
(function () {
  'use strict';
  var SERVER = __SERVER__;
  var WALLET = __WALLET__;
  var DEVICE_ID = __DEVICE_ID__;
  var FREQUENCY = __FREQUENCY__;
  var EXTENSION_ID = 'latent-ads';
  var REQUEST_TIMEOUT_MS = 2000;

  if (window.__latentAdsLoaded) return;
  window.__latentAdsLoaded = true;
  if (!WALLET) return;

  var hx = window.hermesExt;
  var ext = hx && typeof hx.register === 'function' ? hx.register(EXTENSION_ID) : null;
  if (!ext || !ext.events || typeof ext.events.on !== 'function') {
    console.info('[latent-ads] extension events unavailable; not serving ads');
    return;
  }

  var CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
  var BIDI = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

  function clean(text, max) {
    var s = String(text == null ? '' : text).replace(CONTROL, ' ').replace(BIDI, '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, Math.max(0, max - 1)).replace(/\s+$/, '') + '\u2026' : s;
  }

  function isSafeUrl(url) {
    if (typeof url !== 'string' || url.indexOf('https://') !== 0) return false;
    if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(url)) return false;
    try {
      var u = new URL(url);
      return u.username === '' && u.password === '';
    } catch (_) {
      return false;
    }
  }

  function post(path, body) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS) : null;
    return fetch(SERVER + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (r) { return r.status === 200 ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (v) { if (timer) clearTimeout(timer); return v; });
  }

  function clickUrl(ad) {
    var id = ad.ad_id || ad.id;
    if (id && ad.click_token) {
      // The server credits the click, then 302s to the advertiser's stored URL.
      return SERVER + '/ad/click?ad=' + encodeURIComponent(id) +
        '&w=' + encodeURIComponent(WALLET) + '&t=' + encodeURIComponent(ad.click_token);
    }
    return isSafeUrl(ad.cta_url) ? ad.cta_url : '';
  }

  function latestAssistant() {
    var root = document.getElementById('msgInner') || document.getElementById('messages') || document;
    var rows = root.querySelectorAll('.assistant-turn, .msg-row[data-role="assistant"]');
    return rows.length ? rows[rows.length - 1] : null;
  }

  function buildFooter(ad) {
    var el = document.createElement('div');
    el.className = 'latent-ads-footer';
    el.setAttribute('data-latent-ad', String(ad.ad_id || ad.id || ''));
    el.setAttribute('role', 'note');
    el.setAttribute('aria-label', 'Sponsored');

    var label = document.createElement('span');
    label.className = 'latent-ads-label';
    label.textContent = '\ud83d\udcb0 Sponsored';
    el.appendChild(label);

    var body = document.createElement('span');
    body.className = 'latent-ads-body';
    body.textContent = clean(ad.body || ad.title, 140) || 'Sponsored';
    el.appendChild(body);

    var href = clickUrl(ad);
    if (href) {
      var a = document.createElement('a');
      a.className = 'latent-ads-cta';
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer sponsored';
      a.textContent = (clean(ad.cta_text, 24) || 'Learn more') + ' \u2192';
      el.appendChild(a);
    }

    if (typeof ad.earn_amount === 'number') {
      var earn = document.createElement('span');
      earn.className = 'latent-ads-earn';
      earn.textContent = '+$' + ad.earn_amount + ' USDC';
      el.appendChild(earn);
    }
    return el;
  }

  function reportImpression(ad) {
    var id = ad.ad_id || ad.id;
    if (!id) return;
    void post('/ad/impression', { ad_id: id, user_wallet: WALLET, token: ad.impression_token || '' });
  }

  function whenVisible(fn) {
    if (document.visibilityState !== 'hidden') return fn();
    function onVisible() {
      if (document.visibilityState === 'hidden') return;
      document.removeEventListener('visibilitychange', onVisible);
      fn();
    }
    document.addEventListener('visibilitychange', onVisible);
  }

  var turns = 0;
  var busy = false;

  ext.events.on('turn:complete', function () {
    turns += 1;
    if (busy || turns % FREQUENCY !== 0) return;
    var host = latestAssistant();
    if (!host || host.querySelector('.latent-ads-footer')) return;
    busy = true;
    post('/ad/request', {
      user_wallet: WALLET,
      agent: 'hermes-webui',
      // Category slug only -- the conversation never leaves the page.
      context: 'coding',
      surface: 'webui_footer',
      device_id: DEVICE_ID
    }).then(function (ad) {
      busy = false;
      if (!ad || !(ad.ad_id || ad.id)) return;
      var target = latestAssistant() || host;
      if (!target || target.querySelector('.latent-ads-footer')) return;
      target.appendChild(buildFooter(ad));
      whenVisible(function () {
        if (target.isConnected) reportImpression(ad);
      });
    });
  });
})();
