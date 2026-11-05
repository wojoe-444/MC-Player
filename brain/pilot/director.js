// brain/pilot/director: picks what the bot does with free time. Rules decide what is ELIGIBLE (options.js, plus options other modules
// register); a small decision model (Elephant-1) picks ONE of the eligible options or "wait"; a rule-based pick is the fallback.
// Everything runs through commands Walter's rules already govern (api.commands.dispatch) or a vetted function. Modes:
//   off     nothing happens
//   shadow  decides and logs what it WOULD do (brain/state/pilot-log.jsonl); it never acts
//   live    (default, Walter wants these tested in the field) eligible `auto` options run (instant ones like wearing armor at once, free-time ones only when the bot is idle and Walter is quiet);
//           non-auto ones are only proposed in the feed
// Claude reviews the log (tools/pilot-review.js) and records verdicts; options with a bad record cool down longer.
const fs = require('fs')
const path = require('path')

const STOPPY = /\b(stop|stay|wait|halt|freeze|cancel|hold on|hold still|pause|never ?mind|abort|don'?t move)\b/i
const MAX_LOG = 256 * 1024
const WAIT = 'wait'

function appendJsonl(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(obj) + '\n')
    if (fs.statSync(file).size > MAX_LOG) { const l = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); fs.writeFileSync(file, l.slice(Math.floor(l.length / 2)).join('\n') + '\n') }
  } catch { /* logging only */ }
}

