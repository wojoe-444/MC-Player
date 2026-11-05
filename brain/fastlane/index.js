// brain/fastlane: router escalation level 2. A second, general-purpose fast tier (OpenRouter's free chat router "openrouter/free")
// that sits behind brain/router's decision model and in front of the Claude relay. It covers what the decision model cannot:
// short free-text replies, filling the <slots> of a command (coordinates, place, block, item) and ambiguous quick asks.
// It never acts: decide() returns a decision and the router executes/asks/says/escalates. See README.md.
//
//   const { createFastlane } = require('../fastlane')
//   const fl = createFastlane({ now, env, fetch, keyFile, log, statePath, config, validate })
//   if (fl.wants(level1Decision, text)) { const r = await fl.decide({ user, text, state, catalog, reg, deadlineMs }) }
//   r = { action: 'run'|'ask'|'say'|'escalate', reason, canonical?, shown?, risk?, reply?, confidence?, ms, model, level: 2 }
const fs = require('fs')
const path = require('path')
const { createClient } = require('./client')
const { buildMessages, parseModelJson, interpret, isComplex, wantsLevel2 } = require('./decide')

const LOG_FILE = 'fastlane-log.jsonl'
const MAX_LOG_BYTES = 256 * 1024

function appendJsonl(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(obj) + '\n')
    if (fs.statSync(file).size > MAX_LOG_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n')
    }
  } catch { /* logging must never break chat */ }
}

// registry names for slots.validate (find <block>, craft <item>); cached per bot registry
const regCache = new WeakMap()
function regFrom(bot) {
  const mc = bot && bot.registry
  if (!mc) return { blocks: [], items: [] }
  let r = regCache.get(mc)
  if (!r) {
    r = { blocks: (mc.blocksArray || []).map(b => b.name), items: (mc.itemsArray || []).map(i => i.name) }
    regCache.set(mc, r)
  }
  return r
}

