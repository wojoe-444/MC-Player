// brain/router: fast decision router for chat that no command, no legacy rule and no brain/chat fuzzy match understood.
// A 9B decision model (baseten/elephant-1:free on OpenRouter's Decisions API) picks ONE command from the registered list,
// or "none". Runs at the `fallback` step, after brain/chat. See README.md and brain/INTERFACE.md.
//   mode 'off'    nothing happens (the line goes to Claude exactly as before)
//   mode 'shadow' (default) the model is asked and its decision is logged; the bot does nothing with it
//   mode 'live'   confident low-risk decisions run, risky ones are confirmed with "Did you mean ...? (yes/no)", the rest
//                 go to Claude (unhandled.log + the usual ack), as does any failure or timeout
const fs = require('fs')
const path = require('path')
const catalogLib = require('./catalog')
const { buildRequest, interpret, pickKind } = require('./decide')
const acks = require('./acks')
const { createClient } = require('./client')
const { validate } = require('./slots')

const LOG_FILE = 'router-log.jsonl'
const MODE_FILE = 'router-mode.json'
const MAX_LOG_BYTES = 256 * 1024
const MODES = ['off', 'shadow', 'live']
const YES = new Set('yes y yeah yep yup ya sure ok okay correct right do it go ahead please affirmative aye yea'.split(' '))
const NO = new Set('no n nope nah nay cancel dont never mind nevermind wrong not that'.split(' '))
const CHATTER = /^(?:ok(?:ay)?|k+|lol+|lmao|haha+|hehe+|thanks?|thx|ty|nice|cool|gg|wow|good(?: job| bot| boy)?|great|yay|oops|hmm+|yes|no)\b[\s!.?]*$/i
const STOPPY = /\b(stop|stay|wait|halt|freeze|cancel|hold on|hold still|pause|never ?mind|abort)\b/i

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
const answerOf = (text) => {
  const w = String(text).toLowerCase().replace(/[^a-z\s']/g, ' ').split(/\s+/).filter(x => x && x !== 'please')
  if (!w.length || w.length > 4) return null
  if (w.every(x => YES.has(x))) return 'yes'
  if (w.every(x => NO.has(x))) return 'no'
  return null
}
const quickAck = (text) => /\?\s*$/.test(String(text || '')) || /^\s*(?:why|how|what|who|when|where|is|are|do|does|did|can|could|would|should)\b/i.test(String(text || '')) ? 'Let me think about that.' : 'Got it, one moment.'

module.exports = function register(api) {
  const { bot } = api
  const hook = api.routerOptions || {}             // test hook: { config, fetch, env, keyFile }
  let cfg = { mode: 'shadow', model: 'baseten/elephant-1:free', timeoutMs: 3000, ackAfterMs: 2500, staleMs: 10000, maxInFlight: 2, maxPerDay: 45, confirmTtlMs: 30000, thresholds: {} }
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) } } catch { /* defaults */ }
  cfg = { ...cfg, ...(hook.config || {}) }
  { const dm = String((hook.env || process.env).BOT_ROUTER_DECISION || '').toLowerCase(); if (dm === 'on') cfg.decisionModel = true; else if (dm === 'off') cfg.decisionModel = false }   // ops switch for Elephant-1 without editing config.json
  const owner = api.ownerName || null
  const mine = (user) => !owner || user === owner
  const now = () => api.now()
  const logPath = () => api.statePath(LOG_FILE)

  let mode = cfg.mode
  const envMode = String((hook.env || process.env).BOT_ROUTER_MODE || '').toLowerCase()
  try { const m = JSON.parse(fs.readFileSync(api.statePath(MODE_FILE), 'utf8')).mode; if (MODES.includes(m)) mode = m } catch { /* no saved mode */ }
  if (MODES.includes(envMode)) mode = envMode
  const setMode = (m) => { mode = m; try { fs.writeFileSync(api.statePath(MODE_FILE), JSON.stringify({ mode: m })) } catch {} }

  const client = createClient({ url: cfg.url, timeoutMs: cfg.timeoutMs, now, fetch: hook.fetch, env: hook.env, keyFile: hook.keyFile })

  // ---- what the model may choose from (rebuilt when the registered commands or the waypoint file change) ----
  const wpFile = path.join(api.dir || process.cwd(), 'waypoints.json')
  let wpCache = { mtime: -1, list: [] }
  function waypoints() {
    try {
      const m = fs.statSync(wpFile).mtimeMs
      if (m !== wpCache.mtime) { const raw = JSON.parse(fs.readFileSync(wpFile, 'utf8').replace(/^﻿/, '')); wpCache = { mtime: m, list: Object.entries(raw).map(([name, v]) => ({ name, x: v.x, y: v.y, z: v.z })) } }
    } catch { wpCache = { mtime: -1, list: [] } }
    const p = bot.entity && bot.entity.position
    return p ? [...wpCache.list].sort((a, b) => ((a.x - p.x) ** 2 + (a.z - p.z) ** 2) - ((b.x - p.x) ** 2 + (b.z - p.z) ** 2)) : wpCache.list
  }
  let catSig = null, cat = null
  function catalog() {
    const cmds = api.commands.list()
    const wps = waypoints()
    const sig = cmds.map(c => c.name + ':' + (c.canonical || []).join('|') + c.risk).join(';') + '#' + wps.slice(0, catalogLib.MAX_WAYPOINTS).map(w => w.name).join(',')
    if (sig !== catSig) { cat = catalogLib.build({ commands: cmds, waypoints: wps }); catSig = sig }
    return cat
  }

  // ---- genuine chat lines (api.events 'chat' is not emitted for Claude's cmd.txt lines) ----
  const lines = []                     // { seq, user, text, at }
  let seq = 0
  const onEvent = (e) => { if (e && e.user && mine(e.user)) { lines.push({ seq: ++seq, user: e.user, text: String(e.text || ''), at: now() }); if (lines.length > 20) lines.shift() } }
  if (api.events && api.events.on) api.events.on('chat', onEvent)
  const hasEvents = !!(api.events && api.events.on)
  const genuine = (user, text) => !hasEvents || lines.slice(-3).some(l => l.user === user && l.text === String(text))

  // ---- bookkeeping ----
  const stats = { replied: 0, seen: 0, skipped: 0, asked: 0, ran: 0, deferred: 0, confirmed: 0, dropped: 0, byAction: {}, byReason: {} }
  const recent = []
  const note = (e) => { recent.push(e); if (recent.length > 12) recent.shift() }
  const timers = new Set()
  const inflight = new Set()
  let lastCommand = null
  let pending = null                   // { user, label, canonical, shown, risk, expires }
  let dayKey = '', dayCalls = 0
  const budget = () => { const k = new Date(now()).toISOString().slice(0, 10); if (k !== dayKey) { dayKey = k; dayCalls = 0 } return !cfg.maxPerDay || dayCalls < cfg.maxPerDay }

  function eligible(user, text) {
    if (mode === 'off' || !mine(user)) return false
    const t = String(text || '').trim()
    if (t.length < 3 || t.length > 300 || t.startsWith('/') || CHATTER.test(t)) return false
    return true
  }

  function stateFor(text) {
    const s = { message: String(text).slice(0, 300) }
    try {
      const run = api.scheduler && api.scheduler.status && api.scheduler.status().running
      s.doing = run ? run.name : 'idle'
      if (bot.health != null) s.health = Math.round(bot.health)
      if (bot.food != null) s.food = Math.round(bot.food)
      if (bot.isSleeping) s.in_bed = true
      if (lastCommand) s.last_command = lastCommand
      const prev = lines.slice(0, -1).slice(-3).map(l => l.text.slice(0, 120))
      if (prev.length) s.earlier_messages = prev
    } catch { /* state is a hint only */ }
    return s
  }

  function execute(user, d, confirmed) {
    let ok = false
    try { ok = api.commands.dispatch(user, d.canonical) === true } catch (e) { api.log('router', `dispatch error for "${d.canonical}": ${e.message}`) }
    api.log('router', `${ok ? 'ran' : 'NOT handled'} "${d.canonical}" p=${d.p}${confirmed ? ' (confirmed)' : ''}`)
    if (ok) { lastCommand = d.canonical; stats.ran++ }
    return ok
  }
  function appendUnhandled(user, text) { try { fs.appendFileSync(path.join(api.dir, 'unhandled.log'), `${new Date(now()).toISOString()} ${user}: ${text}\n`) } catch {} }

  // ---- escalation tiers: Elephant-1 first, then registered tiers (e.g. the free chat-model fast lane), then Claude ----
  // addTier(name, fn, { timeoutMs }) ; fn(ctx) -> Promise<result>. See README "Escalation hook".
  const tiers = []
  const regNames = () => ({ blocks: bot.registry && bot.registry.blocksArray ? bot.registry.blocksArray.map(b => b.name) : [], items: bot.registry && bot.registry.itemsArray ? bot.registry.itemsArray.map(i => i.name) : [] })
  let regCache = null
  const reg = () => regCache || (regCache = regNames())
  const NO_ESCALATE = new Set(['stale', 'superseded'])
  const cleanReply = (t) => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\/+/, '').slice(0, 220)
  function addTier(name, fn, o = {}) {
    if (!name || typeof fn !== 'function') return false
    const i = tiers.findIndex(t => t.name === name)
    const t = { name: String(name), fn, timeoutMs: o.timeoutMs || cfg.tierTimeoutMs || 6000 }
    if (i >= 0) tiers[i] = t; else if (o.first) tiers.unshift(t); else tiers.push(t)     // o.first: brain/pilot's quick voice goes before the command-slot lane
    return true
  }
  async function runTiers(user, text, c, first, live) {
    const previous = [{ tier: 'elephant-1', action: first.action, reason: first.reason, label: first.label || null, p: first.p ?? null, directed: first.directed ?? null }]
    for (const t of tiers) {
      const ctl = new AbortController()
      let timer
      const ctx = {
        user, text, shadow: !live, state: stateFor(text), previous: previous.map(p => ({ ...p })), signal: ctl.signal, timeoutMs: t.timeoutMs,
        catalog: { options: c.options.map(o => ({ label: o.label, canonical: o.canonical, risk: o.risk, instant: o.instant, desc: o.desc })), waypoints: c.waypoints.map(w => ({ name: w.name, canonical: w.canonical })) },
        validate: (s) => validate(s, c, reg()), rawCatalog: c, reg: reg()   // rawCatalog/reg: for tiers that build their own prompts
      }
      let res
      try {
        res = await Promise.race([Promise.resolve().then(() => t.fn(ctx)), new Promise((_, rej) => { timer = setTimeout(() => { ctl.abort(); rej(new Error('timeout')) }, t.timeoutMs) })])
      } catch (e) { previous.push({ tier: t.name, action: 'defer', reason: e && e.message === 'timeout' ? 'timeout' : 'error' }); api.log('router', `tier ${t.name} failed: ${client.scrub(e && e.message)}`); continue } finally { clearTimeout(timer) }
      const a = res && res.action
      if (a === 'reply') {
        const reply = cleanReply(res.text)
        if (reply) return { action: 'reply', reason: 'tier-reply', tier: t.name, text: reply, handoff: !!res.handoff, previous }
      } else if (a === 'run' || a === 'ask') {
        const v = validate(res.canonical, c, reg())
        if (v.ok) {
          const ask = a === 'ask' || (v.risk === 'high' && !v.instant) || cfg.tierMayRun === false
          return { action: ask ? 'ask' : 'run', reason: 'tier-' + a, tier: t.name, label: v.canonical, canonical: v.canonical, shown: v.shown, risk: v.risk, p: typeof res.confidence === 'number' ? res.confidence : null, previous }
        }
        previous.push({ tier: t.name, action: 'defer', reason: 'invalid:' + v.reason })
        continue
      }
      previous.push({ tier: t.name, action: 'defer', reason: (res && res.reason) || 'defer' })
    }
    return { ...first, previous }
  }

  // Automatic acks ("Got it, one moment", kind-based replies) are only a fallback: when the pilot's quick voice tier ('talker') is loaded it
  // and the chat-only Claude do the talking, and the router stays silent about lines it hands on. cfg.acks: 'auto' | 'always' | 'never'.
  const ackSilenced = () => cfg.acks === 'never' || (cfg.acks !== 'always' && tiers.some(t => t.name === 'talker'))

  // One chat line, live or shadow. `own` = we returned true to the integrator, so the Claude hand-off (log + ack) is ours.
  async function handle(user, text, mySeq, own) {
    const live = mode === 'live'
    let acked = false
    let ackSaid = null
    const ackTimer = own ? setTimeout(() => { timers.delete(ackTimer); if (!acked && !ackSilenced()) { acked = true; ackSaid = quickAck(text); api.say(ackSaid) } }, cfg.ackAfterMs) : null
    if (ackTimer) { timers.add(ackTimer); if (ackTimer.unref) ackTimer.unref() }
    const t0 = Date.now()
    let dec = { action: 'defer', reason: 'error' }, ms = null, err = null, kind = null
    try {
      const c = catalog()
      dayCalls++
      // cfg.decisionModel === false: Elephant-1 is switched off (brain/pilot's DeepSeek tier decides everything); the line goes straight to the tiers
      const r = cfg.decisionModel === false ? { ok: false, kind: 'disabled', skip: true } : await client.decide(buildRequest({ model: cfg.model, state: stateFor(text), catalog: c }))
      ms = Date.now() - t0
      if (r.skip) dec = { action: 'defer', reason: 'none' }
      else if (r.ok) { dec = interpret(r.data, c, cfg.thresholds, { len: String(text).length }); kind = pickKind(r.data, cfg.kindMin) } else { err = r.kind + (r.status ? ' ' + r.status : '') + (r.message ? ': ' + r.message : ''); dec = { action: 'defer', reason: 'api-' + r.kind } }
    } catch (e) { err = client.scrub(e && e.message); dec = { action: 'defer', reason: 'exception' } }
    if (dec.action === 'defer' && tiers.length && !NO_ESCALATE.has(dec.reason)) {
      try { dec = await runTiers(user, text, catalog(), dec, live) } catch (e) { api.log('router', `tiers error: ${client.scrub(e && e.message)}`) }
    }
    if (ackTimer) { clearTimeout(ackTimer); timers.delete(ackTimer) }

    // the world moved on while we waited: a later "stop" must beat our answer, and an old answer is not worth running
    if (live && dec.action !== 'defer') {   // (a tier reply is also dropped when stale or superseded)
      if (now() - (lines.find(l => l.seq === mySeq) || { at: now() }).at > cfg.staleMs) dec = { ...dec, action: 'defer', reason: 'stale' }
      else if (lines.some(l => l.seq > mySeq && STOPPY.test(l.text))) dec = { ...dec, action: 'defer', reason: 'superseded' }
    }
    stats.byAction[dec.action] = (stats.byAction[dec.action] || 0) + 1
    stats.byReason[dec.reason] = (stats.byReason[dec.reason] || 0) + 1
    appendJsonl(logPath(), { t: new Date(now()).toISOString(), mode, text: String(text).slice(0, 200), action: dec.action, reason: dec.reason, label: dec.label || null, canonical: dec.canonical || null, p: dec.p ?? null, margin: dec.margin ?? null, directed: dec.directed ?? null, tier: dec.tier || null, kind: kind ? kind.kind : null, kindP: kind ? +kind.p.toFixed(2) : null, tiers: dec.previous ? dec.previous.length - 1 : 0, reply: dec.action === 'reply' ? dec.text.slice(0, 120) : undefined, ms, err })
    note({ at: now(), text: String(text).slice(0, 60), action: dec.action, reason: dec.reason, label: dec.label, canonical: dec.canonical, tier: dec.tier, kind: kind && kind.kind, p: dec.p, ms })
    let ackText = ackSaid
    if (live && !ackText && !acked && (dec.action === 'defer') && !ackSilenced()) ackText = (kind && acks.pick(kind.kind)) || quickAck(text)
    try { if (api.events && api.events.emit) api.events.emit('router', { kind: kind ? kind.kind : null, ackText, silent: live && dec.action === 'defer' && !ackText, user, text: String(text), live, action: dec.action, reason: dec.reason, label: dec.label || null, canonical: dec.canonical || null, shown: dec.shown || null, tier: dec.tier || null, reply: dec.action === 'reply' ? dec.text : null, ms }) } catch { /* observers (brain/pilot) must never break chat */ }
    if (!live) return

    if (dec.action === 'reply') { stats.replied++; acked = true; api.say(dec.text); if (dec.handoff) appendUnhandled(user, text); return }
    if (dec.action === 'run') { if (!execute(user, dec, false)) toClaude(); return }
    if (dec.action === 'ask') {
      pending = { user, label: dec.label, canonical: dec.canonical, shown: dec.shown, risk: dec.risk, p: dec.p, expires: now() + cfg.confirmTtlMs }
      stats.asked++; acked = true
      api.say(`Did you mean "${dec.shown}"? (yes/no)`.slice(0, 220))
      return
    }
    toClaude()
    function toClaude() {
      stats.deferred++
      appendUnhandled(user, text)
      if (!acked) {
        acked = true
        if (!ackText && !ackSilenced()) ackText = (kind && acks.pick(kind.kind)) || quickAck(text)   // e.g. a command that did not dispatch after all
        if (ackText) api.say(ackText)
      }
    }
  }

  // Walter flips the mode from chat; no restart. "router live" is his go for the router to act on its own.
  api.commands.add({
    name: 'router-mode', help: 'router status', risk: 'low',
    match: (u, t) => /^router (live|shadow|off|status)$/.test(t),
    run(user, text, t) {
      if (!mine(user)) return
      const m = /^router (live|shadow|off|status)$/.exec(t)[1]
      if (m !== 'status') { setMode(m); pending = null }
      const st = client.status(), lat = st.latencyMs
      api.say(`Router ${mode}${m === 'status' ? '' : ' (saved)'}; key ${st.keySource || 'MISSING'}; ${st.ok}/${st.calls} calls ok, ${stats.seen} lines seen: ran ${stats.ran}, asked ${stats.asked}, to Claude ${stats.deferred}${lat ? `; Elephant-1 median ${lat.p50} ms, p95 ${lat.p95} ms` : ''}${st.breaker ? `; paused ${st.breaker.secs}s (${st.breaker.reason})` : ''}.`.slice(0, 230))
      if (fl) {
        const f = fl.status(), fb = f.latencyMs
        api.say(`Fast lane (${String(f.model).split('/').pop()}): ${f.asked} calls, said ${f.say}, ran ${f.run}, asked ${f.ask}, passed to Claude ${f.escalate}${fb ? `; median ${fb.p50} ms, p95 ${fb.p95} ms` : ''}${f.breaker ? `; paused ${f.breaker.secs}s (${f.breaker.reason})` : ''}.`.slice(0, 230))
      }
    }
  })

  // other modules (the fast chat lane) find the hook on the shared api and add themselves from their start()
  const hookApi = { addTier, validate: (s) => validate(s, catalog(), reg()), tiers: () => tiers.map(t => t.name) }
  try { api.router = hookApi } catch { /* frozen api: no hook */ }

  // level 2: the free chat-model fast lane (brain/fastlane), when that folder exists. Its decide() never throws or dispatches.
  let fl = null
  if (cfg.fastlane !== false) {
    try {
      const { createFastlane } = require('../fastlane')
      if (typeof createFastlane === 'function') {
        fl = createFastlane({ now, log: api.log, statePath: api.statePath, validate, env: hook.env, ...(hook.fastlane || {}) })
        addTier('fastlane', async (ctx) => {
          if (ctx.shadow && !cfg.tiersInShadow) return { action: 'defer', reason: 'shadow' }
          if (!fl.wants(ctx.previous[0], ctx.text)) return { action: 'defer', reason: 'not-wanted' }
          const r = await fl.decide({ user: ctx.user, text: ctx.text, state: ctx.state, catalog: ctx.rawCatalog, reg: ctx.reg, deadlineMs: ctx.timeoutMs })
          if (r.action === 'run' || r.action === 'ask') return { action: r.action, canonical: r.canonical, confidence: r.confidence }
          if (r.action === 'say' && r.reply) return { action: 'reply', text: r.reply }       // answered here: no unhandled.log, so Claude does not answer twice
          return { action: 'defer', reason: 'fastlane-' + (r.reason || 'escalate') }
        })
      }
    } catch (e) { api.log('router', `fastlane not loaded: ${client.scrub(e && e.message)}`) }
  }

  api.commands.add({
    name: 'router-last', help: 'router last', risk: 'low',
    match: (u, t) => /^router (last|recent)$/.test(t),
    run(user) {
      if (!mine(user)) return
      const words = { run: 'ran', ask: 'asked', reply: 'replied', defer: 'to Claude' }
      const bits = recent.slice(-3).reverse().map(e => `${words[e.action] || e.action}${e.action === 'defer' ? ` (${e.kind ? e.kind + ', ' : ''}${e.reason})` : ` "${e.canonical || e.label}"${e.tier ? ' via ' + e.tier : ''}`} ${e.ms}ms: "${e.text.slice(0, 22)}"`)
      api.say((bits.length ? bits.join(' | ') : 'No lines have reached the router yet.').slice(0, 230))
    }
  })

  return {
    name: 'router',
    start() { api.log('router', `mode=${mode} model=${cfg.model} key=${client.hasKey() ? client.status().keySource : 'missing'}`) },
    stop() {
      if (api.events && api.events.removeListener) api.events.removeListener('chat', onEvent)
      for (const t of timers) clearTimeout(t)
      timers.clear(); pending = null
    },
    status() { return { mode, model: cfg.model, ...client.status(), seen: stats.seen, skipped: stats.skipped, ran: stats.ran, replied: stats.replied, tiers: tiers.map(t => t.name), fastlane: fl ? fl.status() : null, asked: stats.asked, deferred: stats.deferred, confirmed: stats.confirmed, dropped: stats.dropped, byReason: stats.byReason, pending: pending ? pending.shown : null, today: dayCalls, recent: recent.slice(-5) } },

    // Step 2: only answers to our own "Did you mean ...?" (a bare "yes" must not reach the legacy rules).
    onChat(user, text) {
      try {
        if (!pending || !mine(user)) return false
        if (pending.expires < now() || pending.user !== user) { pending = null; return false }
        const a = answerOf(text)
        const p = pending
        if (!a) { pending = null; return false }       // any other line abandons the question and is handled normally
        pending = null
        if (a === 'yes') { stats.confirmed++; if (!execute(user, p, true)) api.say('Sorry, that did not work.') } else api.say('OK, cancelled.')
        return true
      } catch (e) { api.log('router', `onChat error: ${e.message}`); return false }
    },

    // Step 5: after brain/chat. Returns true only when a model request is in flight and the hand-off to Claude is ours.
    fallback(user, text) {
      try {
        if (!eligible(user, text)) { return false }
        if (!genuine(user, text)) { stats.skipped++; return false }       // Claude's own cmd.txt lines
        stats.seen++
        const av = cfg.decisionModel === false ? { ok: true } : client.available()
        if (!av.ok || !budget() || inflight.size >= cfg.maxInFlight) { stats.skipped++; stats.byReason[av.ok ? 'busy-or-budget' : av.reason] = (stats.byReason[av.ok ? 'busy-or-budget' : av.reason] || 0) + 1; return false }
        const mySeq = lines.length ? lines[lines.length - 1].seq : 0
        const live = mode === 'live'
        const job = handle(user, text, mySeq, live).catch(e => api.log('router', `handle error: ${client.scrub(e && e.message)}`)).finally(() => inflight.delete(job))
        inflight.add(job)
        return live
      } catch (e) {
        api.log('router', `fallback error: ${client.scrub(e && e.message)}`)
        return false
      }
    },

    // for tests and bench: wait for in-flight work
    idle: () => Promise.all([...inflight]),
    _setMode: setMode, _catalog: catalog, addTier, validate: hookApi.validate
  }
}
module.exports.meta = { name: 'router', version: 1 }
module.exports.quickAck = quickAck
module.exports.appendJsonl = appendJsonl
module.exports.MODE_FILE = MODE_FILE
