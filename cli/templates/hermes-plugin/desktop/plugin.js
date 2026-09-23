// Latent Protocol -- Hermes Desktop plugin (installed by `npx latent init`).
// Lives beside plugin.yaml/__init__.py in the same ~/.hermes/plugins/agent-ads/
// folder -- the desktop app's SDK loader scans this location automatically
// ("one package, both SDKs"). The placeholders a few lines
// down (SERVER/WALLET/DEVICE_ID) are replaced at install time with JSON-encoded string literals by
// cli/src/surfaces/hermes.ts, never by naive interpolation.
//
// Docs: https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk
//
// Surface: one sponsored line in the status bar (right), like the Claude Code
// / Grok status line. It never touches the chat transcript. Billing honesty:
// an impression is reported once per creative, and only while the window is
// visible; rotation pauses while it is hidden.
//
// This file is loaded as native UTF-8 ESM by Electron/V8, so literal UTF-8
// glyphs are safe.
import {
  host,
  haptic,
  useValue,
  atom,
  STATUSBAR_AREAS,
  PALETTE_AREA,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect } from 'react'

var SERVER = __SERVER__
var WALLET = __WALLET__
// ~/.latent-protocol/device_id, templated in because the renderer can't read it.
var DEVICE_ID = __DEVICE_ID__

var DASHBOARD_URL = 'https://www.latentprotocol.xyz/dashboard'
var ROTATE_MS = 3 * 60 * 1000
var REQUEST_TIMEOUT_MS = 2000
var CHIP_MAX = 48

var $ad = atom(null)
var osDoor = null
var reported = {}

// Advertiser text is untrusted: drop control / bidi characters and clamp.
function clean(text, max) {
  var s = String(text == null ? '' : text)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? s.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : s
}

function isSafeUrl(url) {
  if (typeof url !== 'string' || url.indexOf('https://') !== 0) return false
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(url)) return false
  try {
    var u = new URL(url)
    return u.username === '' && u.password === ''
  } catch (_) {
    return false
  }
}

function postJson(path, body) {
  var ctrl = new AbortController()
  var timer = setTimeout(function () { ctrl.abort() }, REQUEST_TIMEOUT_MS)
  return fetch(SERVER + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal
  })
    .then(function (r) { return r.status === 200 ? r.json() : null })
    .catch(function () { return null })
    .finally(function () { clearTimeout(timer) })
}

function visible() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

function reportImpression(ad) {
  var id = ad.ad_id || ad.id
  if (!id || reported[id + ':' + ad.impression_token]) return
  reported[id + ':' + ad.impression_token] = true
  void postJson('/ad/impression', {
    ad_id: id,
    user_wallet: WALLET,
    token: ad.impression_token || ''
  })
}

function refreshAd() {
  if (!WALLET || !visible()) return Promise.resolve(null)
  return postJson('/ad/request', {
    user_wallet: WALLET,
    agent: 'hermes-desktop',
    context: 'coding',
    surface: 'statusline',
    device_id: DEVICE_ID
  }).then(function (ad) {
    // A 204 (no fill) keeps the current creative instead of blanking the bar.
    if (ad && (ad.ad_id || ad.id)) {
      $ad.set(ad)
      if (visible()) reportImpression(ad)
    }
    return ad
  })
}

function clickUrl(ad) {
  var id = ad.ad_id || ad.id
  if (id && ad.click_token) {
    // Server credits the click, then 302s to the advertiser's stored URL.
    return SERVER + '/ad/click?ad=' + encodeURIComponent(id) +
      '&w=' + encodeURIComponent(WALLET) + '&t=' + encodeURIComponent(ad.click_token)
  }
  return isSafeUrl(ad.cta_url) ? ad.cta_url : ''
}

// Only the ad server's own /uploads/ images (validated and re-rasterized
// there). Any other origin would let an advertiser see who viewed the ad.
function iconUrl(ad) {
  if (!ad || !isSafeUrl(ad.image_url)) return ''
  try {
    var u = new URL(ad.image_url)
    return u.origin === new URL(SERVER).origin && u.pathname.indexOf('/uploads/') === 0 ? u.href : ''
  } catch (_) {
    return ''
  }
}