function createFastlane(opts = {}) {
  let cfg = { model: 'openrouter/free', url: undefined, timeoutMs: 4000, maxTokens: 200, temperature: 0, maxPerDay: 30, maxInFlight: 1, cacheMs: 120000, allowReplies: true, maxReplyChars: 140, maxTextChars: 300, slowMedianMs: 5000, thresholds: {}, extraBody: {} }
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) } } catch { /* defaults */ }
  cfg = { ...cfg, ...(opts.config || {}) }
  const now = opts.now || Date.now
  const log = opts.log || (() => {})
  const validate = opts.validate || require('../router/slots').validate
  const logPath = () => (opts.statePath ? opts.statePath(LOG_FILE) : null)
  const client = createClient({ url: cfg.url, timeoutMs: cfg.timeoutMs, slowMedianMs: cfg.slowMedianMs, now, fetch: opts.fetch, env: opts.env, keyFile: opts.keyFile })

  const stats = { asked: 0, run: 0, ask: 0, say: 0, escalate: 0, byReason: {} }
  const recent = []
  const cache = new Map()                 // key -> { at, res }
  let inflight = 0
  let dayKey = '', dayCalls = 0
  const budget = () => { const k = new Date(now()).toISOString().slice(0, 10); if (k !== dayKey) { dayKey = k; dayCalls = 0 } return !cfg.maxPerDay || dayCalls < cfg.maxPerDay }

  // sync, no network: would a call be accepted right now?
  function available() {
    const a = client.available()
    if (!a.ok) return a
    if (!budget()) return { ok: false, reason: 'budget' }
    if (inflight >= cfg.maxInFlight) return { ok: false, reason: 'busy' }
    return { ok: true }
  }

  // sync, no network: should the router try level 2 after this level-1 decision?
  function wants(level1, text) {
    const t = String(text || '').trim()
    if (t.length < 3 || t.length > cfg.maxTextChars || t.startsWith('/')) return false
    return wantsLevel2(level1, t)
  }

  function finish(text, res, t0, extra = {}) {
    const out = { ...res, level: 2, ms: Date.now() - t0, ...extra }
    stats[out.action] = (stats[out.action] || 0) + 1
    stats.byReason[out.reason] = (stats.byReason[out.reason] || 0) + 1
    recent.push({ at: now(), text: String(text).slice(0, 60), action: out.action, reason: out.reason, ms: out.ms }); if (recent.length > 12) recent.shift()
    const lp = logPath()
    if (lp) appendJsonl(lp, { t: new Date(now()).toISOString(), text: String(text).slice(0, 200), action: out.action, reason: out.reason, canonical: out.canonical || null, reply: out.reply || null, confidence: out.confidence ?? null, ms: out.ms, model: out.model || null, cached: !!out.cached, cost: out.cost ?? null, err: out.err || null })
    return out
  }

  // { user, text, state, catalog, reg?, deadlineMs? } -> decision. Never throws, never exceeds min(timeoutMs, deadlineMs) + a few ms.
  async function decide({ user, text, state, catalog, reg, deadlineMs } = {}) {
    const t0 = Date.now()
    stats.asked++
    try {
      const line = String(text == null ? '' : text).trim()
      if (line.length < 3 || line.length > cfg.maxTextChars || line.startsWith('/')) return finish(line, { action: 'escalate', reason: 'ineligible' }, t0)
      if (isComplex(line)) return finish(line, { action: 'escalate', reason: 'complex' }, t0)
      if (!catalog || !catalog.options) return finish(line, { action: 'escalate', reason: 'no-catalog' }, t0)
      const a = available()
      if (!a.ok) return finish(line, { action: 'escalate', reason: 'unavailable:' + a.reason }, t0)
      if (deadlineMs != null && deadlineMs < 800) return finish(line, { action: 'escalate', reason: 'no-time' }, t0)

      const { messages, signature } = buildMessages({ text: line, state, catalog })
      const ckey = signature + '|' + line.toLowerCase().replace(/\s+/g, ' ')
      const hit = cache.get(ckey)
      if (hit && now() - hit.at < cfg.cacheMs) return finish(line, { ...hit.res }, t0, { cached: true })

      inflight++; dayCalls++
      let r
      try {
        r = await client.chat({ model: cfg.model, messages, temperature: cfg.temperature, max_tokens: cfg.maxTokens, stream: false, ...(cfg.extraBody || {}) }, deadlineMs != null ? Math.min(cfg.timeoutMs, deadlineMs) : cfg.timeoutMs)
      } finally { inflight-- }
      if (!r.ok) return finish(line, { action: 'escalate', reason: 'api-' + r.kind }, t0, { err: client.scrub(r.message || '') || undefined, status: r.status })

      const cost = r.usage && typeof r.usage.cost === 'number' ? r.usage.cost : undefined
      const obj = parseModelJson(r.content)
      if (!obj) return finish(line, { action: 'escalate', reason: r.content && r.content.trim() ? 'unparseable' : 'empty' }, t0, { model: r.model, cost })
      const dec = interpret(obj, { catalog, reg: reg || {}, validate, text: line, cfg })
      if (dec.action === 'escalate' && dec.reason === 'model-escalate') cache.set(ckey, { at: now(), res: dec })
      else if (dec.action !== 'escalate') cache.set(ckey, { at: now(), res: dec })
      if (cache.size > 40) cache.delete(cache.keys().next().value)
      return finish(line, dec, t0, { model: r.model, cost })
    } catch (e) {
      log('fastlane', `decide error: ${client.scrub(e && e.message)}`)
      return finish(text, { action: 'escalate', reason: 'exception' }, t0, { err: client.scrub(e && e.message) })
    }
  }

  const status = () => ({ model: cfg.model, ...client.status(), asked: stats.asked, run: stats.run, ask: stats.ask, say: stats.say, escalate: stats.escalate, byReason: { ...stats.byReason }, today: dayCalls, maxPerDay: cfg.maxPerDay, recent: recent.slice(-5) })
  return { decide, wants, available, status, scrub: client.scrub, hasKey: client.hasKey, regFrom, config: () => ({ ...cfg }) }
}

// Optional brain module handle: lets 'fastlane' sit in MODULES (status on the dashboard) without doing anything else. The router
// owns the instance it calls; this one only reports. Adds no commands, listeners or timers.
function register(api) {
  const fl = createFastlane({ now: api.now, log: api.log, statePath: api.statePath, ...(api.fastlaneOptions || {}) })
  return {
    name: 'fastlane',
    start() { api.log('fastlane', `model=${fl.config().model} key=${fl.hasKey() ? fl.status().keySource : 'missing'} (called by router)`) },
    status() { return fl.status() },
    instance: fl
  }
}
module.exports = register
module.exports.createFastlane = createFastlane
module.exports.regFrom = regFrom
module.exports.meta = { name: 'fastlane', version: 1 }
