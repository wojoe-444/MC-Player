// Integrator: wires the scheduler, the lava-in-hand guard, furnace upkeep and the legacy jobs of join.js together, loads the
// optional module folders (safety/, chat/, dashboard/) and routes chat. See INTERFACE.md.
//
//   const BRAIN = require('./brain')({ bot, say, goals, tryGoto, stopNav, navigateRaw, navActive, handleCommand, farm, excavation,
//                                      jobs, routines, saveRoutines, sleepWanted, stopAllLegacy })
//   BRAIN.route(user, text, { handleCommand, fromCmd })  -> true when handled (caller says the "Got it" ack otherwise)
//   BRAIN.navigate(goal, label, dynamic)                  -> scheduled replacement for join.js navigate()
//   BRAIN.userStop()                                      -> call from the legacy "stay/stop" branch
//
// Everything that can wander the bot around runs through the scheduler, one task at a time, so safety > sleep > chat tasks >
// farm > furnace > excavation, and a preempted task resumes cleanly afterwards.
const fs = require('fs')
const path = require('path')
const EventEmitter = require('events')
const { Scheduler, PRIORITY } = require('./scheduler')
const makeSafehand = require('./safehand')
const makeFurnace = require('./furnace')
const util = require('./util')
const los = require('./los')
const makeBagRoom = require('./bagroom')