function createDirector({ api, cfg = {}, decisions = null, snapshot, feed, files, now = Date.now, rng = Math.random, hold = null } = {}) {
  const c = { tickMs: 10000, minQuietS: 45, minGapMs: 180000, maxPerHour: 6, holdMs: 10 * 60000, minP: 0.5, askEveryMs: 60000, announceGapMs: 300000, narrate: 'low', model: 'baseten/elephant-1:free', ...cfg }
  const options = new Map()
  const last = new Map()               // id -> last time chosen/run
  const shadowSeen = new Map()         // id -> last time logged as "would do" (instant options in shadow)
  const history = []                   // times of autonomous actions in the last hour
  let mode = c.mode || 'live'
  let holdUntil = 0, lastAction = -Infinity, lastAnnounce = -Infinity, lastAsk = { sig: '', at: 0, res: null }, lastPick = null, busy = false, timer = null
  let feedback = {}
  const owner = api.ownerName || 'OGWO'

  function loadFeedback() {
    try { feedback = JSON.parse(fs.readFileSync(files.feedback, 'utf8')).options || {} } catch { feedback = {} }
  }
  // Claude's verdicts: bad outweighs good -> longer cooldown (x4 at 2, x12 at 4+); never removes an option, Walter/Claude can read why in the log
  const cooldownFactor = (id) => { const f = feedback[id]; if (!f) return 1; const d = (f.bad || 0) - (f.good || 0); return d >= 4 ? 12 : d >= 2 ? 4 : 1 }

  function addOption(o) {
    if (!o || !o.id || typeof o.eligible !== 'function' || (!o.run && !o.canonical)) return false
    options.set(o.id, { weight: 1, cooldownMs: 10 * 60000, risk: 'low', auto: false, instant: false, ...o })
    return true
  }
  function removeOption(id) { return options.delete(id) }

  function schedStatus() { try { return api.scheduler.status() } catch { return null } }
  function ctxNow() {
    const snap = snapshot()
    return { api, bot: api.bot, snap, st: schedStatus(), now: now(), have: (name) => { try { return api.bot.inventory.items().filter(i => new RegExp(`(^|_)${name}($|_)`).test(i.name) || i.name === `raw_${name}`).reduce((a, i) => a + i.count, 0) } catch { return 0 } } }
  }
  function evaluate(ctx) {
    const eligible = [], skipped = {}
    for (const o of options.values()) {
      const cd = o.cooldownMs * cooldownFactor(o.id)
      const lt = last.get(o.id)
      if (lt != null && now() - lt < cd) { skipped[o.id] = 'cooldown'; continue }
      let r
      try { r = o.eligible(ctx) } catch (e) { r = 'error: ' + e.message }
      if (r === true) eligible.push(o); else skipped[o.id] = typeof r === 'string' ? r : 'not eligible'
    }
    return { eligible, skipped }
  }

  const sigOf = (el) => el.map(o => o.id).sort().join(',')
  // -> { id, p, source }
  async function choose(ctx, eligible) {
    const rule = () => {
      const pool = eligible.map(o => ({ o, w: o.weight / cooldownFactor(o.id) }))
      pool.sort((a, b) => b.w - a.w)
      return { id: pool[0].o.id, p: null, source: 'rule' }
    }
    if (!decisions || !decisions.available().ok) return rule()
    const sig = sigOf(eligible)
    if (lastAsk.sig === sig && now() - lastAsk.at < c.askEveryMs && lastAsk.res) return lastAsk.res
    const criteria = { [WAIT]: 'Nothing is worth doing right now; keep still and let Walter set the pace.' }
    for (const o of eligible) criteria[o.id] = o.desc
    const state = { ...ctx.snap, eligible_options: eligible.map(o => o.id), recent_free_time_actions: history.length }
    const r = await decisions.decide({ model: c.model, state, questions: { next: { type: 'choice', instructions: 'Which activity should the bot spend its free time on next? Prefer something useful that fits its current state (health, food, time of day, what it carries). Choose "wait" unless an option clearly fits.', criteria } } })
    let res
    if (r.ok && r.data.answers && r.data.answers.next && typeof r.data.answers.next.choice === 'string') {
      const a = r.data.answers.next
      const p = typeof a.probabilities?.[a.choice] === 'number' ? a.probabilities[a.choice] : (typeof a.confidence === 'number' ? a.confidence : 0)
      res = (a.choice === WAIT || p < c.minP || !eligible.some(o => o.id === a.choice)) ? { id: WAIT, p, source: 'elephant', raw: a.choice } : { id: a.choice, p, source: 'elephant' }
    } else res = { ...rule(), source: 'rule-fallback', err: r.kind }
    lastAsk = { sig, at: now(), res }
    return res
  }

  function log(row) { appendJsonl(files.log, { t: new Date(now()).toISOString(), mode, ...row }) }
  const actionsLastHour = () => { while (history.length && now() - history[0] > 3600000) history.shift(); return history.length }

  async function execute(o, ctx, why) {
    last.set(o.id, now())
    if (mode !== 'live') { log({ kind: 'decision', action: 'shadow', id: o.id, ...why }); return { ran: false } }
    let ok = false, note = ''
    try {
      if (o.run) { const r = await o.run(ctx); ok = r === true || !!(r && r.ok); note = (r && r.note) || '' }
      else ok = api.commands.dispatch(owner, o.canonical) === true
    } catch (e) { note = 'error: ' + e.message }
    log({ kind: 'decision', action: ok ? 'ran' : 'failed', id: o.id, note, ...why })
    if (ok && !o.instant) {
      history.push(now()); lastAction = now()
      if (feed) feed.note(`free time: started "${o.canonical || o.id}" (${why.source}${why.p != null ? ' p=' + why.p.toFixed(2) : ''})`)
      if (c.narrate !== 'off' && o.announce && o.announce.length && now() - lastAnnounce > c.announceGapMs) { lastAnnounce = now(); api.say(o.announce[Math.floor(rng() * o.announce.length)]) }
    }
    return { ran: ok }
  }

  async function tick() {
    if (busy || mode === 'off') return
    busy = true
    try {
      const ctx = ctxNow()
      if (!ctx.st) return
      if (ctx.snap.in_bed || (api.bot && api.bot.isSleeping)) return
      const { eligible, skipped } = evaluate(ctx)

      // 1. instant options (wear armor): need no model, only a calm moment (nothing running at SAFETY level)
      for (const o of eligible.filter(x => x.instant)) {
        if (ctx.st.running && ctx.st.running.priority >= 100) continue
        if (mode !== 'live') {
          if (now() - (shadowSeen.get(o.id) ?? -Infinity) > 10 * 60000) { shadowSeen.set(o.id, now()); log({ kind: 'decision', action: 'shadow', id: o.id, source: 'rule', instant: true }) }
          continue
        }
        await execute(o, ctx, { source: 'rule', instant: true })
      }

      // 2. free-time options: the bot is really idle and Walter has been quiet
      const free = eligible.filter(x => !x.instant)
      lastPick = { at: now(), eligible: free.map(o => o.id), skipped }
      if (!free.length) return
      if (ctx.st.running || (ctx.st.queue && ctx.st.queue.length)) return
      if (ctx.st.quietForS < Math.max(c.minQuietS, ctx.st.idleAfterS || 0)) return
      if (now() < holdUntil) return
      if (hold && hold()) return                      // Walter set a priority directive ("drop everything and ..."): free time waits
      if (now() - lastAction < c.minGapMs) return
      if (actionsLastHour() >= c.maxPerHour) return
      if (ctx.snap.health != null && ctx.snap.health < 12) return
      const pick = await choose(ctx, free)
      lastPick = { ...lastPick, pick }
      if (pick.id === WAIT) { if (now() - (shadowSeen.get(WAIT) ?? -Infinity) > 10 * 60000) { shadowSeen.set(WAIT, now()); log({ kind: 'decision', action: 'wait', id: WAIT, eligible: free.map(o => o.id), source: pick.source, p: pick.p, raw: pick.raw }) } return }
      const o = options.get(pick.id)
      if (!o) return
      const why = { source: pick.source, p: pick.p, eligible: free.map(x => x.id) }
      if (!o.auto) { last.set(o.id, now()); log({ kind: 'decision', action: 'proposed', id: o.id, ...why, note: 'needs Walter\'s go' }); if (feed && mode === 'live') feed.note(`free time: I would ${o.canonical || o.id}, but it needs Walter's go (not auto)`); return }
      await execute(o, ctx, why)
    } catch (e) { log({ kind: 'error', note: String(e && e.message).slice(0, 160) }) } finally { busy = false }
  }

  // outcome of what we started: attach to the log so a reviewer sees "ran X -> task done/failed"
  function onTask(e) {
    try {
      if (!e || !e.task || !last.has(e.task.name) && ![...options.values()].some(o => o.canonical && o.canonical.startsWith(e.task.name))) return
      if (now() - lastAction > 3 * 3600000) return
      if (e.event === 'done' || e.event === 'failed' || e.event === 'parked') log({ kind: 'outcome', task: e.task.name, event: e.event })
    } catch { /* logging only */ }
  }
  function onChat(text) { if (STOPPY.test(String(text || ''))) holdUntil = now() + c.holdMs }

  function start() {
    loadFeedback()
    if (api.events && api.events.on) api.events.on('task', onTask)
    timer = setInterval(() => { loadFeedback(); tick() }, c.tickMs)
    if (timer.unref) timer.unref()
  }
  function stop() { if (timer) clearInterval(timer); timer = null; if (api.events && api.events.removeListener) api.events.removeListener('task', onTask) }
  const setMode = (m) => { if (['off', 'shadow', 'live'].includes(m)) { mode = m; return true } return false }
  const state = () => ({ mode, options: [...options.values()].map(o => ({ id: o.id, auto: !!o.auto, instant: !!o.instant, risk: o.risk })), lastPick, holdS: Math.max(0, Math.round((holdUntil - now()) / 1000)), actionsLastHour: actionsLastHour() })

  return { addOption, removeOption, tick, start, stop, setMode, getMode: () => mode, onChat, state, evaluate: () => evaluate(ctxNow()), _choose: choose, _last: last }
}

module.exports = { createDirector, WAIT, STOPPY }
