// brain/mining: legit strip mining as a scheduler module (see README.md and brain/INTERFACE.md).
// "mine <ore> <amount>" starts it; nothing mines by itself. No x-ray: only blocks in plain view are ever acted on (sight.js).
const path = require('path')
const stateStore = require('./state')
const createEngine = require('./engine')
const minesLib = require('./mines')
const { parseMine, pickTier, cfg: oreCfg } = require('./ores')
const createTorches = require('../lighting/torches')
const chestsLib = require('../crafting/chests')
const baseConfig = require('./config.json')

const STATUS = /\b(mining|mine)\b.*\b(status|progress|going|far|got)\b|\b(status|progress|how far|how is|how's)\b.*\b(mining|the mine)\b|\bhow (many|much)\b.*\b(diamonds?|iron|coal|gold|redstone|lapis|copper)\b.*\b(mined|got|have you)\b/
const STOP = /^(?:(?:please|ok|okay)\s+)?(?:stop|pause|cancel|halt|quit|end|abort)\b.*\b(mining|mine|strip ?mining)\b|\b(mining|strip ?mining)\b.*\b(stop|pause|cancel|halt)\b|\b(?:no more|don'?t|do not|never mind|enough)\b.*\b(mining|strip ?mining|mine)\b/
const ROUTINE = /\bmining routine\b.*\b(on|off|enable|disable|stop|start)\b|\b(stop|start|enable|disable|turn (on|off))\b.*\bmining routine\b/
const HAUL = /\bhaul\b.*\b(mining|mine|work[ -]?site)\b|\b(empty|unload|clear)\b.*\b(work[ -]?site|mining) chest\b|\bwork[ -]?site chest\b.*\b(haul|empty|unload|clear|collect)\b/
const WOOD_YES = /\buse (the |that |my |all )?(wood|planks|sticks|logs)\b.*\bladders?\b|\bladders?\b.*\buse (the |that |my |all )?(wood|planks|sticks|logs)\b|\bladders? (are )?(ok|fine|approved)\b|\bgo ahead with (the )?ladders?\b/
const STAIRS = /\bstair(s| mine)\b.*\binstead\b|\bstairs? (mine )?(from|at) the shaft\b|\bno ladders?\b|\b(do not|don'?t) (use|spend) (the )?(wood|planks|sticks)\b/
const WOOD_ANY = /\buse (the |that |my |all )?(wood|planks|sticks|logs)\b/
const BARE_YES = /^(yes|yep|yeah|yup|ok|okay|sure|go ahead|do it|approved?)\b/
const BARE_NO = /^(no|nope|nah|stairs?|stair mine)\b/
const LEAVE = /^(?:(?:please|ok|okay)\s+)?(?:(?:come|go|get|climb) (?:back )?(?:up|out)(?: (?:the |of the )?(?:shaft|ladders?|mine))?|get out of (?:the )?(?:mine|shaft|cave)|leave (?:the )?(?:mine|shaft|cave)|exit (?:the )?(?:mine|shaft)|(?:go|come) (?:back )?(?:to )?(?:the )?surface)[.! ]*$/
const RESUME = /\b(resume|continue|keep|carry on|restart)\b.*\b(mining|strip ?mining|the mine)\b/

function register(api) {
  const { scheduler, say, PRIORITY } = api
  const log = (m) => api.log('mining', m)
  const config = { ...baseConfig }

  let book = null
  try {
    const { WaypointBook } = require('../nav/waypoints')
    let xaero = api.xaero || null
    if (!xaero) { try { xaero = require(path.join(api.dir, 'xaero')) } catch { /* no Xaero reader: local waypoints only */ } }
    book = new WaypointBook({ dir: api.dir, xaero, world: null, log, now: api.now })
  } catch (e) { log('waypoint book unavailable: ' + e.message) }
  const waypoints = api.waypoints || minesLib.create({ dir: api.dir, book, record: config.recordWaypoint !== false, log })

  const file = api.statePath('mining-state.json')
  const state = stateStore.load({ file, log })
  const save = () => stateStore.save(file, state, api.now, log)
  const dispatch = api.commands && api.commands.dispatch ? (u, t) => api.commands.dispatch(u, t) : null

  const torches = createTorches({ bot: api.bot, canSee: (b) => api.canSee(b), log, now: api.now })
  const engine = createEngine({
    bot: api.bot, say, goals: api.goals, tryGoto: (api.nav && api.nav.tryGoto) ? api.nav.tryGoto : api.tryGoto, safehand: api.safehand, stopNav: api.stopNav, canSee: api.canSee,
    config, state, save, deposit: api.depositSmeltables || null, dispatch, scheduler, owner: api.ownerName, waypoints, torches, stock: () => chestTotals(), events: api.events, now: api.now, log
  })

  const has = (s, name) => (s.running && s.running.name === name) || s.queue.some(t => t.name === name) || s.parked.some(t => t.name === name)
  // Walter's own mining job runs ahead of the excavation (one step above it, still below furnace/farm/chat); the idle routine stays at EXCAVATE
  const MANUAL = PRIORITY.EXCAVATE + 1
  function submit() {
    return scheduler.submit({
      name: 'mining', key: 'mining', priority: MANUAL, onUserStop: 'park',
      abort: (reason) => engine.abort(reason), run: (ctx) => engine.run(ctx)
    })
  }
  function go(ore, amount) {
    if (api.bot.game && String(api.bot.game.dimension).replace('minecraft:', '') !== 'overworld') return say('I only strip mine in the overworld.')
    if (has(scheduler.status(), 'mining')) scheduler.cancel('mining', 'replaced')
    state.routine.holdUntil = 0
    engine.begin(ore, amount)
    submit()
  }
  function resume() {
    const s = scheduler.status()
    if (s.running && s.running.name === 'mining') return say('I am already mining. Say "mining status" for progress.')
    if (s.queue.some(t => t.name === 'mining')) return say('Mining is queued and starts as soon as nothing more important is running.')
    state.routine.holdUntil = 0
    if (scheduler.resumeParked('mining')) return say('OK, back to mining.')
    if (state.job && !state.job.finished) { state.active = true; state.pauseReason = null; save(); submit(); return say('OK, back to mining.') }
    say('There is no mining job to resume. Say "mine diamonds 5".')
  }
  function stop() {
    const s = scheduler.status()
    if (!has(s, 'mining') && !(state.job && state.active)) return say('I am not mining.')
    scheduler.cancel('mining', 'user-stop')
    state.active = false; state.pauseReason = 'stopped by Walter.'; state.routine.holdUntil = api.now() + RC.holdAfterStopMs; save()
    say('OK, stopped mining. Say "resume mining" to carry on.')
  }

  // ---------- idle routine: mining as the fallback when nothing else is due (Walter 2026-10-26) ----------
  const RC = { ...baseConfig.routine }
  const bagCount = (name) => api.bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
  let chestBook = null
  function chestTotals() {
    try {
      chestBook = chestBook || chestsLib.create({ dir: api.dir, overlayFile: api.statePath('crafting-chests.json'), indexFile: 'chest-index.json', furnaceConfig: {}, rules: {}, now: api.now, log })
      const t = {}
      for (const e of chestBook.entries()) for (const [n, c] of Object.entries(e.items)) t[n] = (t[n] || 0) + c
      return t
    } catch (e) { log('chest totals: ' + e.message); return {} }
  }
  const stockOf = (ore, chests) => (RC.products[ore] || []).reduce((n, name) => n + bagCount(name) + (chests[name] || 0), 0)
  const bestTier = () => Math.max(-1, ...api.bot.inventory.items().map(i => pickTier(i.name)))
  // the ore Walter's stocks need most that the current pickaxes can mine -> { ore, amount, deficit } | null
  function pickOre() {
    const chests = chestTotals(), tier = bestTier()
    let best = null
    for (const [ore, want] of Object.entries(RC.wants)) {
      const def = oreCfg.ores[ore]
      if (!def || tier < def.tier) continue
      const deficit = want - stockOf(ore, chests)
      const score = deficit / want                           // Walter: routines keep the bot busy, so with every stock full it still mines what is relatively lowest
      if (!best || score > best.score) best = { ore, amount: deficit > 0 ? Math.min(def.default, deficit) : def.default, deficit, score }
    }
    return best
  }
  const overworld = () => String((api.bot.game && api.bot.game.dimension) || 'overworld').replace('minecraft:', '') === 'overworld'
  function routineDue() {
    const r = state.routine, t = api.now()
    if (!overworld() || t < r.nextAt || t < r.holdUntil || api.bot.health < RC.minHealth || (api.bot.food != null && api.bot.food < RC.minFood)) return false
    if (state.job && !state.job.finished && state.active) return false
    const tod = api.bot.time && api.bot.time.timeOfDay
    if (typeof tod === 'number' && tod >= RC.noStartFrom && tod < RC.noStartUntil) return false          // the idle routine does not start at dusk or at night; Walter's own command always does
    const pick = pickOre()
    if (!pick) return false
    if (!engine.knownMineFor(pick.ore) && !(RC.allowNewMine && !engine.protectedAt(api.bot.entity.position))) {
      if (t - r.hintedAt > RC.hintEveryMs) { r.hintedAt = t; save(); say(`When I am idle I would like to go mining for ${pick.ore}, but I do not know a mine yet. Say "mine ${pick.ore} 10" once, or set a waypoint called "mine ${pick.ore}", and I will keep using it.`.slice(0, 235)) }
      return false
    }
    return true
  }
  scheduler.routine({
    name: 'mining', priority: PRIORITY.EXCAVATE, idleOnly: true, defaultEnabled: true, intervalMs: RC.intervalMs,
    due: routineDue,
    make() {
      const pick = pickOre() || { ore: 'coal', amount: 16 }
      engine.begin(pick.ore, pick.amount)
      state.auto = true; state.announced = true; save()
      say(`Nothing else to do, so I am going mining for ${pick.amount} ${pick.ore} (${pick.deficit > 0 ? pick.deficit + ' short of my stock' : 'my stocks are full, so whatever is least stocked'}).`.slice(0, 200))
      return {
        name: 'mining', key: 'mining', onUserStop: 'park', abort: (reason) => engine.abort(reason),
        async run(ctx) {
          const res = await engine.run(ctx)
          const r = state.routine, t = api.now()
          if (res && res.status === 'park') { r.backoff = Math.min(RC.maxBackoffMs, (r.backoff || RC.backoffMs / 2) * 2); r.nextAt = t + r.backoff }
          else { r.backoff = 0; r.nextAt = t + RC.cooldownMs }
          save()
          return res
        }
      }
    }
  })

  // Walter's answer about the wood for the shaft ladders (the job parked with the question)
  function answerLadders(kind) {
    const a = (state.ladder = state.ladder || { approval: null, asking: false })
    a.approval = kind; a.asking = false; state.routine.holdUntil = 0; save()
    say(kind === 'wood' ? 'Thanks, I will use the wood for the ladders.' : 'OK, a stair mine from the bottom of the shaft instead.')
    if (state.job && !state.job.finished) resume()
  }
  const asking = () => !!(state.ladder && state.ladder.asking && api.now() - (state.ladder.askedAt || 0) < 12 * 3600000)

  const commands = [
    { name: 'leave-mine', help: 'come up | leave the mine | get out of the mine', risk: 'high', match: LEAVE,
      run() {
        scheduler.cancel('leave-mine', 'replaced')
        scheduler.submit({ name: 'leave-mine', key: 'leave-mine', priority: PRIORITY.CHAT, onUserStop: 'cancel', abort: (reason) => engine.abort(reason === 'preempted' ? 'preempted' : reason), run: (ctx) => engine.leaveOnly(ctx) })
      } },
    { name: 'mining-ladders-wood', help: 'use the wood for the ladders', risk: 'low', match: WOOD_YES, run() { answerLadders('wood') } },
    { name: 'mining-ladders-stairs', help: 'stair mine instead of ladders', risk: 'low', match: STAIRS, run() { answerLadders('stairs') } },
    { name: 'mining-haul', help: 'haul mining | empty the work-site chest', risk: 'high', match: HAUL,
      run() {
        const st = scheduler.status()
        if (has(st, 'mining')) return say('I am in the middle of a mining job; the haul happens at its end. Say "stop mining" first if you want it now.')
        if (!state.worksite) return say('There is no work-site chest to haul.')
        say('OK, hauling the work-site chest now.')
        scheduler.submit({ name: 'mining', key: 'mining', priority: MANUAL, onUserStop: 'park', abort: (reason) => engine.abort(reason), run: (ctx) => engine.haulOnly(ctx) })
      } },
    { name: 'mining-routine', help: 'mining routine on | mining routine off', risk: 'low', match: ROUTINE,
      run(user, text, t) { const off = /\b(off|disable|stop)\b/.test(t); scheduler.setEnabled('mining', !off); state.routine.holdUntil = 0; save(); say(off ? 'Mining routine off. I only mine when you ask.' : 'Mining routine on: when I am idle and my stocks are low I go mining in a mine I know.') } },
    { name: 'mining-status', help: 'mining status | how is the mining going', risk: 'low', match: STATUS, run() { say(engine.statusLine().slice(0, 235)) } },
    { name: 'mining-stop', help: 'stop mining', risk: 'low', match: STOP, run: stop },
    { name: 'mining-resume', help: 'resume mining', risk: 'high', match: RESUME, run: resume },
    {
      name: 'mine', help: 'mine <ore> <amount> | go mine for diamonds', risk: 'high',
      match: (user, t) => parseMine(t) !== null,
      run(user, text, t) {
        const p = parseMine(t || String(text).toLowerCase())
        if (!p) return
        if (p.error) return say(p.error)
        go(p.ore, p.amount)
      }
    }
  ]
  for (const c of commands) { try { api.commands.add(c) } catch (e) { log(`command ${c.name} not added: ${e.message}`) } }

  const stopped = (t) => {
    if (!t || t.key !== 'mining') return
    if (t.parkReason === 'stopped by Walter') { state.routine.holdUntil = api.now() + RC.holdAfterStopMs; save() }       // his stop also holds the idle routine
    if (state.active) { state.active = false; state.pauseReason = state.pauseReason || 'stopped by Walter.'; save() }
  }
  const subs = [['parked', stopped], ['ended', stopped]]
  if (typeof scheduler.on === 'function') for (const [ev, fn] of subs) scheduler.on(ev, fn)

  return {
    name: 'mining',
    onChat(user, text) {
      if (!asking() || (api.ownerName && user !== api.ownerName)) return false
      const t = String(text).toLowerCase().trim().replace(/[!.]+$/, '')
      if (BARE_YES.test(t) || WOOD_ANY.test(t)) { answerLadders('wood'); return true }
      if (BARE_NO.test(t)) { answerLadders('stairs'); return true }
      return false
    },
    start() {
      if (state.resumeOnStart && state.job && !state.job.finished && baseConfig.autoResumeOnStart) {
        log('Walter had a mining job running; continuing it after the restart')
        state.active = true; state.pauseReason = null; state.resumeOnStart = false; save()
        submit()
      }
    },
    stop() { if (typeof scheduler.off === 'function') for (const [ev, fn] of subs) scheduler.off(ev, fn) },
    status: () => ({ ...engine.snapshot(), routine: { enabled: scheduler.isEnabled('mining'), nextInS: Math.max(0, Math.round((state.routine.nextAt - api.now()) / 1000)), holdS: Math.max(0, Math.round((state.routine.holdUntil - api.now()) / 1000)), auto: !!state.auto, torches: torches.count() } }),
    engine, state, go, resume, stop, pickOre, routineDue, torches
  }
}
register.meta = { name: 'mining', version: 1 }

module.exports = register
module.exports.meta = register.meta
module.exports.phrases = { STATUS, STOP, RESUME, HAUL, ROUTINE, LEAVE, parseMine }