const MODULES = ['lag', 'safety', 'chat', 'pilot', 'router', 'excavation', 'nav', 'treefarm', 'routines', 'crafting', 'build', 'lighting', 'mining', 'villagers', 'dashboard', 'autopilot', 'combat', 'survival', 'mode', 'clearbox', 'breath', 'senses', 'plugins', 'hurt']
const NORMALIZE_FILLER = /\b(hey|yo|claude|bot|ozogo444|please|pls|plz|can you|could you|would you|will you|can u|go ahead and|just|now|for me)\b/g
// same normalisation as handleCommand() in join.js
const normalize = (text) => String(text).toLowerCase().replace(/[^\w\s',.-]/g, ' ').replace(NORMALIZE_FILLER, ' ').replace(/\s+/g, ' ').trim()

module.exports = function attach(deps) {
  const { bot, say, goals, tryGoto, stopNav = () => {}, farm, excavation } = deps
  const dir = deps.dir || path.resolve(__dirname, '..')
  const stateDir = deps.stateDir || path.join(__dirname, 'state')
  try { fs.mkdirSync(stateDir, { recursive: true }) } catch {}
  const statePath = (f) => path.join(stateDir, f)
  const now = deps.now || Date.now
  const events = new EventEmitter()
  const ring = []
  const logFile = path.join(dir, 'idle.log')
  function log(tag, msg) {
    const line = `${new Date(now()).toISOString()} ${tag} ${msg}`
    ring.push(line); if (ring.length > 80) ring.shift()
    try { fs.appendFileSync(logFile, line + '\n') } catch {}
  }

  const scheduler = new Scheduler({ stateFile: statePath('scheduler.json'), focusFile: statePath('focus.json'), idleAfterMs: deps.idleAfterMs ?? 15000, safetyCooldownMs: deps.safetyCooldownMs ?? 20000, lingerMs: deps.lingerMs ?? 0, now })
  scheduler.on('log', (m) => log('SCHED', m))
  let lastSafetyAt = 0
  scheduler.on('start', (t) => { if (t.name === 'safety') lastSafetyAt = now() })
  const safetyQuiet = () => now() - lastSafetyAt > 60000      // no safety task for a minute: the area is calm enough for lava work
  scheduler.on('start', (t) => events.emit('task', { event: 'start', task: t }))
  scheduler.on('done', (t) => events.emit('task', { event: 'done', task: t }))
  scheduler.on('parked', (t) => {
    events.emit('task', { event: 'parked', task: t })
    // generic park notice for the pilot's auto-repair: { module (task name), reason, pos }. Modules that park themselves may emit their own richer one as well.
    const p = bot.entity ? bot.entity.position : null
    events.emit('park', { module: t.name, reason: t.parkReason || '', pos: p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null, source: 'scheduler' })
  })
  scheduler.on('failed', (t, e) => { log('TASK_FAILED', `${t.name}: ${e && e.stack || e}`); events.emit('task', { event: 'failed', task: t }) })

  const safehand = makeSafehand({ bot, log: (m) => log('SAFEHAND', m) })
  // the nav module (when loaded) finds a real stand cell with a clear view (the S1 input chest has none within GoalNear radius 3)
  const gotoNear = (o) => (api.nav && api.nav.gotoNear ? api.nav.gotoNear(o) : util.gotoNear({ bot, goals, tryGoto, stop: stopNav, ...o }))
  // Walter's survival-legit rule: a clear line from the eye before opening/clicking/hitting anything. Shared by every module.
  const canSee = (target) => { try { return los.canSee(bot, target) } catch (e) { log('LOS_ERROR', e.message); return false } }
  const depositSmeltables = (o = {}) => furnace.depositSmeltables(o.ctx || null, o)
  const ensureLineOfSight = (o) => los.ensureLineOfSight({ bot, goals, tryGoto: (g, l, ms) => tryGoto(g, l, ms, { escalate: false }), stop: stopNav, ...o })       // finding a viewpoint is a quick walk, never a dig

  // ---------- furnace upkeep ----------
  let furnaceConfig = {}
  try { furnaceConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'furnace-config.json'), 'utf8')) } catch (e) { log('FURNACE_CONFIG_ERROR', e.message) }
  const furnace = makeFurnace({ bot, say, goals, tryGoto, safehand, stopNav, gotoNear, ensureLos: ensureLineOfSight, config: furnaceConfig, stateFile: statePath('furnace-state.json'), now, log: (m) => log('FURNACE', m) })
  const fr = furnace.routine(PRIORITY)
  const frDue = fr.due
  fr.due = () => safetyQuiet() && frDue()
  scheduler.routine(fr)
  // furnace work (lava, chests, long walks) waits while mobs keep forcing safety tasks
  const furnaceRun = async (ctx) => { if (!safetyQuiet()) return { status: 'retry', afterMs: 30000 }; return furnace.run(ctx) }

  // ---------- sleep (wraps the driver's bedRoutine; due every 48000 ticks, see join.js) ----------
  const isNight = () => bot.time && bot.time.timeOfDay >= 12542 && bot.time.timeOfDay < 23460
  let sleepCooldownUntil = 0
  async function sleepRun(ctx, force = false) {
    const jobs = deps.jobs || {}
    const t0 = now()
    // let a running excavation/harvest finish its atomic step first (bedRoutine refuses while they run)
    for (let i = 0; i < 40 && ((excavation && excavation.isRunning()) || (farm && farm.isBusy())); i++) await ctx.sleep(500)
    await jobs.bedRoutine(force)
    ctx.checkpoint()
    // stay in bed (hold the runner) until the night skips or we are woken, at most 8 minutes
    for (let i = 0; i < 480 && bot.isSleeping; i++) await ctx.sleep(1000)
    if (!bot.isSleeping && now() - t0 < 5000) sleepCooldownUntil = now() + 60000   // bedRoutine bailed out; do not preempt everything every 15 s
  }
  scheduler.routine({
    name: 'sleep', priority: PRIORITY.SLEEP, defaultEnabled: true, intervalMs: 15000,
    due: () => !!(bot.entity && bot.time && util.dimOf(bot) === 'overworld' && isNight() && !bot.isSleeping && now() > sleepCooldownUntil && (!deps.sleepWanted || deps.sleepWanted())),
    make: () => ({ name: 'sleep', onUserStop: 'cancel', abort: () => stopNav(), run: (ctx) => sleepRun(ctx, false) })
  })

  // ---------- farm routine (the driver's idle farm routine, flag + timestamps stay in routine-state.json) ----------
  const routines = deps.routines || { farm: false, lastFarmRun: 0 }
  scheduler.routine({
    name: 'farm', priority: PRIORITY.FARM, idleOnly: true, intervalMs: 30000, enabledFn: () => !!routines.farm,
    due: () => !!(util.dimOf(bot) === 'overworld' && bot.time && bot.time.timeOfDay < 12000 && now() - (routines.lastFarmRun || 0) > 20 * 60000),
    make: () => ({
      name: 'farm', abort: () => farm.stop(),
      run: async () => { routines.lastFarmRun = now(); deps.saveRoutines && deps.saveRoutines(); log('IDLE', 'farm routine'); await farm.harvest({ store: true }) }
    })
  })

  // ---------- excavation (only ever started by Walter: "excavate" / "resume excavation") ----------
  function lastExcavateLog() { try { const l = fs.readFileSync(path.join(dir, 'excavate.log'), 'utf8').trim().split('\n'); return l[l.length - 1] || '' } catch { return '' } }
  async function excavationRun(ctx) {
    const t0 = now()
    if (ctx.state.fresh && !ctx.resumed) await excavation.start(); else await excavation.resume()
    ctx.checkpoint()
    const last = lastExcavateLog()
    if (/ DONE /.test(last) && now() - Date.parse(last.split(' ')[0]) < 15000) return { status: 'done' }
    // excavate.js paused itself (hostile near, inventory full, no tools, ...). Retry a few times, then wait for Walter.
    ctx.state.quick = (now() - t0 < 60000) ? (ctx.state.quick || 0) + 1 : 0
    if (ctx.state.quick >= 3) return { status: 'park', reason: 'the excavation keeps pausing itself (see chat); say "resume excavation" when ready' }
    return { status: 'retry', afterMs: 30000 }
  }
  function submitExcavation(fresh) {
    return scheduler.submit({ name: 'excavation', priority: PRIORITY.EXCAVATE, onUserStop: 'park', state: { fresh }, abort: () => excavation.stop(), run: excavationRun })
  }

  // ---------- chat-lane tasks wrapping legacy functions ----------
  function legacyJob(name, fn, priority = PRIORITY.CHAT) {
    return scheduler.submit({ name, priority, onUserStop: 'cancel', abort: () => deps.stopAllLegacy && deps.stopAllLegacy(), run: async () => { await fn() } })
  }
  let navSeq = 0
  function navigate(goal, label, dynamic = false) {
    const nav = handles.find(h => h.provides && h.provides.includes('nav') && h.navigate)
    if (nav) return nav.navigate(goal, label, dynamic)
    for (const t of scheduler.tasks.filter(x => x.name === 'nav')) if (t.state && t.state.dynamic) scheduler.cancel(t.key, 'replaced')   // a follow ends when Walter sends me somewhere else
    return scheduler.submit({
      name: 'nav', key: `nav:${++navSeq}`, priority: PRIORITY.CHAT, onUserStop: 'cancel', state: { goal, label, dynamic },
      abort: () => stopNav(),
      async run(ctx) {
        await safehand.ensureSafeForMove()
        deps.navigateRaw(ctx.state.goal, ctx.state.label, ctx.state.dynamic)
        while (deps.navActive()) await ctx.sleep(300)
      }
    })
  }

  // ---------- outing: walk somewhere, stay there for a while, then release the bot ----------
  // Priority between chat tasks (50) and the idle routines (40/30), so farm/furnace/excavation cannot pull the bot away mid-visit, while safety, sleep and
  // any command from Walter still preempt it. actions: functions (async (ctx) => ...) or names registered in outingActions, run on arrival (look around,
  // take a picture, save a waypoint). Returns the scheduler task.
  const outingActions = { look: async (ctx) => { for (const yaw of [0, 1.57, 3.14, 4.71]) { ctx.checkpoint(); try { await bot.look(yaw, 0, true) } catch {} ; await ctx.sleep(1200) } } }
  function outing(o) {
    const { x, y, z, label = 'there', seconds = 30, actions = [] } = o
    const secs = Math.max(0, Math.min(1800, Number(seconds) || 0))
    return scheduler.submit({
      name: 'outing', key: 'outing', replace: true, priority: PRIORITY.OUTING, ignoreHold: true, onUserStop: 'cancel', state: { arrived: false, left: secs },
      abort: () => stopNav(),
      async run(ctx) {
        const st = ctx.state
        if (!st.arrived) {
          ctx.progress(`walking to ${label}`)
          await safehand.ensureSafeForMove()
          const goal = y === undefined || y === null ? new goals.GoalNearXZ(x, z, 2) : new goals.GoalNear(x, y, z, 2)
          const nav = api.nav
          const r = nav && nav.goto ? await nav.goto(goal, { label, ms: 180000, isAborted: () => ctx.aborted }) : await tryGoto(goal, label, 180000)
          ctx.checkpoint()
          if (!r || !r.ok) { say(`I couldn't get to ${label}${r && r.err ? ': ' + r.err : ''}.`.slice(0, 200)); return }
          st.arrived = true
          say(`I'm at ${label}${secs ? `; looking around for ${secs} seconds` : ''}.`)
          for (const a of actions) { ctx.checkpoint(); const fn = typeof a === 'function' ? a : outingActions[a]; if (fn) { try { await fn(ctx) } catch (e) { if (e && e.name === 'AbortError') throw e; log('OUTING_ACTION_ERROR', e.message) } } }
        }
        while (st.left > 0) { ctx.progress(`${label}: ${st.left}s left`); await ctx.sleep(1000); st.left-- }
        say(`Done at ${label}.`)
      }
    })
  }

  // ---------- goals (focus): say them when they change; run a chain's next command; re-queue the saved job after a restart ----------
  const nextText = (f) => (f.then && f.then.length ? ` Next: ${f.then.map(e => e.note || e.command || e.task).join(', then ')}.` : '')
  scheduler.on('focus', (f) => say(`Priority: ${f.note || f.task}.${nextText(f)}`.slice(0, 220)))
  scheduler.on('focus-end', (f, why) => { if (why === 'time') say(`The priority "${f.note || f.task}" timed out; back to my normal order.`.slice(0, 200)); else if (why === 'done' && !(f.then && f.then.length)) say(`Finished: ${f.note || f.task}. Back to my normal order.`.slice(0, 200)) })
  scheduler.on('focus-command', (next, from) => {
    say(`Finished: ${from.note || from.task}. Now: ${next.note || next.command || next.task}.`.slice(0, 200))
    if (next.command) setTimeout(() => { try { commands.dispatch(api.ownerName, next.command) } catch (e) { log('FOCUS_COMMAND_ERROR', e.message) } }, 400)   // Walter named it in the same sentence: that was his go
  })
  function requeueFocused() {   // after a restart: a saved goal whose job nobody re-queued gets its command run again
    for (const f of scheduler.focuses) {
      if (!f.command || scheduler.tasks.some(t => scheduler._matches(f, t))) continue
      log('FOCUS', `re-queueing ${f.task} with "${f.command}"`)
      try { commands.dispatch(api.ownerName, f.command) } catch (e) { log('FOCUS_COMMAND_ERROR', e.message) }
    }
  }

  // ---------- commands ----------
  const commandList = []
  let loadingModule = null   // set while a module registers, so its chat commands can be dropped again on a hot reload
  const commands = {
    add(c) { if (c && c.name && c.match && c.run) { if (loadingModule) c._module = loadingModule; commandList.push(c); return true } return false },
    list() { return commandList.map(c => ({ name: c.name, help: c.help || '', risk: c.risk || 'low', canonical: String(c.help || '').split('|').map(s => s.trim()).filter(Boolean) })) },
    dispatch(user, text) { return route(user, text, { handleCommand: deps.handleCommand, internal: true }) }
  }
  const test = (m, user, t) => typeof m === 'function' ? m(user, t) : m.test(t)

  const furnaceLine = () => {
    const s = furnace.snapshot()
    const fuel = s.units.map(u => `${u.name} ${u.fuelLava ?? '?'} chest/${u.feederLava ?? '?'} feeder${u.low ? ' LOW' : ''}`).join(', ')
    const dep = s.depots.map(d => `${d.id} ${d.lava ?? '?'}/${d.total}`).join(', ')
    const age = s.lastSurveyAgoS == null ? 'never checked' : `checked ${Math.round(s.lastSurveyAgoS / 60)} min ago`
    return `Furnace lava buckets: ${fuel} (${age}). Depots full: ${dep}. Upkeep is ${scheduler.isEnabled('furnace') ? 'ON' : 'OFF (say "start furnace upkeep")'}.`
  }
  const queueLine = () => {
    const s = scheduler.status()
    const run = s.running ? `${s.running.name}${s.running.progress ? ' (' + s.running.progress + ')' : ''}` : 'nothing (idle)'
    const q = s.queue.map(t => t.name).join(', ')
    const p = s.parked.map(t => t.name).join(', ')
    return `Doing: ${run}.${q ? ' Waiting: ' + q + '.' : ''}${p ? ' Paused for your go: ' + p + '.' : ''} Idle tasks start after ${s.idleAfterS} s of quiet.`
  }

  commands.add({ name: 'furnace-start', help: 'start furnace upkeep', risk: 'high',
    match: /\b(start|begin|enable|turn on|resume)\b.*\bfurnace (upkeep|routine|duty)\b|\bfurnace (upkeep|routine)\b.*\b(on|start|enable)\b|\b(keep|maintain|tend|refill|refuel)\b.*\bthe furnaces\b/,
    run() {
      scheduler.setEnabled('furnace', true)
      say('Furnace upkeep on. I will check the fuel chests about every 10 minutes when it is quiet, and do a first pass now.')
      scheduler.submit({ name: 'furnace', key: 'furnace', priority: PRIORITY.FURNACE, onUserStop: 'park', run: furnaceRun })
    } })
  commands.add({ name: 'furnace-once', help: 'run furnace upkeep once', risk: 'high',
    match: /\b(run|do)\b.*\bfurnace (upkeep|routine)\b.*\b(once|now|one time)\b|\bfurnace upkeep (once|now)\b/,
    run() { say('Running furnace upkeep once.'); scheduler.submit({ name: 'furnace', key: 'furnace', priority: PRIORITY.FURNACE, onUserStop: 'cancel', run: furnaceRun }) } })
  commands.add({ name: 'furnace-stop', help: 'stop furnace upkeep',
    match: /\b(stop|disable|turn off|pause|no more)\b.*\bfurnace (upkeep|routine|duty)\b|\bfurnace (upkeep|routine)\b.*\b(off|stop|disable)\b/,
    run() { scheduler.setEnabled('furnace', false); scheduler.cancel('furnace'); say('Furnace upkeep off.') } })
  commands.add({ name: 'furnace-status', help: 'furnace status',
    match: /\bfurnace (status|report|fuel)\b|\bhow (are|is) the furnaces?\b|\bhow much (lava|fuel)\b/,
    run() { say(furnaceLine().slice(0, 235)) } })
  commands.add({ name: 'furnace-plan', help: 'furnace plan',
    match: /\bfurnace (plan|dry ?run|check)\b/,
    run() {
      scheduler.submit({ name: 'furnace-plan', priority: PRIORITY.CHAT, onUserStop: 'cancel', run: async (ctx) => { for (const l of await furnace.plan(ctx)) say(l.slice(0, 235)) } })
    } })
  commands.add({ name: 'furnace-inspect', help: 'furnace inspect',
    match: /\bfurnace (inspect|diagnos\w*|debug)\b|\bwhy\b.*\bfurnaces?\b.*\b(not|isn.?t|aren.?t)\b/,
    run() { scheduler.submit({ name: 'furnace-inspect', priority: PRIORITY.CHAT, onUserStop: 'cancel', run: async (ctx) => { for (const l of await furnace.inspect(ctx)) say(l.slice(0, 235)) } }) } })
  commands.add({ name: 'furnace-unjam', help: 'furnace unjam',
    match: /\bfurnace (unjam|unblock|clear)\b|\b(unjam|unblock)\b.*\bfurnaces?\b/,
    run() { scheduler.submit({ name: 'furnace-unjam', priority: PRIORITY.CHAT, onUserStop: 'cancel', run: async (ctx) => { const r = await furnace.unjam(ctx); say((r.length ? r.join(' ') : 'No furnace has a blocked input slot.').slice(0, 235)) } }) } })
  commands.add({ name: 'furnace-deposit', help: 'furnace deposit',
    match: /\bfurnace (deposit|dump|unload)\b/,
    run() { scheduler.submit({ name: 'furnace-deposit', priority: PRIORITY.CHAT, onUserStop: 'cancel', run: async (ctx) => { const r = await furnace.depositSmeltables(ctx, { force: true }); if (!Object.keys(r.moved).length && !r.full) say('Nothing smeltable to put in the input chests.') } }) } })
  commands.add({ name: 'furnace-balance', help: 'furnace balance',
    match: /\bfurnace (balance|spread|redistribute)\b|\b(balance|spread)\b.*\b(input chests?|furnaces)\b/,
    run() { scheduler.submit({ name: 'furnace-balance', priority: PRIORITY.CHAT, onUserStop: 'cancel', run: async (ctx) => { say((await furnace.balanceInputs(ctx)).slice(0, 235)) } }) } })
  commands.add({ name: 'furnace-verify', help: 'furnace verify',
    match: /\bfurnace (verify|config)\b|\bverify\b.*\bfurnace/,
    run() { const p = furnace.verify(); say(p.length ? `Furnace config: ${p.slice(0, 4).join('; ')}`.slice(0, 235) : 'Furnace config matches the world.') } })
  commands.add({ name: 'idle-delay', help: 'idle tasks after 15 seconds of quiet',
    match: (u, t) => /\b(idle|quiet)\b/.test(t) && /\b\d+\s*(seconds?|secs?|s|minutes?|mins?|m)\b/.test(t) && !/\bfurnace\b/.test(t),
    run(u, text, t) {
      const m = /\b(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m)\b/.exec(t)
      const ms = Number(m[1]) * (/^m/.test(m[2]) ? 60000 : 1000)
      scheduler.setIdleAfter(ms)
      say(`OK, idle jobs start after ${Math.round(scheduler.idleAfterMs / 1000)} seconds of quiet and stop the moment you type.`)
    } })
  commands.add({ name: 'linger', help: 'stay 30 seconds after a trip',
    match: (u, t) => /^(set |change |please )?linger\b/.test(t) && /\b\d+\s*(seconds?|secs?|s|minutes?|mins?|m)\b/.test(t),
    run(u, text, t) { const m = /\b(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m)\b/.exec(t); scheduler.setLinger(Number(m[1]) * (/^m/.test(m[2]) ? 60000 : 1000)); say(`OK, after you send me somewhere I stay for ${Math.round(scheduler.lingerMs / 1000)} seconds before routines take over.`) } })
  commands.add({ name: 'visit', help: 'visit -1056 2334 for 30 seconds',
    match: /^(visit|go see|check out|inspect the site at)\b.*(-?\d+[ ,]+-?\d+|\bfor\b.*\b\d+\s*(s|sec|seconds?|m|min|minutes?)\b)/,
    run(u, text, t) {
      const co = /(-?\d+)[ ,]+(-?\d+)(?:[ ,]+(-?\d+))?(?![\d ]*(?:s|sec|seconds?|m|min|minutes?)\b)/.exec(t.replace(/\bfor\b.*$/, ''))
      const dur = /\bfor\s+(\d+)\s*(s|sec|seconds?|m|min|minutes?)\b/.exec(t)
      const secs = dur ? Number(dur[1]) * (/^m/.test(dur[2]) ? 60 : 1) : 30
      if (!co) return say('Tell me where: visit <x> <z> for <seconds>.')
      const a = Number(co[1]), b = Number(co[2]), c = co[3] === undefined ? undefined : Number(co[3])
      const spot = c === undefined ? { x: a, z: b, label: `x ${a}, z ${b}` } : { x: a, y: b, z: c, label: `${a}, ${b}, ${c}` }
      say(`Going to ${spot.label} and staying ${secs} seconds.`)
      outing({ ...spot, seconds: secs, actions: ['look'] })
    } })
  commands.add({ name: 'focus-status', help: 'focus status',
    match: /^(focus status|what.?s (the )?focus|what are you focus(ed|ing) on)\b/,
    run() { const f = scheduler.focusList(); say(f.length ? `Focus: ${f.map(x => `${x.note || x.task} (p${x.priority}, ${x.untilDone ? 'until done' : x.leftS + 's left'}${x.next && x.next.length ? '; next: ' + x.next.join(', ') : ''})`).join('; ')}.`.slice(0, 235) : 'No special focus; I follow the normal order.') } })
  commands.add({ name: 'focus-clear', help: 'clear focus',
    match: /^(clear|drop|end|cancel) (the )?(focus|priorities|priority)\b|^back to (the )?normal (order|priorities)\b/,
    run() { const n = scheduler.clearFocus(); say(n ? 'OK, back to the normal order.' : 'There was no special focus.') } })
  commands.add({ name: 'queue', help: 'what are you doing',
    match: /^(what are you (doing|up to|working on)|tasks?|queue|task queue|what.?s (queued|next))\b/,
    run() { say(queueLine().slice(0, 235)) } })
  commands.add({ name: 'resume', help: 'resume tasks', risk: 'high',
    match: /^(resume|carry on|continue|go on)( tasks?| what you were doing| everything)?$|^(resume|continue) (the )?(furnace|farm|everything|tasks?)\b/,
    run() { const n = scheduler.resumeParked(); say(n ? `Resuming ${n} paused task(s).` : 'Nothing is paused.') } })
  commands.add({ name: 'excavate-resume', help: 'resume excavation', risk: 'high',
    match: /\b(resume|continue)\b.*(excavat|dig|carv)/,
    run() { say('Resuming the excavation (it yields to anything else).'); const t = scheduler.resumeParked('excavation'); if (!t) submitExcavation(false) } })
  commands.add({ name: 'excavate-start', help: 'excavate', risk: 'high',
    match: /^(excavate|carve)\b|\b(start|begin|get started|do it)\b.*(excavat|carv|digging)/,
    run() { scheduler.cancel('excavation'); submitExcavation(true) } })
  commands.add({ name: 'harvest', help: 'harvest crops', risk: 'high',
    match: /\b(harvest|get (some )?food|gather (food|crops)|pick (the )?crops|farm (the )?crops)\b/,
    run() { scheduler.submit({ name: 'farm', key: 'farm', priority: PRIORITY.CHAT, onUserStop: 'cancel', abort: () => farm.stop(), run: async () => { await farm.harvest({ store: true }) } }) } })
  commands.add({ name: 'store', help: 'store crops', match: /\bstore\b.*\b(crops|food|harvest)\b/,
    run() { legacyJob('store-crops', () => farm.storeCrops()) } })
  commands.add({ name: 'sleep-now', help: 'sleep', match: /^(sleep|go to bed|time (to|for) (sleep|bed)|let.?s sleep|go sleep)\b/,
    run() { scheduler.submit({ name: 'sleep', key: 'sleep', priority: PRIORITY.SLEEP, onUserStop: 'cancel', abort: () => stopNav(), run: (ctx) => sleepRun(ctx, true) }) } })
  const J = deps.jobs || {}
  if (J.indexChests) commands.add({ name: 'index-chests', help: 'index chests', risk: 'high', match: /\b(index|catalog|catalogue|map)\b.*\bchests?\b/, run() { legacyJob('index-chests', () => J.indexChests()) } })
  if (J.inspectStations) commands.add({ name: 'inspect-stations', help: 'inspect stations', risk: 'high', match: /\b(inspect|check|read)\b.*\b(stations?|chests?|furnaces)\b(?!.*\bupkeep\b)/, run() { legacyJob('inspect-stations', () => J.inspectStations()) } })
  if (J.craftToolSet) commands.add({ name: 'craft', help: 'craft tool set', risk: 'high', match: /\btool ?set\b|\bmake yourself\b|^craft (?:me )?(?:some |a |the )?tools?$/, run() { legacyJob('craft', () => J.craftToolSet()) } })
  if (J.runNavTest) commands.add({ name: 'nav-test', help: 'test navigation', match: /\btest\b.*\bnav/, run() { legacyJob('nav-test', () => J.runNavTest()) } })
  if (J.usePortal) {
    commands.add({ name: 'portal-nether', help: 'go to the nether', risk: 'high', match: (u, t) => /\b(nether)\b/.test(t) && /\b(go|take|travel|head|enter|through|into|to)\b/.test(t) && !/\b(leave|out of|back from)\b/.test(t), run() { legacyJob('portal', () => J.usePortal('the_nether')) } })
    commands.add({ name: 'portal-overworld', help: 'go back to the overworld', risk: 'high', match: /\b(leave|exit|out of)\b.*\bnether\b|\b(go|head|come|get) back\b.*\b(overworld|home)\b|\bback to the overworld\b|\bto the overworld\b/, run() { legacyJob('portal', () => J.usePortal('overworld')) } })
  }
  if (J.runDoorTest) commands.add({ name: 'door-test', help: 'test doors', match: /\btest\b.*\bdoor/, run() { legacyJob('door-test', () => J.runDoorTest()) } })

  // "don't follow me", "never mind the digging": a negated command must not run the command (the legacy regexes would)
  const NEG = /^(?:please )?(?:don'?t|do not|never|no need to|no more)\s+(.*)$/
  function negation(user, t) {
    const m = NEG.exec(t); if (!m) return false
    const what = m[1]
    if (/\b(fight|attack)\b/.test(what)) return false       // "don't fight" belongs to the safety module
    if (/\b(follow|come|walk|move|go)\b/.test(what)) for (const t of scheduler.tasks.filter(x => x.name === 'nav')) scheduler.cancel(t.key)   // never loop on cancel(): a running task stays listed until it settles
    else if (/\b(excavat|dig|carv)/.test(what)) scheduler.cancel('excavation')
    else if (/\bmin(e|ing)\b/.test(what)) scheduler.cancel('mining', 'user-stop')   // parks it (resumable) like a stop
    else if (/\bfurnace/.test(what)) { scheduler.setEnabled('furnace', false); scheduler.cancel('furnace') }
    else if (/\b(harvest|farm|crop)/.test(what)) { scheduler.cancel('farm'); farm.stop() }
    else return false
    stopNav(); say('Okay, not doing that.')
    return true
  }

  // ---------- outdoor gate: build / mining / treefarm only start (and keep running) in daylight, with health >= 18 and no hostile mob close ----------
  // The 03:50 restart auto-resumed the tower and mining at night and the bot nearly died. Held tasks wait in the queue; a focus on the task, an explicit
  // "go anyway" (30 minutes) or the dimension (nether: only health and mobs count) lifts it. Config: deps.gate = { minHealth, hostileRadius, dayEnd, names }.
  const gateCfg = { minHealth: 18, hostileRadius: 16, nearRadius: 6, sightRadius: 14, mobHoldMs: 10000, dayEnd: 11500, names: ['build', 'mining', 'treefarm'], undergroundOk: ['mining'], ...(deps.gate || {}) }
  let hostileNames = null
  try { hostileNames = new Set(Object.entries(require('./safety/profiles').PROFILES).filter(([, p]) => p.kind && p.kind !== 'neutral').map(([n]) => n)) } catch {}
  // A mob counts only if it is a real threat (Walter: false flags): within 6 blocks, or in line of sight within 14 (arrows), and not far above/below. Mobs behind walls, in
  // other caves or on other levels are ignored. Uses the safety module's line-of-sight test. A job that is already running (mining in the shaft) is never paused for a mob:
  // brain/safety handles real attacks.
  let entityVisible = null
  try { entityVisible = require('./safety/reach').entityVisible } catch {}
  const hostileClose = () => {
    if (!bot.entity) return null
    const me = bot.entity.position
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e === bot.entity || e.type === 'player' || !e.position) continue
      if (!(e.type === 'hostile' || (hostileNames && hostileNames.has(e.name)))) continue
      const d = e.position.distanceTo(me), dy = Math.abs(e.position.y - me.y)
      if (d > gateCfg.hostileRadius) continue
      if (d <= gateCfg.nearRadius && dy <= 5) return e
      if (d <= gateCfg.sightRadius && dy <= 8) { let vis = false; try { vis = entityVisible ? !!entityVisible(bot, e) : true } catch { vis = true }; if (vis) return e }
    }
    return null
  }
  scheduler.setGate({
    names: new Set(gateCfg.names),
    check: (task, opts = {}) => {
      if (!bot.entity) return true
      // night only matters outdoors: with no sky light at the bot's feet (underground, in the shaft, indoors) the daylight rule is skipped; health and mobs still count
      let underground = false
      try { const b = bot.blockAt(bot.entity.position.floored()); underground = !!(b && b.skyLight === 0) } catch {}
      // Walter: never hold work for daylight or mobs (improvise instead; safety fights or walls in on its own). Only lethal danger pauses, briefly.
      if (bot.health < 6) return { ok: false, reason: `my health is above 6 (now ${Math.round(bot.health)})`, holdMs: 5000 }
      return true
    }
  })
  scheduler.on('gate-hold', (t, reason) => { log('GATE', `holding ${t.name} until ${reason}`) })
  commands.add({ name: 'gate-override', help: 'go anyway', risk: 'high',
    match: /^(go|do it|mine|build|carry on|keep going) anyway\b|^(ignore|skip|override) (the )?(night|daylight|safety|gate|outdoor)( rule| gate| check)?\b/,
    run() { scheduler.gateOverride(30 * 60000); say('OK, ignoring the daylight and health check for 30 minutes. Safety still protects me.') } })

  // ---------- bag room: before a job that needs space starts, free the bag (smeltables to the furnaces, spare items to the mine storage chests) ----------
  const BAG_TASKS = new Set(['excavation', 'mining', 'treefarm', 'build', 'farm', 'lighting'])
  const bagroom = makeBagRoom({ bot, api: { gotoNear, ensureLineOfSight, depositSmeltables }, say, log: (m) => log('BAGROOM', m), now })
  scheduler.addPreStart({ applies: (t) => BAG_TASKS.has(t.name) && !t.runs, run: (ctx, t) => bagroom.makeRoom(ctx, t) })
  // and whenever the bag drops below 6 free slots (checked every 20 s), not only when a job starts: priority just above mining/excavation, so it runs at the next gap
  scheduler.routine({
    name: 'bag-room', priority: PRIORITY.EXCAVATE + 2, defaultEnabled: true, intervalMs: 20000,
    due: () => !!(bot.entity && bot.inventory && bot.inventory.emptySlotCount() < 6 && !bot.isSleeping),
    make: () => ({ name: 'bag-room', onUserStop: 'cancel', run: (ctx) => bagroom.makeRoom(ctx, { name: 'bag-room' }) })
  })
  commands.add({ name: 'make-room', help: 'make room in your bag',
    match: /^(make|free up|clear) (some )?(room|space)\b|^(empty|clear out) (your )?(bag|inventory)\b/,
    run() { scheduler.submit({ name: 'make-room', priority: PRIORITY.CHAT, onUserStop: 'cancel', run: async (ctx) => { const r = await bagroom.makeRoom(ctx, { name: 'make-room' }); if (r.skipped) say(`My bag has ${bot.inventory.emptySlotCount()} free slots; that is enough.`) } }) } })

  // ---------- modules ----------
  const handles = []
  const api = { bagroom: { makeRoom: (ctx, t) => bagroom.makeRoom(ctx, t), plan: () => bagroom.plan() }, bot, PRIORITY, scheduler, say, goals, tryGoto, stopNav, safehand, gotoNear, canSee, ensureLineOfSight, depositSmeltables, outing, outingActions, smeltablesPlan: () => furnace.smeltablesPlan(), ownerName: deps.ownerName || 'OGWO', dir, statePath, log, now, commands, events,
    status: { all: () => statusAll() } }
  // remove the built-in commands a module has taken over (only ones registered before the module loaded, i.e. built-ins)
  let builtinN = 0
  function dropBuiltin(pred) { for (let i = Math.min(commandList.length, builtinN) - 1; i >= 0; i--) if (pred(commandList[i])) { commandList.splice(i, 1); builtinN-- } }
  function loadModules() {
    builtinN = commandList.length
    const entries = deps.moduleEntries || MODULES.map(n => ({ name: n, path: path.join(__dirname, n, 'index.js') }))
    // modules can be switched off without code changes: env BRAIN_DISABLE=chat,nav or brain/state/disabled-modules.json ["chat"]
    let off = String(process.env.BRAIN_DISABLE || '').split(',').map(x => x.trim()).filter(Boolean)
    try { off = off.concat(JSON.parse(fs.readFileSync(statePath('disabled-modules.json'), 'utf8'))) } catch {}
    for (const { name, path: p } of entries) {
      if (off.includes(name)) { log('MODULE', `${name} disabled`); continue }
      if (!fs.existsSync(p)) continue
      try {
        loadingModule = name
        const h = require(p)(api)
        loadingModule = null
        if (h) {
          h.name = h.name || name; h._folder = name; handles.push(h); log('MODULE', `${h.name} registered`)
          if (!h.provides && (name === 'excavation' || name === 'nav')) h.provides = [name]   // the folder name implies what it replaces
          // a module that provides excavation replaces the built-in adapter commands (they would otherwise match first)
          if (h.provides && h.provides.includes('excavation')) dropBuiltin(c => /^excavate-/.test(c.name))
          // routines (farm + sleep) replaces the built-in routines by name and the built-in harvest/store/sleep commands (the old harvest regex would start farm.js on "stop harvest")
          if (h.provides && h.provides.some(p => p === 'routines' || p === 'farm')) dropBuiltin(c => c.name === 'harvest' || c.name === 'store')
          if (h.provides && h.provides.some(p => p === 'routines' || p === 'sleep')) dropBuiltin(c => c.name === 'sleep-now')
        }
      } catch (e) { log('BRAIN_MODULE_ERROR', `${name}: ${e.stack || e.message}`); console.log('BRAIN_MODULE_ERROR', name, e.message) }
    }
  }
  const each = (fn, what) => { for (const h of handles) { try { if (h[what]) { const r = fn(h); if (r) return true } } catch (e) { log('BRAIN_MODULE_ERROR', `${h.name}.${what}: ${e.stack || e.message}`) } } return false }

  // ---------- chat routing ----------
  const INFO_START = /^\W*(?:what(?:'s| is| are| do)?\b.*\b(?:doing|up to|working on|around|see|queued|next|status|have|carrying|holding)|how (?:are|is|many|much|far|long)|status|health|inventory|where (?:are|is)|who(?:'s| is)|when|why|tell me|thanks|thank you|ok|okay|nice|good|great|cool|hi|hello|hey|lol|haha)\b/i
  const BODY_WORDS = /\b(?:go|come|follow|stay|stop|pause|wait|sleep|bed|mine|craft|harvest|dig|resume|excavate|move|walk|run|fight|attack|get|bring|put|take|place|open|build|teleport|tp|hold|queue|cancel|start|begin|set|save|turn)\b/i
  const isInfoOnly = (text) => { const s = String(text || '').trim(); return s.length > 0 && s.length <= 120 && INFO_START.test(s) && !BODY_WORDS.test(s) }
  function route(user, text, opts = {}) {
    const hc = opts.handleCommand || deps.handleCommand
    // Walter: tasks must persist through chat. Pure information / small-talk messages do NOT reset the quiet timer, so they cannot abort idle-only jobs
    // (a running furnace pass was being preempted by "what are you up to"). Anything that needs the bot's body or looks like a command still does.
    if (!opts.fromCmd && !opts.internal) { scheduler.noteTalk(); events.emit('chat', { user, text }) }
    const t = normalize(text)
    if (!opts.internal && each(h => h.onChat(user, text), 'onChat')) return true
    try { if (negation(user, t)) return true } catch (e) { log('NEG_ERROR', e.message) }
    for (const c of commandList) {
      let hit = false
      try { hit = test(c.match, user, t) } catch (e) { log('COMMAND_MATCH_ERROR', `${c.name}: ${e.message}`) }
      if (!hit) continue
      if (!opts.fromCmd && !opts.internal && !isInfoOnly(text)) scheduler.noteChat()   // a real command: idle jobs may be aborted
      try { c.run(user, text, t) } catch (e) { log('COMMAND_ERROR', `${c.name}: ${e.stack || e.message}`); say(`That failed: ${e.message}`.slice(0, 150)) }
      return true
    }
    if (hc && hc(user, text)) { if (!opts.fromCmd && !opts.internal && !isInfoOnly(text)) scheduler.noteChat(); return true }
    if (!opts.internal && each(h => h.fallback(user, text), 'fallback')) return true
    if (!opts.internal) { try { fs.appendFileSync(path.join(dir, 'unhandled.log'), `${new Date(now()).toISOString()} ${user}: ${text}\n`) } catch {} }
    return false
  }

  // ---------- status ----------
  // In-memory chat ring with both sides of the conversation (the server echoes the bot's own lines as <OzoGo444> ...).
  const chatRing = []
  const onMsg = (m) => {
    const g = /^<([^>]+)> (.*)$/.exec(m) || /^(S+) whispers to you: (.*)$/.exec(m)
    if (!g) return
    chatRing.push({ t: new Date(now()).toISOString(), user: g[1], text: g[2] }); if (chatRing.length > 60) chatRing.shift()
  }
  bot.on('messagestr', onMsg)
  // farm.js's auto-eat swaps the held item every few seconds; keep it quiet while safety work (fighting/fleeing) runs
  const eatGate = setInterval(() => { const r = scheduler.running; bot.noAutoEat = !!(r && r.priority >= PRIORITY.SAFETY) }, 400)
  if (eatGate.unref) eatGate.unref()
  function tail(file, n) { try { return fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').slice(-n) } catch { return [] } }
  function statusAll() {
    const p = bot.entity ? bot.entity.position : null
    const modules = {}
    for (const h of handles) { try { if (h.status) modules[h.name] = h.status() } catch (e) { modules[h.name] = { error: e.message } } }
    return {
      at: new Date(now()).toISOString(),
      bot: p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), health: bot.health, food: bot.food, dimension: bot.game && bot.game.dimension, timeOfDay: bot.time && bot.time.timeOfDay, held: bot.heldItem ? bot.heldItem.name : null, sleeping: !!bot.isSleeping } : null,
      scheduler: scheduler.status(), furnace: furnace.snapshot(), modules, chatTail: chatRing.length ? chatRing.slice(-20) : tail('chat.log', 20), logTail: ring.slice(-20), unhandledTail: tail('unhandled.log', 5)
    }
  }

  // Walter: after a restart the bot says what is new, once. brain/state/whats-new.txt (2-4 short lines, written before each restart) is read after spawn and then emptied.
  function announceWhatsNew() {
    try {
      const f = statePath('whats-new.txt')
      if (!fs.existsSync(f)) return
      const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 4)
      if (!lines.length) return
      fs.writeFileSync(f, '')
      for (const l of lines) say(l.slice(0, 220))
      log('WHATS_NEW', lines.join(' | '))
    } catch (e) { log('WHATS_NEW_ERROR', e.message) }
  }
  let newsTimer = null, focusTimer = null

  // ---------- hot reload: new module code goes live in the running process, no rejoin (Walter 2026-11-02) ----------
  // Write module folder names (or "all") into brain/state/reload.txt; the result lands in brain/state/reload-out.txt. Also bot._brain.reload(name).
  // Only the core (brain/index.js, scheduler.js, util.js, safehand.js, join.js) still needs a restart.
  function reloadModule(name) {
    const dir = path.join(__dirname, name), p = path.join(dir, 'index.js')
    if (!fs.existsSync(p)) return `${name}: no such module`
    const old = handles.find(h => h._folder === name || h.name === name)
    if (old) { try { old.stop && old.stop() } catch (e) { log('RELOAD', `${name}.stop: ${e.message}`) } handles.splice(handles.indexOf(old), 1) }
    for (let i = commandList.length - 1; i >= 0; i--) if (commandList[i]._module === name) commandList.splice(i, 1)
    for (const k of Object.keys(require.cache)) if (k.startsWith(dir + path.sep)) delete require.cache[k]
    try {
      loadingModule = name
      const h = require(p)(api)
      loadingModule = null
      if (!h) return `${name}: loaded (no handle)`
      h.name = h.name || name; h._folder = name; handles.push(h)
      try { h.start && h.start() } catch (e) { log('RELOAD', `${name}.start: ${e.message}`) }
      log('RELOAD', `${name} reloaded`)
      return `${name}: reloaded`
    } catch (e) { loadingModule = null; log('RELOAD', `${name} failed: ${e.stack || e.message}`); return `${name}: FAILED ${e.message}` }
  }
  function reload(names) {
    const list = (!names || names === 'all') ? handles.map(h => h._folder || h.name) : [].concat(names)
    return list.map(reloadModule)
  }
  bot._brain = { reload, modules: () => handles.map(h => h._folder || h.name) }
  const reloadFile = statePath('reload.txt'), reloadOut = statePath('reload-out.txt')
  const reloadPoll = setInterval(() => {
    let t = ''; try { t = fs.readFileSync(reloadFile, 'utf8').trim() } catch { return }
    if (!t) return
    try { fs.writeFileSync(reloadFile, '') } catch {}
    const names = t === 'all' ? 'all' : t.split(/[\s,]+/).filter(Boolean)
    const out = reload(names)
    try { fs.writeFileSync(reloadOut, new Date().toISOString() + '\n' + out.join('\n') + '\n') } catch {}
  }, 2000)
  if (reloadPoll.unref) reloadPoll.unref()

  function start() {
    newsTimer = setTimeout(announceWhatsNew, 8000); if (newsTimer.unref) newsTimer.unref()
    focusTimer = setTimeout(requeueFocused, 12000); if (focusTimer.unref) focusTimer.unref()
    safehand.start()
    loadModules()
    for (const h of handles) { try { h.start && h.start() } catch (e) { log('BRAIN_MODULE_ERROR', `${h.name}.start: ${e.stack || e.message}`) } }
    scheduler.start()
    log('BRAIN', `started; modules: ${handles.map(h => h.name).join(', ') || 'none'}; routines: ${scheduler.status().routines.map(r => r.name + (r.enabled ? '+' : '-')).join(' ')}`)
  }
  function stop() { clearTimeout(newsTimer); clearTimeout(focusTimer); for (const h of handles) { try { h.stop && h.stop() } catch {} } clearInterval(eatGate); bot.removeListener('messagestr', onMsg); bot.noAutoEat = false; scheduler.stop(); safehand.stop() }

  start()
  return { route, navigate, userStop: () => scheduler.userStop(), scheduler, safehand, furnace, commands, api, status: statusAll, stop, normalize }
}
module.exports.normalize = normalize
