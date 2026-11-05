// brain/nav: navigation module (see README.md and brain/INTERFACE.md).
//   doors / gates / trapdoors, ladders, hazards, stuck recovery, named + Xaero waypoints, long routes over the Xaero map, the Nether.
const fs = require('fs')
const path = require('path')
const { Navigator } = require('./navigator')
const { WaypointBook, dimOf, convert, DIM_LABEL, hdist } = require('./waypoints')
const route = require('./route')
const makeNether = require('./nether-trip')
const { compass } = require('./blocks')

const DEFAULTS = {
  xaeroWorld: null,          // null = newest Xaero world that has both waypoints and a map
  maxFall: 3,                // blocks; 3 is the most that does no fall damage (also applied to water landings)
  directMax: 130,            // closer than this: plain pathfinder goto; further: leg-by-leg route
  legLen: 72,
  quietGoals: true,          // keep join.js from saying "Here." after every internal leg (see README)
  silenceHere: true,         // and from saying it for goals nobody asked about (routines, goals queued behind them); nav announces arrivals itself
  arriveTolerance: 12,       // a trip counts as arrived only within this many blocks (horizontal) of the last target
  longTripBlocks: 400,       // trips longer than this are 'high' risk commands (the chat module confirms fuzzy matches)
  netherShortcutMin: 900,
  escalate: true,            // a go-to that the normal planner cannot solve digs / bridges / pillars its way there (brain/nav/reach.js) and puts back what it broke
  reach: {}                  // overrides for reach.js DEFAULTS (maxMs, maxStall, baseCenter, baseRadius, ...)
}

function loadJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch { return fallback } }

