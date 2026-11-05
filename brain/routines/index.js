// brain/routines: farm + replant + house-chest storage, and the sleep/bed routine, as scheduler routines (see README.md and brain/INTERFACE.md).
// Replaces the driver's idle farm routine, bedRoutine and the farm.js harvest loop. farm.js keeps running only for its auto-eat timer.
const fs = require('fs')
const path = require('path')
const stateStore = require('./state')
const createFarm = require('./farm')
const createSleep = require('./sleep')
const common = require('./common')
const baseConfig = require('./config.json')

// Chat phrases (tested against the lowercased, filler-stripped text; same wording as the driver's built-ins).
const P = {
  FARM_RUN: /\b(harvest|get (some )?food|gather (food|crops)|pick (the )?crops|farm (the )?crops)\b/,
  STORE: /\bstore\b.*\b(crops|food|harvest)\b/,
  FARM_ON: /\bfarm routine\b.*\b(on|start|enable)\b|\b(start|enable|turn on)\b.*\bfarm routine\b/,
  FARM_OFF: /\bfarm routine\b.*\b(off|stop|disable)\b|\b(stop|disable|turn off)\b.*\bfarm routine\b/,
  FARM_STATUS: /\bfarm (status|report)\b|\bhow (is|are) the (farm|crops)\b|\bfarm routine status\b/,
  SLEEP_NOW: /^(sleep|go to bed|time (to|for) (sleep|bed)|let.?s sleep|go sleep)\b/,
  BAMBOO_AT: /\bbamboo (patch|farm|plot)\b/,
  SLEEP_STATUS: /\b(sleep|bed) (status|schedule)\b|\bwhen (do|will|are) (you|we) (next )?sleep\b|\bwhen.*next sleep\b/
}
const NEG = /^(?:please )?(?:don'?t|do not|never|no need to|no more|stop|cancel|quit)\b/
const FILLER = /\b(hey|yo|claude|bot|ozogo444|please|pls|plz|can you|could you|would you|will you|can u|go ahead and|just|now|for me)\b/g
const norm = (text) => String(text).toLowerCase().replace(/[^\w\s',.-]/g, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim()

function register(api) {
  const { scheduler, say, PRIORITY } = api
  const log = (m) => api.log('routines', m)
  const config = baseConfig

  const file = api.statePath('routines-state.json')
  const state = stateStore.load({ file, legacyRoutineFile: path.join(api.dir, 'routine-state.json'), legacySleepFile: path.join(api.dir, 'sleep-state.json'), log })
  const save = () => stateStore.save(file, state, api.now, log)
  if (state.importedFrom.length && !fs.existsSync(file)) save()

  const waypoints = () => common.readJson(fs, path.join(api.dir, 'waypoints.json'), {})
  const waypointFn = (name) => { const w = waypoints()[name]; return w && Number.isFinite(w.x) ? w : null }
  // farm sites: the configured ones plus every waypoint whose name contains "farm" (Walter adds farms as waypoints)
  function sitesFn() {
    const re = new RegExp(config.farm.sitePattern, 'i'), byName = new Map()
    for (const s of config.farm.sites) byName.set(s.name, s)
    for (const [name, w] of Object.entries(waypoints())) if (re.test(name) && w && Number.isFinite(w.x) && Number.isFinite(w.z)) byName.set(name, { name, x: w.x, y: Number.isFinite(w.y) ? w.y : 64, z: w.z })
    return [...byName.values()]
  }

  const base = { bot: api.bot, say, goals: api.goals, tryGoto: api.tryGoto, safehand: api.safehand, stopNav: api.stopNav, config, state, save, canSee: api.canSee, now: api.now, log }
  const craft = api.commands && typeof api.commands.dispatch === 'function'
    ? { dispatch: (text) => api.commands.dispatch(api.ownerName, text), busy: () => { try { const q = scheduler.status(); return !!((q.running && q.running.name === 'craft') || q.queue.some(t => t.name === 'craft')) } catch { return false } } }
    : null
  const farm = createFarm({ ...base, sitesFn, waypointFn, craft })
  const sleep = createSleep({ ...base, ownerName: api.ownerName })

  // ---------- tasks ----------
  const farmTask = (manual) => scheduler.submit({
    name: 'farm', key: 'farm', priority: manual ? PRIORITY.CHAT : PRIORITY.FARM, idleOnly: !manual, onUserStop: manual ? 'cancel' : 'park',
    abort: () => farm.abort(), run: (ctx) => farm.run(ctx, { manual })
  })
  const sleepTask = (force) => scheduler.submit({
    name: 'sleep', key: 'sleep', priority: PRIORITY.SLEEP, onUserStop: 'cancel', abort: () => sleep.abort(), run: (ctx) => sleep.run(ctx, { force })
  })

  // Replace the integrator's built-in 'farm' and 'sleep' routines (same names; scheduler.routine() overwrites by name).
  scheduler.routine({
    name: 'farm', priority: PRIORITY.FARM, idleOnly: true, intervalMs: 30000, enabledFn: () => !!state.farm.enabled,
    due: () => farm.due(),
    make: () => ({ name: 'farm', abort: () => farm.abort(), run: (ctx) => { log('idle farm routine'); return farm.run(ctx, { manual: false }) } })
  })
  scheduler.routine({
    name: 'sleep', priority: PRIORITY.SLEEP, defaultEnabled: true, intervalMs: 15000,
    due: () => sleep.due(),
    make: () => ({ name: 'sleep', onUserStop: 'cancel', abort: () => sleep.abort(), run: (ctx) => sleep.run(ctx, { force: false }) })
  })

  // ---------- chat ----------
  const sleepLine = () => {
    const s = sleep.snapshot()
    if (s.sleeping) return 'I am in bed right now.'
    if (s.ticksSinceWake === null) return 'I have no record of when I last slept, so I will sleep on the next night.'
    if (s.dueNow) return 'I am due for sleep: I go to bed as soon as it is night.'
    return `Next sleep in about ${Math.max(1, Math.round(s.ticksUntilDue / 24000 * 10) / 10)} day(s); I sleep every third night.`
  }
  const farmLine = () => {
    const f = farm.snapshot()
    const age = f.lastRunAgoS === null ? 'no run yet' : `last run ${Math.round(f.lastRunAgoS / 60)} min ago`
    return `Farm routine is ${f.enabled ? 'ON' : 'OFF (say "farm routine on")'}, ${age}. Food on me: ${f.food}. ${f.pendingReplants ? f.pendingReplants + ' spot(s) waiting for seeds. ' : ''}Farms: ${f.sites.join(', ') || 'none known'}.`.slice(0, 235)
  }
  const commands = [
    { name: 'farm-routine-on', help: 'farm routine on', risk: 'high', match: P.FARM_ON, run() { state.farm.enabled = true; save(); say('Farm routine on: when I am idle, about every 45 minutes in daytime I harvest ripe crops, replant, and store extras in the house chest.') } },
    { name: 'farm-routine-off', help: 'farm routine off', risk: 'low', match: P.FARM_OFF, run() { state.farm.enabled = false; save(); scheduler.cancel('farm'); say('Farm routine off.') } },
    { name: 'farm-status', help: 'farm status | how is the farm', risk: 'low', match: P.FARM_STATUS, run() { say(farmLine()) } },
    { name: 'harvest', help: 'harvest crops', risk: 'high', match: P.FARM_RUN, run() { farmTask(true) } },
    { name: 'store-crops', help: 'store crops', risk: 'low', match: P.STORE,
      run() { scheduler.submit({ name: 'store-crops', key: 'store-crops', priority: PRIORITY.CHAT, onUserStop: 'cancel', abort: () => farm.abort(), run: async (ctx) => { await farm.storeCrops(ctx) } }) } },
    { name: 'bamboo-patch', help: 'bamboo patch at <x> <y> <z>', risk: 'low', match: P.BAMBOO_AT,
      run(user, text) {
        const m = /(-?\d+)\s*[ ,]\s*(-?\d+)\s*[ ,]\s*(-?\d+)/.exec(String(text))
        if (!m) return say('Tell me where: "bamboo patch at <x> <y> <z>".')
        farm.registerBamboo(+m[1], +m[2], +m[3]); say(`OK, I will look after the bamboo patch at ${m[1]}, ${m[2]}, ${m[3]}: bottom stalk stays, the rest is cut with an axe.`)
      } },
    { name: 'sleep-status', help: 'sleep status | when do we sleep next', risk: 'low', match: P.SLEEP_STATUS, run() { say(sleepLine()) } },
    { name: 'sleep-now', help: 'sleep | go to bed', risk: 'low', match: P.SLEEP_NOW, run() { sleepTask(true) } }
  ]
  for (const c of commands) { try { api.commands.add(c) } catch (e) { log(`command ${c.name} not added: ${e.message}`) } }

  // Runs before the integrator's built-in commands of the same wording (it asks for 'harvest', 'store', 'sleep-now' first otherwise).
  function onChat(user, text) {
    const t = norm(text)
    if (NEG.test(t)) return false
    for (const c of commands) {
      let hit = false
      try { hit = c.match.test(t) } catch {}
      if (!hit) continue
      try { c.run(user, text, t) } catch (e) { log(`command ${c.name}: ${e.message}`); say(`That failed: ${e.message}`.slice(0, 150)) }
      return true
    }
    return false
  }

  const onWake = () => sleep.onWake()
  return {
    name: 'routines',
    provides: ['routines', 'farm', 'sleep'],
    start() { if (typeof api.bot.on === 'function') api.bot.on('wake', onWake) },
    stop() { if (typeof api.bot.removeListener === 'function') api.bot.removeListener('wake', onWake) },
    status: () => ({ farm: farm.snapshot(), sleep: sleep.snapshot() }),
    onChat, farm, sleep, state
  }
}
register.meta = require('./meta.json')

module.exports = register
module.exports.meta = register.meta
module.exports.phrases = P
