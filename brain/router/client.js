// HTTP client for OpenRouter's Decisions API (POST /api/alpha/decisions). Owns the API key, the timeout and a circuit breaker.
// The key is read from OPENROUTER_API_KEY or from a gitignored file next to this module, held only in memory, and scrubbed
// from every error string this module returns. Nothing here logs.
const fs = require('fs')
const path = require('path')

const KEY_FILE = path.join(__dirname, 'openrouter.key')

function createClient(opts = {}) {
  const now = opts.now || Date.now
  const doFetch = opts.fetch || ((...a) => fetch(...a))
  const url = opts.url || 'https://openrouter.ai/api/alpha/decisions'
  const keyFile = opts.keyFile || KEY_FILE
  const env = opts.env || process.env
  const timeoutMs = opts.timeoutMs || 3000
  const failLimit = opts.failLimit || 3          // consecutive failures before the breaker opens
  const failCooldownMs = opts.failCooldownMs || 60000
  const lat = []                                  // last 200 round-trip times of successful calls
  const state = { calls: 0, ok: 0, errors: {}, openUntil: 0, openReason: null, fails: 0, keySource: null }
  let fileKey = { mtime: -1, value: null }

  function readKey() {
    const e = env.OPENROUTER_API_KEY && String(env.OPENROUTER_API_KEY).trim()
    if (e) { state.keySource = 'env'; return e }
    try {
      const m = fs.statSync(keyFile).mtimeMs
      if (m !== fileKey.mtime) fileKey = { mtime: m, value: fs.readFileSync(keyFile, 'utf8').replace(/^﻿/, '').split(/\r?\n/)[0].trim() || null }
    } catch { fileKey = { mtime: -1, value: null } }
    state.keySource = fileKey.value ? 'file' : null
    return fileKey.value
  }
  const scrub = (s, key) => {
    let t = String(s == null ? '' : s)
    if (key) t = t.split(key).join('[key]')
    return t.replace(/sk-or-[A-Za-z0-9_-]{8,}/g, '[key]').replace(/Bearer\s+\S+/gi, 'Bearer [key]').slice(0, 200)
  }
  const open = (ms, reason) => { state.openUntil = now() + ms; state.openReason = reason }

  // { ok:true } | { ok:false, reason }  (no network)
  function available() {
    if (!readKey()) return { ok: false, reason: 'no-key' }
    if (now() < state.openUntil) return { ok: false, reason: 'breaker:' + state.openReason }
    return { ok: true }
  }

  // -> { ok:true, data, ms } | { ok:false, kind, status?, message? }
  async function decide(body) {
    const key = readKey()
    if (!key) return { ok: false, kind: 'no-key' }
    if (now() < state.openUntil) return { ok: false, kind: 'breaker', message: state.openReason }
    state.calls++
    const t0 = Date.now()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
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
      if (!data || typeof data !== 'object' || !data.answers) return fail('bad-shape', { status: res.status })
      const ms = Date.now() - t0
      state.ok++; state.fails = 0; lat.push(ms); if (lat.length > 200) lat.shift()
      return { ok: true, data, ms }
    } finally { clearTimeout(timer) }
  }

  function latency() {
    if (!lat.length) return null
    const s = [...lat].sort((a, b) => a - b)
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
    return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] }
  }
  const status = () => ({ calls: state.calls, ok: state.ok, errors: { ...state.errors }, breaker: now() < state.openUntil ? { reason: state.openReason, secs: Math.round((state.openUntil - now()) / 1000) } : null, keySource: (readKey(), state.keySource), latencyMs: latency() })
  return { decide, available, status, latency, scrub, hasKey: () => !!readKey() }
}

module.exports = { createClient, KEY_FILE }
