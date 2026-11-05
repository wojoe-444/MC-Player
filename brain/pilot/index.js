// brain/pilot: speed and judgement for the fast tiers. Three jobs (see README.md):
//   1. quick voice   a fast chat model writes a specific, state-grounded reply to chat lines no command understood, in about a second,
//                    while the Claude relay is still working. Registered as the FIRST router tier. Statements never trigger commands.
//   2. relay feed    brain/state/relay-feed.log: one line per such chat line saying what the fast tiers already did, so Claude answers
//                    only what is still owed (and watches this instead of chat.log). Plus brain/state/latency.jsonl timings.
//   3. director      idle-time choices and event notes: rules decide what is eligible, Elephant-1 picks, Claude reviews the log.
// Load order matters: put 'pilot' BEFORE 'router' in MODULES (its fallback() starts the model call in parallel with the router's own
// decision call), see README.md. Nothing here restarts, edits join.js, or touches the world except through vetted commands.
const fs = require('fs')
const path = require('path')
const { createTalker, notesReader, shouldTry, clean } = require('./talker')
const { parseModelJson } = require('../fastlane/decide')
const { createFeed } = require('./feed')
const { createLatency, summarize } = require('./latency')
const { createDirector } = require('./director')
const { createDirectives } = require('./directives')
const focusLib = require('./focus')
const { createManual } = require('./manual')
const { createCollector } = require('./collect')
const catalogLib = require('../router/catalog')
const { validate } = require('../router/slots')
const { snapshot } = require('./snapshot')
const options = require('./options')
const { appendJsonl } = require('../router')        // size-capped jsonl append that never throws

const MODE_FILE = 'pilot-mode.json'