function register(api) {
  const bot = api.bot
  const cfg = { ...DEFAULTS, ...loadJson(path.join(__dirname, 'config.json'), {}), ...(api.navConfig || {}) }
  const log = (m) => { try { api.log('nav', m) } catch { /* ignore */ } }
  let xaero = api.xaero || null          // tests inject a fake; normally Walter's reader next to join.js
  if (!xaero) { try { xaero = require(path.join(api.dir || path.resolve(__dirname, '..', '..'), 'xaero')) } catch (e) { log('xaero.js unavailable: ' + e.message) } }
  const book = new WaypointBook({ dir: api.dir, xaero, world: cfg.xaeroWorld, log, now: api.now })
  const stateFile = api.statePath('nav-state.json')
  const saved = loadJson(stateFile, {})
  const persist = (patch) => {
    try { const cur = loadJson(stateFile, {}); fs.writeFileSync(stateFile + '.tmp', JSON.stringify({ ...cur, ...patch })); fs.renameSync(stateFile + '.tmp', stateFile) } catch (e) { log('state write failed: ' + e.message) }
  }
  const nav = new Navigator({ bot, goals: api.goals, safehand: api.safehand, say: api.say, log, persist, saved,
    los: api.canSee ? { canSee: (b) => api.canSee(b), ensure: (o) => (api.ensureLineOfSight ? api.ensureLineOfSight({ ctx: null, ...o }) : Promise.resolve(true)) } : null,
    config: { maxFall: cfg.maxFall, quietGoals: cfg.quietGoals, silenceHere: cfg.silenceHere, escalate: cfg.escalate, reach: cfg.reach } })

  const nether = makeNether({ api, nav, book, cfg, log })

  // ---------- xaero map (overworld only: the other layers are caves/roofs) ----------
  let map = null, mapWorld = null
  function getMap() {
    if (!xaero) return null
    const w = book.xaeroWorld()
    if (!w) return null
    if (!map || mapWorld !== w) { try { map = xaero.openMap(w, 0); mapWorld = w } catch (e) { log('xaero map: ' + e.message); map = null } }
    return map
  }

  // ---------- trips ----------
  let trip = null                     // { label, target, steps, idx, startedAt }
  let lastTrip = null
  const here = () => bot.entity.position

  async function walkStep(ctx, step, label) {
    const isAborted = () => !!(ctx && ctx.aborted)
    const p = here()
    const dist = hdist(p, step.to)
    if (dist > cfg.directMax) {
      const r = await route.travel({ nav, bot, goals: api.goals, map: step.dim === 0 && dimOf(bot) === 0 ? getMap() : null, log, isAborted },
        step.to, { legLen: cfg.legLen })
      if (!r.ok) log(`long route to ${label} ended (${r.err}); going on by escalating go-to`)
    }
    const t = step.to
    const hasY = typeof t.y === 'number'
    let r = await nav.goto(hasY ? new api.goals.GoalNear(t.x, t.y, t.z, 2) : new api.goals.GoalNearXZ(t.x, t.z, 3), { label, ms: 60000, isAborted })
    if (!r.ok && hasY && r.err === 'no path') r = await nav.goto(new api.goals.GoalNearXZ(t.x, t.z, 3), { label, ms: 60000, isAborted })
    return r
  }

  async function portalStep(ctx, step) {
    const wantDim = step.to
    if (typeof api.usePortal === 'function' || (api.jobs && api.jobs.usePortal)) {
      await (api.usePortal || api.jobs.usePortal)(wantDim)
      return { ok: (DIM_LABEL[dimOf(bot)] === (wantDim === 'the_nether' ? 'nether' : 'overworld')) }
    }
    return { ok: false, handoff: true }       // the driver's portal command runs as its own task; the trip continues after the switch
  }

  async function runTrip(ctx, t) {
    for (; t.idx < t.steps.length; t.idx++) {
      if (ctx && ctx.aborted) return { ok: false, err: 'aborted' }
      const step = t.steps[t.idx]
      if (step.type === 'walk') {
        if (step.dim !== dimOf(bot)) return { ok: false, err: `expected to be in the ${DIM_LABEL[step.dim]}` }
        const label = t.idx === t.steps.length - 1 ? t.label : step.label
        // Nether legs follow the logged safe network only (nether-trip.js); everything else uses the pathfinder / route legs
        const r = step.dim === -1 ? await nether.walkTo(ctx, step.to, label, t) : await walkStep(ctx, step, label)
        if (!r.ok) return r
      } else {
        const r = await portalStep(ctx, step)
        if (r.handoff) {
          t.idx++
          trip = t
          const cmd = step.to === 'the_nether' ? 'go to the nether' : 'leave the nether'
          watchForSwitch(step.toDim)
          log(`handing over to the portal command: ${cmd}`)
          setImmediate(() => api.commands.dispatch(api.ownerName, cmd))
          return { ok: true, handoff: true }
        }
        if (!r.ok) return { ok: false, err: 'the portal did not take me through' }
      }
    }
    return { ok: true }
  }

  // After handing over to the portal job, continue the trip once the dimension has changed (or give up after 3 minutes).
  // Counted in physics ticks, so nothing needs a timer and stop() only has to drop the listener.
  function watchForSwitch(wantDim) {
    let ticks = 0, settled = -1
    unwatch()
    const onTick = () => {
      ticks++
      if (settled < 0 && dimOf(bot) === wantDim && bot.entity && bot.entity.onGround) settled = ticks
      if (settled >= 0 && ticks - settled >= 60) { unwatch(); if (trip) submitTrip(trip) }       // 3 s for the chunks to arrive
      else if (ticks > 3600) { unwatch(); trip = null; log('portal hand-over timed out') }
    }
    watching = onTick
    bot.on('physicsTick', onTick)
  }
  let watching = null
  function unwatch() { if (watching) { bot.removeListener('physicsTick', watching); watching = null } }

  function submitTrip(t) {
    trip = t
    return api.scheduler.submit({
      name: 'nav', key: 'nav', replace: true, priority: api.PRIORITY.CHAT, onUserStop: 'cancel', state: {},
      abort: () => nav.stop('aborted'),
      async run(ctx) {
        ctx.progress(t.label)
        await api.safehand.ensureSafeForMove().catch(() => {})
        const r = await runTrip(ctx, t)
        if (r.handoff) return { status: 'done' }
        const secs = Math.round((api.now() - t.startedAt) / 1000)
        trip = null
        lastTrip = { label: t.label, ok: r.ok, err: r.err || null, secs }
        if (ctx.aborted) return { status: 'done' }
        if (r.asked) return { status: 'done' }              // the Nether question has been put to Walter; nothing more to say
        // "Arrived" only when the bot is really there (live bug: it said so 77 blocks from the waypoint)
        const last = t.steps[t.steps.length - 1]
        const away = r.ok && last && last.type === 'walk' && last.dim === dimOf(bot) && last.to ? Math.round(hdist(here(), last.to)) : 0
        if (r.ok && away > cfg.arriveTolerance) {
          log(`trip to ${t.label} reported done but the bot is ${away} blocks away`)
        } else if (r.ok) {
          const left = await nav.tidy({ isAborted: () => ctx.aborted }).catch(() => 0)
          api.say(`Arrived at ${t.label}.${left ? ` (${left} door left open behind me.)` : ''}`)
        } else log(`trip to ${t.label} ended: ${r.err}`)               // Walter: no "I can't get there" in chat; nav.goto already escalated as far as it can
        return { status: 'done' }
      }
    })
  }

  // ---------- waypoint commands ----------
  const NOT_PLACES = /^(?:the )?(?:nether|overworld|end|bed|me|you|here|there|sleep)$/
  const dist2 = (w) => Math.round(hdist(here(), w))
  const targetOf = (w) => ({ x: w.x, y: typeof w.y === 'number' ? w.y : null, z: w.z, dim: w.dim })

  function plan(w) {
    const from = { x: here().x, z: here().z, dim: dimOf(bot) }
    const to = { x: w.x, y: typeof w.y === 'number' ? w.y : undefined, z: w.z, dim: w.dim }
    return route.planTravel({ from, to, portals: book.portalPairs(), shortcutMin: cfg.netherShortcutMin })
  }

  function resolve(query) {
    const dim = dimOf(bot)
    let r = book.find(query, { dim, from: here() })
    if (!r.match) r = book.find(query, { dim, from: here(), anyDim: true })
    return r
  }

  function goToWaypoint(user, query) {
    const r = resolve(query)
    if (!r.match || r.score < 0.7) return false
    if (r.ambiguous && !r.sameBase) {
      const names = r.candidates.slice(0, 4).map(w => w.name).join(', ')
      api.say(`Which one: ${names}?`.slice(0, 225))
      return true
    }
    const w = r.match
    const p = plan(w)
    if (!p.steps.length) { api.say(`I don't know a way to ${w.name}${p.err ? ` (${p.err})` : ''}.`.slice(0, 200)); return true }
    const d = dist2(w)
    const note = r.ambiguous ? ` (nearest of ${r.candidates.length})` : ''
    const way = p.kind === 'nether-shortcut' ? ', through the Nether' : p.kind === 'to-nether' ? ', via a portal' : p.kind === 'to-overworld' ? ', via a portal' : ''
    const t = { label: w.name, target: targetOf(w), steps: p.steps.map(s => ({ ...s })), idx: 0, startedAt: api.now() }
    if (!nether.preflight(t.steps, w.name, t)) return true            // no logged Nether route: asked Walter, not walking
    if (d > 40 || way || r.ambiguous) api.say(`Going to ${w.name}${note}, ${d} blocks${way}.`.slice(0, 225))
    submitTrip(t)
    return true
  }

  const GOTO = /^(?:(?:go|walk|run|head|travel|navigate|move|get)\s*(?:over\s*)?(?:to|towards?|into|at)|take me to|bring me to|come to)\s+(.+?)\s*$/
  const farGoto = (user, t) => {
    const m = GOTO.exec(t); if (!m) return false
    const q = m[1].replace(/^(?:the|my)\s+/, '')
    if (NOT_PLACES.test(q) || /^-?\d/.test(q) || /\b(me|you|bed|sleep)\b/.test(q)) return false
    const r = resolve(q); if (!r.match || r.score < 0.7) return false
    return hdist(here(), r.match) > cfg.longTripBlocks || r.match.dim !== dimOf(bot)
  }
  const nearGoto = (user, t) => { const m = GOTO.exec(t); if (!m) return false; const q = m[1].replace(/^(?:the|my)\s+/, ''); if (NOT_PLACES.test(q) || /^-?\d/.test(q) || /\b(me|you|bed|sleep)\b/.test(q)) return false; const r = resolve(q); return !!(r.match && r.score >= 0.7) && !farGoto(user, t) }
  const queryOf = (t) => GOTO.exec(t)[1].replace(/^(?:the|my)\s+/, '')

  api.commands.add({ name: 'nav-goto', help: 'go to <waypoint>', risk: 'low', match: nearGoto, run(user, text, t) { goToWaypoint(user, queryOf(t)) } })
  api.commands.add({ name: 'nav-travel', help: 'travel to <far waypoint>', risk: 'high', match: farGoto, run(user, text, t) { goToWaypoint(user, queryOf(t)) } })

  const WHERE = /^(?:where(?:'s| is| are)|how far (?:is|are|away is)|what(?:'s| is) the distance to|distance to)\s+(?:the |my )?(.+?)\s*\??$/
  api.commands.add({
    name: 'nav-where', help: 'where is <waypoint> | how far is <waypoint>', risk: 'low',
    match(user, t) {
      const m = WHERE.exec(t); if (!m) return false
      const r = resolve(m[1]); return !!(r.match && (r.exact || r.score >= 0.9))
    },
    run(user, text, t) {
      const r = resolve(WHERE.exec(t)[1]); const w = r.match
      const dx = w.x - here().x, dz = w.z - here().z
      const other = w.dim !== dimOf(bot) ? ` in the ${DIM_LABEL[w.dim]}` : ''
      const y = typeof w.y === 'number' ? `, ${w.y}` : ''
      api.say(`${w.name}${r.ambiguous ? ` (nearest of ${r.candidates.length})` : ''}: ${Math.round(hdist(here(), w))} blocks ${compass(dx, dz)}${other} (${w.x}${y}, ${w.z}).`.slice(0, 225))
    }
  })

  api.commands.add({
    name: 'nav-near', help: 'nearest waypoints', risk: 'low',
    match: /\b(nearest|closest|nearby|near me)\b.*\b(waypoints?|places|locations)\b|\b(waypoints?|places|locations)\b.*\b(near me|nearby|close by|around here)\b|\bwhat.?s (near|nearby)\b/,
    run() {
      const list = book.near(here(), dimOf(bot), 4)
      api.say(list.length ? 'Nearest: ' + list.map(w => `${w.name} ${w.dist}`).join('; ') : 'No waypoints known in this dimension.')
    }
  })
  api.commands.add({
    name: 'nav-sources', help: 'how many waypoints do you know', risk: 'low',
    match: /\bhow many (waypoints|places)\b|\b(all|xaero|minimap) waypoints\b/,
    run() { book.load(true); const s = book.sources; api.say(`I know ${book.all().length} waypoints: ${s.local} saved here, ${s.xaero} from Xaero${s.xaeroWorld ? ` (${s.xaeroWorld})` : ''}. Ask "go to <name>".`.slice(0, 225)) }
  })
  api.commands.add({
    name: 'nav-status', help: 'nav status', risk: 'low', match: /^(?:nav|navigation) status\b|\bhow is (?:the )?navigation\b/,
    run() {
      const s = nav.status()
      api.say(`Nav: ${s.goto ? 'heading to ' + s.goto.label : 'idle'}; doors opened ${s.doors.opened}, closed ${s.doors.closed}, stuck episodes ${s.stuck.episodes}, hazard escapes ${s.hazards.escapes}${s.doors.open.length ? `, ${s.doors.open.length} left open` : ''}.`.slice(0, 225))
    }
  })
  api.commands.add({
    name: 'nav-tidy', help: 'close the doors', risk: 'low', match: /\b(close|shut)\b.*\bdoors?\b.*\b(behind|left open|you opened)\b|^(close|shut) (the )?(doors?|gates?)$/,
    run() {
      api.scheduler.submit({ name: 'nav-tidy', priority: api.PRIORITY.CHAT, onUserStop: 'cancel', abort: () => nav.stop('aborted'), async run(ctx) {
        const left = await nav.tidy({ isAborted: () => ctx.aborted })
        api.say(left ? `${left} door(s) still open.` : 'No doors left open.')
      } })
    }
  })

  // INTERFACE.md section 9: replaces the built-in scheduled navigation, i.e. what join.js navigate() calls for "come", "follow me",
  // "go to x y z". Same contract: a CHAT-priority task with key 'nav' that replaces an earlier one, stops pathing when aborted and
  // sets the same goal again when resumed.
  // Arrival rules (live bug: "go to x z" waiting behind routines still printed "Here."):
  //   - "Here." is said only after the bot's real position satisfies the goal, never because some goal_reached event fired
  //   - a go-to that has to wait behind another task says so ("Waiting for furnace to finish...") and says "On my way." when it starts
  //   - a go-to that ends short of the goal says how far short
  const distTo = (g) => { const p = bot.entity.position; return typeof g.x === 'number' && typeof g.z === 'number' ? Math.round(Math.hypot(g.x + 0.5 - p.x, g.z + 0.5 - p.z)) : null }
  function reallyThere(g) {
    if (!g || typeof g.isEnd !== 'function') return true
    const p = bot.entity.position.floored()
    try { return !!(g.isEnd(p) || g.isEnd(p.offset(0, 1, 0)) || g.isEnd(p.offset(0, -1, 0))) } catch { return true }
  }
  function navigate(goal, label, dynamic = false) {
    const state = { goal, label, dynamic, queued: false }
    const task = api.scheduler.submit({
      name: 'nav', key: 'nav', replace: true, priority: api.PRIORITY.CHAT, onUserStop: 'cancel', state,
      abort: () => nav.stop('aborted'),
      async run(ctx) {
        const { goal: g, label: l, dynamic: dyn } = ctx.state
        if (ctx.state.queued && !ctx.resumed) { ctx.state.queued = false; if (!dyn) api.say('On my way.') }
        const r = await nav.goto(g, { label: l || 'there', dynamic: !!dyn, ms: dyn ? 6 * 3600 * 1000 : 120000, isAborted: () => ctx.aborted })
        if (ctx.aborted || r.err === 'aborted' || r.err === 'replaced' || r.err === 'goal changed') return
        if (!r.ok) return log(`go-to ${l || 'there'} ended: ${r.err}`)       // no chat about failing paths: nav.goto has already dug / bridged / pillared as far as it could
        if (dyn) return
        if (reallyThere(g)) return api.say('Here.')
        log(`go-to ${l || 'there'} stopped ${distTo(g)} blocks short`)
      }
    })
    const run = api.scheduler.running
    // The scheduler queues a new walk behind a running static one (orders run back to back) and behind any higher-priority task: say so.
    if (task && task.status !== 'running' && !dynamic) {
      state.queued = true
      const behindWalk = run && run.name === 'nav'
      api.say((behindWalk ? `Queued: heading to ${label || 'there'} after the walk I'm on.` : `Waiting for ${run ? run.name : 'another task'} to finish, then heading to ${label || 'there'}.`).slice(0, 200))
    }
    return task
  }

  nether.addCommands((t) => { t.exploreOk = true; submitTrip(t) })

  const handle = {
    name: 'nav',
    provides: ['nav'], navigate,
    start() { nav.attach(); nether.start() },
    stop() { unwatch(); try { nether.stop() } catch { /* ignore */ } try { nav.detach() } catch { /* ignore */ } },
    status() { return { ...nav.status(), waypoints: { total: book.all().length, ...book.sources }, nether: nether.status(), trip: trip ? { label: trip.label, step: trip.idx, of: trip.steps.length } : null, lastTrip } },
    // for other modules (api.nav is set below): same result shape as join.js tryGoto()
    nav, book, nether, reach: nav.reach,
    rebuildPending: (o) => nav.reach.rebuildPending(o),
    goto: (goal, o) => nav.goto(goal, o),
    approachBlock: (pos, o) => nav.approachBlock(pos, o),
    gotoNear: (o) => nav.gotoNear(o),
    tryGoto: (goal, label, ms) => nav.goto(goal, { label, ms }),
    getMap, plan,
    goToWaypoint: (query) => goToWaypoint(api.ownerName, query)
  }
  api.nav = handle
  return handle
}
register.meta = { name: 'nav', version: 1 }

module.exports = register
module.exports.meta = register.meta
module.exports.Navigator = Navigator
module.exports.WaypointBook = WaypointBook
module.exports.route = route
module.exports.convert = convert