function AdIcon(props) {
  var src = iconUrl(props.ad)
  if (!src) return null
  return jsx('img', {
    src: src,
    alt: '',
    width: props.size,
    height: props.size,
    referrerPolicy: 'no-referrer',
    className: 'shrink-0 rounded-[3px] object-contain',
    onError: function (e) { e.currentTarget.style.display = 'none' }
  })
}

function openExternal(url) {
  if (url && osDoor && osDoor.openExternal) void osDoor.openExternal(url)
}

function AdPanel() {
  var ad = useValue($ad)
  var body = ad ? clean(ad.body || ad.title, 140) : ''
  var cta = ad ? clean(ad.cta_text, 24) || 'Learn more' : ''
  var url = ad ? clickUrl(ad) : ''

  return jsxs('div', {
    className: 'flex w-60 flex-col gap-2 p-1 text-sm',
    children: [
      jsxs('div', {
        className: 'flex items-start gap-2',
        children: [
          jsx(AdIcon, { ad: ad, size: 20 }),
          jsx('div', { children: body || 'No sponsored message right now.' })
        ]
      }),
      ad
        ? jsx('div', {
            className: 'text-xs text-(--ui-text-tertiary)',
            children: 'Sponsored' +
              (typeof ad.earn_amount === 'number' ? ' · +$' + ad.earn_amount + ' USDC earned' : '')
          })
        : null,
      url
        ? jsx(Button, {
            size: 'sm',
            onClick: function () { haptic('tap'); openExternal(url) },
            children: cta + ' →'
          })
        : null,
      jsx(Button, {
        size: 'sm',
        variant: 'secondary',
        onClick: function () { haptic('tap'); openExternal(DASHBOARD_URL) },
        children: 'Balance & cash out'
      }),
      jsx('div', {
        className: 'text-xs text-(--ui-text-quaternary)',
        children: 'Wallet ' + WALLET.slice(0, 6) + '…' + WALLET.slice(-4) + ' · /ads settings in chat'
      })
    ]
  })
}

function StatusChip() {
  var ad = useValue($ad)

  useEffect(function () {
    void refreshAd()
    var id = setInterval(function () { void refreshAd() }, ROTATE_MS)
    function onVisible() { if (visible()) void refreshAd() }
    document.addEventListener('visibilitychange', onVisible)
    return function () {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  var label = ad ? clean(ad.body || ad.title, CHIP_MAX) : ''
  return jsxs(Popover, {
    children: [
      jsx(PopoverTrigger, {
        className: 'flex max-w-80 items-center gap-1 truncate px-1.5 text-[0.6875rem] text-(--ui-text-tertiary) hover:text-(--ui-text-secondary)',
        onClick: function () { haptic('tap') },
        children: label
          ? [jsx(AdIcon, { key: 'i', ad: ad, size: 12 }), jsx('span', { key: 't', className: 'truncate', children: label })]
          : 'Latent'
      }),
      jsx(PopoverContent, {
        align: 'end',
        className: 'w-64 p-3',
        children: jsx(AdPanel, {})
      })
    ]
  })
}

export default {
  id: 'agent-ads',
  name: 'Latent Protocol Ads',
  register: function (ctx) {
    osDoor = ctx.os
    // Nothing to show without a configured wallet.
    if (!WALLET) return

    ctx.register({
      id: 'sponsored-chip',
      area: STATUSBAR_AREAS.right,
      order: 140,
      render: function () { return jsx(StatusChip, {}) }
    })

    ctx.register({
      id: 'open-dashboard',
      area: PALETTE_AREA,
      data: {
        id: 'agent-ads.open-dashboard',
        label: 'Ads: Balance & Cash Out',
        keywords: ['ads', 'earnings', 'balance', 'sponsored', 'latent', 'payout'],
        run: function () {
          openExternal(DASHBOARD_URL)
          host.notify({ kind: 'info', message: 'Opened the Latent dashboard.' })
        }
      }
    })
  }
}