module.exports = function register(api) {
  const hook = api.pilotOptions || {}                    // test hook: { config, fetch, env, keyFile, decisions, noWatch, setTimer }
  let cfg = { talker: {}, feed: {}, director: {}, latency: {} }
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) } } catch { /* defaults */ }
  if (hook.config) cfg = { ...cfg, ...hook.config, talker: { ...cfg.talker, ...(hook.config.talker || {}) }, director: { ...cfg.director, ...(hook.config.director || {}) }, feed: { ...cfg.feed, ...(hook.config.feed || {}) } }
  const bot = api.bot
  const owner = api.ownerName || 'OGWO'
  const mine = (u) => !owner || u === owner
  const now = () => api.now()
  const sp = (f) => api.statePath(f)

  // ---- persisted switches (chat: "pilot live", "quick voice off") ----
  let sw = { quickVoice: cfg.talker.enabled !== false, director: (api.profile && api.profile.get().director.mode) || cfg.director.mode || 'live' }
  try { const j = JSON.parse(fs.readFileSync(sp(MODE_FILE), 'utf8')); if (typeof j.quickVoice === 'boolean') sw.quickVoice = j.quickVoice; if (['off', 'shadow', 'live'].includes(j.director)) sw.director = j.director } catch { /* none saved */ }
  const saveSw = () => { try { fs.writeFileSync(sp(MODE_FILE), JSON.stringify(sw)) } catch { /* ignore */ } }

  const talker = createTalker({ config: cfg.talker, now, fetch: hook.fetch, env: hook.env, keyFile: hook.keyFile })
  const feed = createFeed({ file: sp('relay-feed.log'), now, capMs: cfg.feed.capMs || 2200, setTimer: hook.setTimer, clearTimer: hook.clearTimer })
  const lat = createLatency({ file: sp('latency.jsonl'), dir: api.dir, now, watch: !hook.noWatch })
  const readNotes = notesReader(sp('claude-notes.md'))
  const readLessons = notesReader(sp('pilot-lessons.txt'))

  // decision model for the director (Elephant-1), shared key with the router
  let decisions = hook.decisions || null
  if (!decisions && cfg.director.useElephant === true) { try { decisions = require('../router/client').createClient({ url: cfg.director.url, timeoutMs: cfg.director.timeoutMs || 3000, now, fetch: hook.fetch, env: hook.env, keyFile: hook.keyFile }) } catch { decisions = null } }

  // the director's pick among eligible options is made by the same fast chat model (Elephant-1 is off unless director.useElephant is true)
  if (!decisions) {
    decisions = {
      available: () => talker.available(),
      async decide({ state, questions }) {
        const q = questions.next, ids = Object.keys(q.criteria)
        const opts = ids.map(id => `- ${id}: ${q.criteria[id]}`)
        const user = ['STATE: ' + JSON.stringify(state).slice(0, 1500), 'QUESTION: ' + q.instructions, 'OPTIONS:', ...opts].join(String.fromCharCode(10))
        const r = await talker.raw({ messages: [{ role: 'system', content: 'You choose the next free-time activity for a Minecraft survival bot. Answer with JSON only: {"choice":"<one option id>","confidence":0.0-1.0}. Choose wait unless an option clearly fits the state.' }, { role: 'user', content: user }], maxTokens: 60, temperature: 0, timeoutMs: 3000 })
        if (!r.ok) return { ok: false, kind: r.kind }
        const obj = parseModelJson(r.content)
        const choice = obj && ids.includes(obj.choice) ? obj.choice : 'wait'
        const p = obj && typeof obj.confidence === 'number' ? obj.confidence : 0.5
        return { ok: true, data: { answers: { next: { type: 'choice', choice, confidence: p, probabilities: { [choice]: p } } } } }
      }
    }
  }

  // where the bot last died (items drop there and despawn after 5 minutes): kept across restarts, shown to the quick voice and the manual driver
  const deathFile = sp('pilot-death.json')
  let lastDeath = null
  try { lastDeath = JSON.parse(fs.readFileSync(deathFile, 'utf8')) } catch { /* no death recorded */ }
  const deathInfo = () => {
    if (!lastDeath) return null
    const mins = Math.round((now() - lastDeath.at) / 60000)
    const dim = bot.game && bot.game.dimension ? String(bot.game.dimension).replace('minecraft:', '') : null
    return { at: lastDeath.pos, dimension: lastDeath.dim, minutes_ago: mins, drops_probably_gone: mins >= 5, you_are_in_that_dimension: dim ? dim === lastDeath.dim : undefined }
  }
  const recentEvents = []
  const recentRouter = []                                  // last router decisions: what the small models did with Walter's recent lines
  const noteEvent = (s) => { recentEvents.push(s); if (recentEvents.length > 8) recentEvents.shift() }
  // priority directives from how Walter framed a request, steered through scheduler.focus (INTERFACE.md section 12); the focus id is kept to clear it early
  const focusIds = new Map()
  const directives = createDirectives({
    file: sp('pilot-directives.jsonl'), now,
    onAdd: (d) => {
      const p = focusLib.plan(d, (cmd) => { try { const v = validate(cmd, catalog(), reg()); return v.ok ? v.canonical : null } catch { return null } })
      d.task = p ? p.task : null
      let how = p ? ` -> scheduler focus on "${p.task}"${p.suppress.length ? ' (pausing ' + p.suppress.join('/') + ')' : ''}${p.then.length ? ', then ' + p.then.map(x => x.command || x.task).join(' > ') : ''}` : ' (no scheduler task matched; only free time is held)'
      try { if (p && api.scheduler && typeof api.scheduler.focus === 'function') focusIds.set(d.id, api.scheduler.focus(p.args)); else if (p) how += ' [scheduler.focus missing]' } catch (e) { how += ' [focus failed: ' + e.message + ']'; api.log('pilot', 'scheduler.focus failed: ' + e.message) }
      feed.note(`directive: focus "${d.focus}" (${d.urgency}, ${d.persist}${d.minutes ? ' ' + d.minutes + ' min' : ''}, then ${d.then}${d.avoid.length ? ', pause ' + d.avoid.join('/') : ''})${how}; Walter said: "${d.wording.slice(0, 120)}"`)
    },
    onEnd: (d, why) => { try { const id = focusIds.get(d.id); focusIds.delete(d.id); if (id != null && api.scheduler && typeof api.scheduler.clearFocus === 'function' && why !== 'expired' && why !== 'done') api.scheduler.clearFocus(id) } catch { /* optional */ } }
  })
  const snap = () => snapshot(api, { recentEvents, recentRouter, directives: directives.summary(), lastDeath: deathInfo() })
  const dir = createDirector({
    api, cfg: { ...cfg.director, mode: sw.director }, decisions, feed, now, hold: () => directives.hold(),
    snapshot: snap,
    files: { log: sp('pilot-log.jsonl'), feedback: sp('pilot-feedback.json') }
  })
  for (const o of options.builtin(cfg.director)) dir.addOption(o)
  dir.setMode(sw.director)

  // ---- chat memory for prompts: Walter's lines and the bot's own ----
  const history = []
  const botLines = []
  const remember = (who, text) => { history.push({ who, text: String(text) }); if (history.length > 14) history.shift() }
  const lastWalter = []                                   // genuine chat lines (Claude's cmd.txt lines never emit 'chat')
  const onChatEvent = (e) => {
    if (!e || !e.user || !mine(e.user)) return
    lastWalter.push({ user: e.user, text: String(e.text || ''), at: now() }); if (lastWalter.length > 6) lastWalter.shift()
    lat.lineIn(String(e.text || ''))
    dir.onChat(e.text)
    remember('OGWO', e.text)
  }
  const onMsg = (m) => {
    const g = /^<([^>]+)> (.*)$/.exec(String(m))
    if (!g || g[1] !== bot.username) return
    botLines.push(g[2]); if (botLines.length > 8) botLines.shift()
    remember('bot', g[2]); lat.botSaid()
  }
  if (api.events && api.events.on) api.events.on('chat', onChatEvent)
  bot.on('messagestr', onMsg)
  const genuine = (user, text) => !(api.events && api.events.on) || lastWalter.slice(-3).some(l => l.user === user && l.text === String(text))

  // every quick-voice outcome is kept for review (tools/pilot-review.js): Walter wants Claude to check these small models now and then
  const talkLog = sp('talker-log.jsonl')
  function logTalk(text, r) {
    appendJsonl(talkLog, { t: new Date(now()).toISOString(), text: String(text).slice(0, 200), action: r.action, reason: r.reason, reply: r.text || undefined, rejected: r.rejected, followup: r.followup, topic: r.topic, model: r.model, ms: r.ms })
  }

  // ---- the command catalog the quick voice may pick from (same builder as the router: registered commands + saved waypoints) ----
  const wpFile = path.join(api.dir || process.cwd(), 'waypoints.json')
  let wpCache = { mtime: -1, list: [] }, catSig = null, cat = null, regCache = null
  function waypoints() {
    try { const m = fs.statSync(wpFile).mtimeMs; if (m !== wpCache.mtime) { const raw = JSON.parse(fs.readFileSync(wpFile, 'utf8').replace(/^﻿/, '')); wpCache = { mtime: m, list: Object.entries(raw).map(([name, v]) => ({ name, x: v.x, y: v.y, z: v.z })) } } } catch { wpCache = { mtime: -1, list: [] } }
    const p = bot.entity && bot.entity.position
    return p ? [...wpCache.list].sort((a, b) => ((a.x - p.x) ** 2 + (a.z - p.z) ** 2) - ((b.x - p.x) ** 2 + (b.z - p.z) ** 2)) : wpCache.list
  }
  function catalog() {
    const cmds = api.commands.list(), wps = waypoints()
    const sig = cmds.map(c => c.name + ':' + (c.canonical || []).join('|') + c.risk).join(';') + '#' + wps.slice(0, catalogLib.MAX_WAYPOINTS).map(w => w.name).join(',')
    if (sig !== catSig) { cat = catalogLib.build({ commands: cmds, waypoints: wps }); catSig = sig }
    return cat
  }
  const reg = () => regCache || (regCache = { blocks: bot.registry && bot.registry.blocksArray ? bot.registry.blocksArray.map(b => b.name) : [], items: bot.registry && bot.registry.itemsArray ? bot.registry.itemsArray.map(i => i.name) : [] })

  // ---- quick voice ----
  const pending = new Map()                               // "user\0text" -> { id, promise, result }
  const keyOf = (u, t) => u + '\u0000' + String(t)
  function ask(user, text, deadlineMs, level1) {
    if (!sw.quickVoice) return Promise.resolve({ action: 'defer', reason: 'switched-off', ms: 0 })
    const st = snap()
    try { const p = dir.state().lastPick; if (p && p.pick && p.pick.id !== 'wait') st.next_free_time_pick = p.pick.id } catch { /* optional */ }
    return talker.reply({ text, state: st, notes: readNotes(), lessons: readLessons(), history: history.slice(0, -1), recentBot: botLines, level1, deadlineMs, catalog: cfg.talker.drive === false ? undefined : catalog(), reg: reg(), validate }).then(r => {
      logTalk(text, r)
      if (r.directive) { try { directives.add(r.directive, text) } catch (e) { api.log('pilot', 'directive failed: ' + e.message) } }
      return r
    })
  }

  const tierFn = async (ctx) => {
    if (ctx.shadow) return { action: 'defer', reason: 'shadow' }
    const gate = shouldTry(ctx.text, ctx.previous && ctx.previous[0], cfg.talker.drive !== false)
    if (!gate.speak) return { action: 'defer', reason: 'talker-' + gate.reason }
    const key = keyOf(ctx.user, ctx.text)
    const e = pending.get(key) || { id: null, promise: ask(ctx.user, ctx.text, ctx.timeoutMs - 150, ctx.previous && ctx.previous[0]) }
    const r = await e.promise
    e.result = r
    if (r.action === 'say') {
      lat.lane('quick')
      if (e.id != null) feed.settle(e.id, { kind: 'quick', text: r.text, owes: r.followup !== false, topic: r.topic })
      return { action: 'reply', text: r.text }
    }
    if (r.action === 'run' || r.action === 'ask') return { action: r.action, canonical: r.canonical, confidence: r.confidence }     // the router validates again and confirms anything high-risk
    return { action: 'defer', reason: 'talker-' + r.reason }
  }

  // router decisions (emitted by a one-line hook in router/index.js; absent = we only know what the tier did)
  const onRouter = (ev) => {
    if (!ev || !ev.live || !mine(ev.user)) return
    recentRouter.push(`"${String(ev.text).slice(0, 50)}" -> ${ev.action === 'run' ? 'ran ' + (ev.canonical || ev.label) : ev.action === 'ask' ? 'asked ' + (ev.shown || ev.canonical) : ev.action === 'reply' ? 'quick reply' : 'handed to Claude'}`)
    if (recentRouter.length > 8) recentRouter.shift()
    const e = pending.get(keyOf(ev.user, ev.text)); if (!e || e.id == null) return
    if (ev.action === 'run') { lat.lane('ran'); feed.settle(e.id, { kind: 'ran', text: ev.canonical || ev.label }) }
    else if (ev.action === 'ask') { lat.lane('asked'); feed.settle(e.id, { kind: 'asked', text: ev.shown || ev.canonical || ev.label }) }
    else if (ev.action === 'reply' && ev.tier === 'talker') { /* settled by the tier */ }
    else if (ev.action === 'reply') { lat.lane('quick'); feed.settle(e.id, { kind: 'quick', text: ev.reply || '', owes: true }) }
    else if (ev.action === 'defer' && ev.silent) feed.settle(e.id, { kind: 'silent' })          // the router said nothing: the chat-only Claude / driver speaks first
    else if (ev.action === 'defer') { lat.lane('ack'); feed.settle(e.id, { kind: 'ack', text: ev.ackText || 'generic acknowledgement' }) }
    pending.delete(keyOf(ev.user, ev.text))
  }
  if (api.events && api.events.on) api.events.on('router', onRouter)

  // ---- collect drops / recover your gear: deterministic sweeps (collect.js), also run by itself after a respawn ----
  const collector = createCollector({
    api, now, cfg: cfg.recover || {},
    getDeath: () => lastDeath,
    markDeath: () => { if (lastDeath) { lastDeath.handled = true; try { fs.writeFileSync(deathFile, JSON.stringify(lastDeath)) } catch { /* best effort */ } } }
  })
  const onSpawn = () => { if (process.env.AUTO_RECOVER !== '1') return; const t = setTimeout(() => { try { collector.afterRespawn() } catch (e) { api.log('pilot', 'afterRespawn failed: ' + e.message) } }, 4000); if (t.unref) t.unref() }
  bot.on('spawn', onSpawn)

  // ---- manual driver: `manual: <goal>` lets the fast model drive low-level primitives for a one-off job (manual.js) ----
  const manual = createManual({
    api, talker, now, logFile: sp('manual-log.jsonl'), cfg: { ...(cfg.manual || {}), lastDeath: deathInfo, onEnd: (goal, r, source) => { feed.note(`manual driver ended (${source}): ${r.why}${r.summary ? ' - ' + String(r.summary).slice(0, 120) : ''} after ${r.steps} steps; goal: "${String(goal).slice(0, 100)}"`) } }
  })
  const manualDeps = { catalog, validate, reg, collect: (o) => collector.sweep(o) }
  function startManual(goal, source, opts) {
    const t = manual.start(goal, manualDeps, source, opts)
    if (t) feed.note(`manual driver started (${source}): "${String(goal).slice(0, 140)}"`)
    return t
  }
  api.commands.add({
    name: 'manual-off', help: 'manual off | stop manual', risk: 'low',
    match: /^(?:(?:stop|end|exit|quit|leave|cancel) manual(?: mode)?|manual(?: mode)? (?:off|stop|done|end|over|finished)|done with manual(?: mode)?|resume (?:my )?routines)\b/,
    run(user) {
      if (!mine(user)) return
      const was = manual.end('walter')
      const stale = manual.sweepStale('manual-off')                 // always clears any leftover focus on 'manual', even when the session is gone
      if (!was && !stale) return api.say('Manual mode is not on.')
      api.say(was ? 'Manual mode off. I stay right here and my routines resume from where I am.' : 'Manual mode was not on, but I cleared a leftover manual hold, so my routines resume.')
    }
  })
  api.commands.add({
    name: 'manual-driver', help: 'manual: <goal>', risk: 'high',
    match: (u, t) => /^manual(?: mode)? \S/.test(t) || (manual.sessionActive() && /^(?:next|now|then|continue|also)\b \S/.test(t)),
    run(user, text) {
      if (!mine(user)) return
      const wasOn = manual.sessionActive()
      const goal = String(text).replace(/^\s*manual(?: mode)?\s*[:,-]?\s*/i, '').trim()
      if (!goal) return api.say('Manual mode needs a goal, e.g. "manual: dig out the three stone blocks next to the door".')
      if (!talker.hasKey()) return api.say('Manual mode needs the model key, which is missing.')
      if (!startManual(goal, 'chat')) return
      api.say((wasOn ? `Next: ${goal.slice(0, 120)}.` : `Manual mode on: ${goal.slice(0, 90)}. My routines stay paused until you say "manual off"; "stop" stops what I am doing.`).slice(0, 220))
    }
  })

  api.commands.add({
    name: 'recover-gear', help: 'recover your gear | get your stuff', risk: 'low',
    match: /\b(?:recover|retrieve|fetch|go get|get)\b.*\b(?:your|my)\b.*\b(?:gear|stuff|things|belongings|loot)\b|\b(?:recover|retrieve)\b.*\b(?:death|dropped)\b/,
    run(user) { if (mine(user)) collector.startRecover('chat') }
  })
  api.commands.add({
    name: 'collect-drops', help: 'collect drops | pick up items', risk: 'low',
    match: /\b(?:collect|pick ?up|gather|grab)\b.*\b(?:drops?|dropped|loot|items?)\b|^pick ?up (?:my |your |the )?(?:stuff|things|items|drops)\b/,
    run(user) { if (!mine(user)) return; api.say('Collecting dropped items around me.'); collector.startSweep() }
  })

  // ---- commands ----
  api.commands.add({
    name: 'pilot-mode', help: 'pilot status', risk: 'low',
    match: (u, t) => /^pilot (live|shadow|off|status)$/.test(t) || /^(?:quick voice|quickvoice) (on|off)$/.test(t),
    run(user, text, t) {
      if (!mine(user)) return
      let m = /^pilot (live|shadow|off|status)$/.exec(t)
      if (m) { if (m[1] !== 'status') { dir.setMode(m[1]); sw.director = m[1]; saveSw() } }
      else { m = /^(?:quick voice|quickvoice) (on|off)$/.exec(t); sw.quickVoice = m[1] === 'on'; saveSw() }
      const ts = talker.status(), lb = ts.latencyMs, ds = dir.state()
      api.say(`Pilot ${ds.mode}${m && m[1] !== 'status' ? ' (saved)' : ''}; quick voice ${sw.quickVoice ? 'on' : 'off'} (${String(ts.model).split('/').pop()}: ${ts.said} said, ${ts.rejected} rejected${lb ? `, median ${lb.p50} ms` : ''}); free time: ${ds.lastPick ? ds.lastPick.eligible.join(', ') || 'nothing eligible' : 'not evaluated yet'}.`.slice(0, 230))
    }
  })

  // ---- events worth telling Claude about (feed notes only; Claude decides whether to speak) ----
  const onDeath = () => {
    try { const p = bot.entity && bot.entity.position; if (p) { lastDeath = { pos: [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)], dim: bot.game && bot.game.dimension ? String(bot.game.dimension).replace('minecraft:', '') : null, at: now() }; fs.writeFileSync(deathFile, JSON.stringify(lastDeath)) } } catch { /* best effort */ }
    noteEvent('died'); feed.note(`the bot DIED${lastDeath ? ' at ' + lastDeath.pos.join(' ') + ' (' + lastDeath.dim + ')' : ''}; items drop there for 5 minutes; "manual: go get your stuff" walks there and picks them up`) }
  const onHealth = (() => { let low = false; return () => { const h = bot.health; if (h != null && h <= 6 && !low) { low = true; noteEvent('health low'); feed.note(`health is ${Math.round(h)}/20`) } else if (h != null && h >= 14) low = false } })()
  // ---- auto-repair: a job that parks for any reason except safety starts a manual session by itself (Walter, 04:30) ----
  const park = { last: new Map(), hourly: new Map(), seen: new Map(), fixed: new Map() }
  const sameReason = (a, b) => { const n = (x) => String(x || '').toLowerCase().replace(/[0-9]+/g, '#').replace(/[^a-z#]+/g, ' ').trim(); return n(a) === n(b) }
  const AUTO_SKIP_MODULE = /^(?:safety|manual|sleep|collect-drops|recover-gear)$/
  const AUTO_SKIP_REASON = /stopped by walter|user[- ]stop|walter said|safety|hostile|creeper|low health|needs? walter|walter.?s (go|ok|word)|your go|waiting for (you|walter)|until you say/i
  function onPark(ev) {
    try {
      if (!ev || sw.autoPark === false || (cfg.autoPark && cfg.autoPark.enabled === false)) return
      const mod = clean(ev.module || ev.name || '').toLowerCase(), reason = clean(ev.reason || '').slice(0, 200)
      if (!mod || AUTO_SKIP_MODULE.test(mod) || ev.safety || AUTO_SKIP_REASON.test(reason)) return
      const t = now()
      // the same module parking with the same reason within a minute of a "successful" repair means the repair did not fix it: a failure, no more resuming
      const fx = park.fixed.get(mod)
      if (fx && t - fx.at < 60000 && sameReason(fx.reason, reason)) {
        park.fixed.delete(mod); park.last.set(mod, t + ((cfg.autoPark && cfg.autoPark.cooldownAfterBlockedMs) || 30 * 60000))
        feed.note(`${mod} parked again with the same reason (${reason}) right after an auto-repair "success"; counting it as a failure, cooling down`)
        api.say(`${mod} parked again right after my fix (${clean(reason).slice(0, 80)}). I am not retrying; it needs you.`.slice(0, 220))
        return
      }
      if (t - (park.seen.get(mod) || 0) < 5000) return                       // the same park reported by the module and by the scheduler
      park.seen.set(mod, t)
      if (manual.sessionActive()) { feed.note(`${mod} parked (${reason || 'no reason'}) while manual mode was already on; not starting another`); return }
      if (t < (park.last.get(mod) || 0)) { feed.note(`${mod} parked again (${reason}); auto-repair is cooling down for it`); return }
      const hour = (park.hourly.get(mod) || []).filter(x => t - x < 3600000)
      if (hour.length >= ((cfg.autoPark && cfg.autoPark.maxPerModulePerHour) || 2)) { feed.note(`${mod} parked again (${reason}); auto-repair already tried ${hour.length}x this hour, leaving it to Walter/Claude`); return }
      hour.push(t); park.hourly.set(mod, hour)
      const goal = `${mod} parked: ${reason || 'no reason given'}; resolve it and resume ${mod}`
      startManual(goal, 'auto-park', { auto: true, onFinish: (r) => finishRepair(mod, reason, r) })
    } catch (e) { api.log('pilot', 'onPark failed: ' + e.message) }
  }
  function finishRepair(mod, reason, r) {
    const cool = (cfg.autoPark && cfg.autoPark.cooldownAfterBlockedMs) || 30 * 60000
    if (r.why === 'done' && r.resolved) {
      let resumed = false
      try { resumed = !!(api.scheduler.resumeParked && api.scheduler.resumeParked(mod)) } catch { /* optional */ }
      if (!resumed) { try { resumed = api.commands.dispatch(owner, 'resume ' + mod) === true } catch { /* optional */ } }
      park.fixed.set(mod, { at: now(), reason })
      feed.note(`auto-repair of ${mod} succeeded (${clean(r.summary).slice(0, 120)}); ${resumed ? 'resumed it' : 'could not resume it automatically, check it'}`)
      return
    }
    park.last.set(mod, now() + cool)
    feed.note(`auto-repair of ${mod} did NOT succeed (${r.why}${r.summary ? ': ' + clean(r.summary).slice(0, 120) : ''}); parked reason was: ${reason}`)
    if (r.why !== 'done') api.say(`${mod} is still parked (${clean(reason).slice(0, 80)}) and I could not fix it myself (${String(r.why).replace(/-/g, ' ')}). It needs you.`.slice(0, 220))
  }
  if (api.events && api.events.on) api.events.on('park', onPark)

  const onTask = (e) => {
    try {
      if (e && e.task && e.event === 'done') directives.taskDone(e.task.name)
      if (e && e.task && e.event === 'failed') { noteEvent(`${e.task.name} failed`); feed.note(`task failed: ${e.task.name}`) }
      else if (e && e.task && e.event === 'parked' && e.task.parkReason) { noteEvent(`${e.task.name} parked`); feed.note(`task parked: ${e.task.name} (${clean(e.task.parkReason).slice(0, 120)})`); onPark({ module: e.task.name, reason: e.task.parkReason, via: 'scheduler' }) }
    } catch { /* notes only */ }
  }
  bot.on('death', onDeath); bot.on('health', onHealth)
  if (api.events && api.events.on) api.events.on('task', onTask)

  let handle
  handle = {
    name: 'pilot',
    start() {
      lat.start(); dir.start()
      manual.sweepStale('startup'); manual.startWatch()        // sessions do not survive a restart, so a persisted manual focus is a leftover
      try {
        if (api.router && api.router.addTier) {
          const ms = (cfg.talker.timeoutMs || 2800) + 300
          api.router.addTier('talker', tierFn, { timeoutMs: ms, first: true })
        } else api.log('pilot', 'router hook missing: quick voice inactive (pilot must load after router registers its hook; see README)')
      } catch (e) { api.log('pilot', 'addTier failed: ' + e.message) }
      try { api.pilot = { addOption: dir.addOption, removeOption: dir.removeOption, director: dir, talker, feed, directives, collect: collector, autoPark: onPark, manual: { start: (goal, source = 'handoff') => startManual(goal, source), end: manual.end, abort: manual.abort, active: manual.active, sessionActive: manual.sessionActive, sessionAuto: manual.sessionAuto } } } catch { /* frozen api */ }
      api.log('pilot', `quickVoice=${sw.quickVoice} director=${dir.getMode()} model=${talker.config().model} key=${talker.hasKey() ? 'ok' : 'missing'}`)
    },
    stop() {
      if (api.events && api.events.removeListener) { api.events.removeListener('chat', onChatEvent); api.events.removeListener('router', onRouter); api.events.removeListener('park', onPark); api.events.removeListener('task', onTask) }
      bot.removeListener('messagestr', onMsg); bot.removeListener('spawn', onSpawn); collector.abort(); bot.removeListener('death', onDeath); bot.removeListener('health', onHealth)
      manual.end('shutdown'); manual.sweepStale('shutdown'); manual.stopWatch(); dir.stop(); lat.stop(); feed.stop()
    },
    status() { return { quickVoice: sw.quickVoice, talker: talker.status(), director: dir.state(), pending: pending.size, openFeed: feed.openCount() } },

    // observer: runs for every line no command understood, BEFORE the router (module order) and never takes the line.
    // It starts the fast model call at once, in parallel with the router's decision call.
    fallback(user, text) {
      try {
        if (!mine(user) || !genuine(user, text)) return false
        const gate = shouldTry(text, null)
        const id = feed.begin(user, text)
        const e = { id, promise: gate.speak && sw.quickVoice ? ask(user, text, (cfg.talker.timeoutMs || 2800) - 100, null) : Promise.resolve({ action: 'defer', reason: gate.speak ? 'switched-off' : gate.reason, ms: 0 }), result: null }
        pending.set(keyOf(user, text), e)
        if (pending.size > 20) pending.delete(pending.keys().next().value)
      } catch (err) { api.log('pilot', 'fallback error: ' + err.message) }
      return false
    },
    // for tests and the dashboard
    _director: dir, _talker: talker, _feed: feed, _latency: lat, _tier: tierFn, _pending: pending, summarize
  }
  return handle
}
module.exports.meta = require('./meta.json')
module.exports.MODE_FILE = MODE_FILE
