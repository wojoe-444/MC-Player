// HTTP client for OpenRouter's chat completions API with the free-model router ("openrouter/free").
// Owns the API key, the hard timeout, the circuit breaker and the latency record. The key comes from OPENROUTER_API_KEY or from a
// gitignored file (brain/fastlane/openrouter.key, else the router's brain/router/openrouter.key), is held only in memory and is
// scrubbed from every string this module returns. Nothing here logs.
const fs = require('fs')
const path = require('path')

const KEY_FILES = [path.join(__dirname, 'openrouter.key'), path.join(__dirname, '..', 'router', 'openrouter.key')]

function createClient(opts = {}) {
  const now = opts.now || Date.now
  const doFetch = opts.fetch || ((...a) => fetch(...a))
  const url = opts.url || 'https://openrouter.ai/api/v1/chat/completions'
  const keyFiles = opts.keyFile ? [].concat(opts.keyFile) : KEY_FILES
  const env = opts.env || process.env
  const timeoutMs = opts.timeoutMs || 4000
  const failLimit = opts.failLimit || 3
  const failCooldownMs = opts.failCooldownMs || 60000
  const slowMedianMs = opts.slowMedianMs || 0
  const lat = []                                  // last 100 round-trip times of successful calls
  const state = { calls: 0, ok: 0, errors: {}, openUntil: 0, openReason: null, fails: 0, keySource: null, lastModel: null }
  const files = new Map()                         // path -> { mtime, value }

  function readKey() {
    const e = env.OPENROUTER_API_KEY && String(env.OPENROUTER_API_KEY).trim()
    if (e) { state.keySource = 'env'; return e }
    for (const f of keyFiles) {
      let c = files.get(f)
      try {
        const m = fs.statSync(f).mtimeMs
        if (!c || c.mtime !== m) { c = { mtime: m, value: fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/)[0].trim() || null }; files.set(f, c) }
      } catch { c = null; files.delete(f) }
      if (c && c.value) { state.keySource = 'file'; return c.value }
    }
    state.keySource = null
    return null
  }
  const scrub = (s, key) => {
    let t = String(s == null ? '' : s)
    if (key) t = t.split(key).join('[key]')
    return t.replace(/sk-or-[A-Za-z0-9_-]{8,}/g, '[key]').replace(/Bearer\s+\S+/gi, 'Bearer [key]').slice(0, 200)
  }
  const open = (ms, reason) => { state.openUntil = now() + ms; state.openReason = reason }

  function latency() {
    if (!lat.length) return null
    const s = [...lat].sort((a, b) => a - b)
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
    return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] }
  }

  // { ok:true } | { ok:false, reason }  (no network)
  function available() {
    if (!readKey()) return { ok: false, reason: 'no-key' }
    if (now() < state.openUntil) return { ok: false, reason: 'breaker:' + state.openReason }
    return { ok: true }
  }

  // body: chat completions request. ms: per-call timeout override (never above the configured one).
  // -> { ok:true, content, model, ms, usage } | { ok:false, kind, status?, message? }
  async function chat(body, ms) {
    const key = readKey()
    if (!key) return { ok: false, kind: 'no-key' }
    if (now() < state.openUntil) return { ok: false, kind: 'breaker', message: state.openReason }
    const limit = Math.max(200, Math.min(timeoutMs, ms || timeoutMs))
    state.calls++
    const t0 = Date.now()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), limit)
    const fail = (kind, extra = {}) => {
      state.errors[kind] = (state.errors[kind] || 0) + 1
      if (kind === 'auth' || kind === 'payment') open(10 * 60000, kind)
      else if (kind === 'rate') open(extra.retryMs || failCooldownMs, 'rate')
      else if (++state.fails >= failLimit) open(failCooldownMs, kind)
      return { ok: false, kind, ...extra, message: extra.message ? scrub(extra.message, key) : undefined }
    }
    try {
      let res
      try {
        res = await doFetch(url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'X-Title': 'OzoGo444 bot' }, body: JSON.stringify(body) })
      } catch (e) {
        return fail(ctl.signal.aborted ? 'timeout' : 'network', { message: e && e.message })
      }
      const text = await res.text().catch(() => '')
      if (!res.ok) {
        let msg = text; try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error)) || text } catch {}
        const st = res.status
        if (st === 401 || st === 403) return fail('auth', { status: st, message: msg })
        if (st === 402) return fail('payment', { status: st, message: msg })
        if (st === 429) {
          const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'))
          const reset = Number(res.headers && res.headers.get && res.headers.get('x-ratelimit-reset'))
          let retryMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0
          if (!retryMs && Number.isFinite(reset) && reset > now()) retryMs = Math.min(reset - now(), 3600000)
          if (!retryMs) retryMs = /per-day|daily/i.test(String(msg)) ? 3600000 : failCooldownMs
          return fail('rate', { status: st, message: msg, retryMs })
        }
        return fail(st >= 500 ? 'server' : 'http', { status: st, message: msg })
      }
      let data
      try { data = JSON.parse(text) } catch { return fail('bad-json', { status: res.status }) }
      // OpenRouter reports an upstream failure of the routed model as 200 with an `error` object
      if (data && data.error) return fail('upstream', { message: data.error.message || data.error })
      const msg = data && Array.isArray(data.choices) && data.choices[0] && data.choices[0].message
      if (!msg) return fail('bad-shape', { status: res.status })
      const content = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map(p => (p && p.text) || '').join('') : ''
      const took = Date.now() - t0
      state.ok++; state.fails = 0; lat.push(took); if (lat.length > 100) lat.shift()
      state.lastModel = typeof data.model === 'string' ? data.model.slice(0, 80) : null
      // adaptive: a free pool that is consistently slower than the budget is worse than going straight to Claude
      if (slowMedianMs && lat.length >= 8) { const l = latency(); if (l.p50 > slowMedianMs) { open(10 * 60000, 'slow'); lat.length = 0 } }
      return { ok: true, content, model: state.lastModel, ms: took, usage: data.usage || null }
    } finally { clearTimeout(timer) }
  }

  const status = () => ({ calls: state.calls, ok: state.ok, errors: { ...state.errors }, breaker: now() < state.openUntil ? { reason: state.openReason, secs: Math.round((state.openUntil - now()) / 1000) } : null, keySource: (readKey(), state.keySource), lastModel: state.lastModel, latencyMs: latency() })
  return { chat, available, status, latency, scrub, hasKey: () => !!readKey() }
}

module.exports = { createClient, KEY_FILES }
