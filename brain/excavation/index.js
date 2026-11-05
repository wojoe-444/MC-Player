// brain/excavation: Walter's room excavation as a scheduler module (see README.md and brain/INTERFACE.md).
// Never starts or resumes digging on its own: the job only exists after Walter says "excavate" / "resume excavation"
// (or after a restart while his go was still in effect, i.e. it was running and had not been stopped or paused).
const fs = require('fs')
const path = require('path')
const stateStore = require('./state')
const createEngine = require('./engine')
const baseConfig = require('./config.json')

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch { return fallback } }

// Chat phrases (tested against the lowercased, filler-stripped text).
const STATUS = /\b(excavat\w*|carv\w*|digging|dig out)\b.*\b(status|progress|going|far|left|remaining)\b|\b(status|progress|how far|how is|how's)\b.*\b(excavat\w*|carv\w*|digging)\b/
const PLAN = /\bexcavat\w* (plan|dry ?run|preview|check)\b|\b(plan|preview)\b.*\b(excavat\w*|carving|digging)\b/
const PAUSE = /\b(pause|stop|halt|hold off)\b.*\b(excavat\w*|digging|carving|dig)\b|\b(excavat\w*|digging|carving)\b.*\b(pause|stop|halt)\b/
const GO = /^(?:(?:ok|okay|alright|so|then|go|go ahead and)\s+)?(excavate|carve)\b|\b(resume|continue|start|begin|get started|do it|keep)\b.*\b(excavat\w*|carv\w*|digging|dig out)\b/
const isGo = (u, t) => GO.test(t) && !STATUS.test(t) && !PLAN.test(t) && !PAUSE.test(t)

function register(api) {
  const { scheduler, say, PRIORITY } = api
  const log = (m) => api.log('excavation', m)
  const furnaceCfg = readJson(path.join(__dirname, '..', 'furnace-config.json'), {})

  // input chests of the furnace stations (furnace-config.json), falling back to the copy in our config
  const fromFurnace = []
  for (const st of furnaceCfg.stations || []) for (const u of st.units || []) if (u.input) fromFurnace.push(u.input)
  const inputs = fromFurnace.length ? fromFurnace : baseConfig.inputChests
  // keep clear of the lava depots (defence in depth; they are outside the room box)
  const pad = 3
  const depotBoxes = (furnaceCfg.depots || []).map(d => ({ min: [d.box.min[0] - pad, d.box.min[1] - pad, d.box.min[2] - pad], max: [d.box.max[0] + pad, d.box.max[1] + pad, d.box.max[2] + pad] }))
  // optional overrides, merged over config.json: api.excavationConfig and brain/state/excavation-config.json (limits and pillar merge key by key)
  const over = { ...readJson(api.statePath('excavation-config.json'), {}), ...(api.excavationConfig || {}) }
  const config = { ...baseConfig, ...over, limits: { ...baseConfig.limits, ...(over.limits || {}) }, pillar: { ...baseConfig.pillar, ...(over.pillar || {}) },
    protectedBoxes: [...(baseConfig.protectedBoxes || []), ...(over.protectedBoxes || []), ...depotBoxes] }

  const file = api.statePath('excavation-state.json')
  const state = stateStore.load({ file, legacyFile: path.join(api.dir, 'exc-state.json'), log })
  const save = () => stateStore.save(file, state, api.now, log)
  if (state.importedFrom && !fs.existsSync(file)) save()      // first run: write our own copy of the imported progress

  const engine = createEngine({
    bot: api.bot, say, goals: api.goals, tryGoto: api.tryGoto, safehand: api.safehand, stopNav: api.stopNav,
    config, state, save, inputs, canSee: api.canSee, depositSmeltables: typeof api.depositSmeltables === 'function' ? api.depositSmeltables : null,
    getCrafting: () => api.crafting,
    craft: api.commands && typeof api.commands.dispatch === 'function' ? { dispatch: (text) => api.commands.dispatch(api.ownerName, text), busy: () => { try { const q = scheduler.status(); return !!((q.running && q.running.name === 'craft') || q.queue.some(t => t.name === 'craft')) } catch { return false } } } : null, now: api.now, log
  })

  function submit() {
    return scheduler.submit({
      name: 'excavation', key: 'excavation', priority: PRIORITY.EXCAVATE, onUserStop: 'park',
      abort: (reason) => engine.abort(reason), run: (ctx) => engine.run(ctx)
    })
  }

  // Walter's go. Starts from the saved progress (never from scratch), resumes a parked task, or queues a new one.
  function go() {
    const s = scheduler.status()
    if (s.running && s.running.name === 'excavation') return say('I am already digging. Say "excavation status" for progress or "pause excavation" to stop.')
    if (s.queue.some(t => t.name === 'excavation')) return say('The excavation is queued and starts as soon as nothing more important is running.')
    if (s.running) say(`OK, the excavation starts when I am done with ${s.running.name}. It yields to anything more important.`)
    if (!scheduler.resumeParked('excavation')) submit()
  }
  function pause() {
    const s = scheduler.status()
    const has = (s.running && s.running.name === 'excavation') || s.queue.some(t => t.name === 'excavation') || s.parked.some(t => t.name === 'excavation')
    if (!has) return say('The excavation is not running.')
    scheduler.cancel('excavation', 'user-stop')
    if (state.active) { state.active = false; state.pauseReason = 'stopped by Walter.'; save() }
    say('OK, pausing the excavation. Say "resume excavation" when you want it back.')
  }

  const commands = [
    { name: 'excavation-status', help: 'excavation status | how is the excavation going', risk: 'low', match: STATUS, run() { say(engine.statusLine().slice(0, 235)) } },
    { name: 'excavation-plan', help: 'excavation plan', risk: 'low', match: PLAN, run() { say(engine.describePlan().slice(0, 235)) } },
    { name: 'excavation-pause', help: 'pause excavation | stop digging', risk: 'low', match: PAUSE, run: pause },
    { name: 'excavation-go', help: 'excavate | resume excavation | continue the excavation', risk: 'high', match: isGo, run: go }
  ]
  for (const c of commands) { try { api.commands.add(c) } catch (e) { log(`command ${c.name} not added: ${e.message}`) } }

  // keep our saved flag honest when the scheduler parks/cancels the task without running our abort hook (e.g. it was still queued)
  const stopped = (t) => { if (t && t.key === 'excavation' && state.active) { state.active = false; state.pauseReason = state.pauseReason || 'stopped by Walter.'; save() } }
  const subs = [['parked', stopped], ['ended', stopped]]
  if (typeof scheduler.on === 'function') for (const [ev, fn] of subs) scheduler.on(ev, fn)

  return {
    name: 'excavation',
    provides: ['excavation'],          // INTERFACE.md section 9: replaces the built-in adapter around the legacy excavate.js
    start() {
      if (state.active && !state.finished && baseConfig.autoResumeOnStart) { log('Walter had the excavation running; continuing it after the restart'); submit() }
    },
    stop() { if (typeof scheduler.off === 'function') for (const [ev, fn] of subs) scheduler.off(ev, fn) },
    status: () => engine.snapshot(),
    engine, state, go, pause
  }
}
register.meta = require('./meta.json')

module.exports = register
module.exports.meta = register.meta
module.exports.phrases = { STATUS, PLAN, PAUSE, GO, isGo }
