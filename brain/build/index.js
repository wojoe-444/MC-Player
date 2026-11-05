// brain/build: Walter's personal lookout tower (stone bricks + spruce) as a scheduler module. See README.md and brain/INTERFACE.md.
// Never starts building on its own: the job only exists after Walter says "build tower" / "build site <x> <z>" / "resume building"
// (or after a restart while his go was still in effect, i.e. it was running and had not been stopped or paused).
const fs = require('fs')
const stateStore = require('./state')
const createEngine = require('./engine')
const surveyMod = require('./survey')
const blueprint = require('./blueprint')
const baseConfig = require('./config.json')

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch { return fallback } }

// Chat phrases (tested against the lowercased, filler-stripped text). Building needs the words tower / building plus build / start / resume,
// and a plain request at the start of the line: a question or a remark about somebody else's tower never starts anything.
const LEAD = "(?:(?:ok|okay|alright|so|then|well|ozogo|lets|let's|let us|go|you can|you may|you should|i want you to|i would like you to|time to)\\s+)*"
const DET = '(?:the|my|a|an|your|our|that|this)?\\s*(?:own\\s+|new\\s+|personal\\s+|little\\s+|small\\s+|lookout\\s+|stone\\s+)*'
const SITE = new RegExp(`^${LEAD}build\\s+(?:${DET}tower\\s+)?(?:site|at|around)\\s+(-?\\d+)[\\s,]+(-?\\d+)`)
const SURVEY = /^(?:build(?:ing)?|tower)\s+(?:site\s+)?survey\b|\bsurvey\b.*\b(?:tower|building)\b|\bwhere (?:would|could|can|should) (?:you|we|i) build (?:the|a|my) tower\b/
const STATUS = /\b(?:build(?:ing)?|tower)\b.*\b(?:status|progress|going|how far|far along)\b|\b(?:status|progress|how is|how's|how far)\b.*\b(?:tower|building)\b/
const PAUSE = /\b(?:pause|stop|halt|hold off)\b.*\b(?:building|tower|build)\b|\b(?:don'?t|do not|never)\s+(?:build|start|continue)\b.*\btower\b/
const RESUME = new RegExp(`^${LEAD}(?:resume|continue|carry on|keep going|keep)\\s+(?:with\\s+|on\\s+)?(?:${DET})?(?:building|build|tower)\\b`)
const GO = new RegExp(`^${LEAD}(?:(?:start|begin|get started)\\s+(?:on\\s+|with\\s+)?building|build|make|construct|start|begin)\\s+(?:me\\s+|us\\s+|up\\s+)?${DET}tower\\b`)
const asking = (t) => /\?/.test(t) || /^(?:should|would|do|did|does|is|are|was|how|what|why|when|where|who|which|if|maybe|someday|someone|somebody|walter|he|she|they)\b/.test(t)
const isGo = (u, t) => GO.test(t) && !asking(t) && !SITE.test(t) && !SURVEY.test(t) && !STATUS.test(t) && !PAUSE.test(t)
const isResume = (u, t) => RESUME.test(t) && !asking(t) && !STATUS.test(t) && !PAUSE.test(t)
const isPause = (u, t) => PAUSE.test(t) && !GO.test(t) && !/\b(?:resume|continue)\b/.test(t)
const isStatus = (u, t) => STATUS.test(t) && !GO.test(t) && !RESUME.test(t) && !PAUSE.test(t) && !SURVEY.test(t)
const isSite = (u, t) => SITE.test(t) && !asking(t)

function register(api) {
  const { bot, scheduler, say, PRIORITY } = api
  const log = (m) => api.log('build', m)
  const over = { ...readJson(api.statePath('build-config.json'), {}), ...(api.buildConfig || {}) }
  const config = {
    ...baseConfig, ...over,
    site: { ...baseConfig.site, ...(over.site || {}) }, limits: { ...baseConfig.limits, ...(over.limits || {}) }, timing: { ...baseConfig.timing, ...(over.timing || {}) },
    protect: [...(baseConfig.protect || []), ...(over.protect || [])]
  }
  const file = api.statePath('build-state.json')
  const state = stateStore.load({ file, log })
  const save = () => stateStore.save(file, state, api.now, log)

  const engine = createEngine({
    bot, say, goals: api.goals, tryGoto: api.tryGoto, safehand: api.safehand, stopNav: api.stopNav, config, state, save,
    canSee: typeof api.canSee === 'function' ? api.canSee : null, ensureLineOfSight: typeof api.ensureLineOfSight === 'function' ? api.ensureLineOfSight : null,
    now: api.now, log
  })

  function submit(extra = {}) {
    return scheduler.submit({
      name: 'build', key: 'build', priority: (PRIORITY && PRIORITY.OUTING) || 45, onUserStop: 'park', state: { ...extra },
      abort: (reason) => engine.abort(reason), run: (ctx) => engine.run(ctx)
    })
  }
  const surveyNow = (c) => surveyMod.survey(bot, { center: c, radius: config.site.radius, maxDy: config.site.maxDy, yRange: config.site.yRange, protect: config.protect, y: Math.round(bot.entity.position.y) })
  const centreOf = () => state.centre || { x: config.site.x, z: config.site.z }
  const where = (s) => `${s.ox}, ${s.oy}, ${s.oz}`

  // Safety gate (Walter, after the bot died building at night): the site is outdoors, so never start or resume at night, below 18 health, or with a hostile close.
  const HOSTILE = /^(zombie|skeleton|creeper|spider|cave_spider|husk|drowned|witch|pillager|vindicator|phantom|slime|stray|bogged|breeze|zombie_villager|enderman)$/
  function unsafeNow() {
    const tod = bot.time && bot.time.timeOfDay
    if (typeof tod === 'number' && tod >= 12542 && tod < 23460) return 'it is night'
    if (bot.health < 18) return `my health is ${Math.round(bot.health)}/20`
    const m = bot.nearestEntity && bot.nearestEntity(e => HOSTILE.test(e.name || '') && e.position.distanceTo(bot.entity.position) < 16)
    if (m) return `a ${m.name} is close`
    return null
  }
  // Walter's go. Starts from the saved site/progress (never from scratch), resumes a parked task, or queues a new one.
  function go(newCentre = null) {
    const s = scheduler.status()
    if (s.running && s.running.name === 'build') return say('I am already building. Say "build status" for progress.')
    if (state.finished) return say(`My tower is already built at ${where(state.site)}.`)
    if (s.queue.some(t => t.name === 'build')) return say('The tower is queued and starts as soon as nothing more important is running.')
    if (newCentre) {
      if (state.site && (state.blocks > 0 || state.placed.length)) return say(`I already started a tower at ${where(state.site)}; I finish that one first.`)
      state.site = null; state.centre = newCentre; state.placed = []; state.skipped = {}; state.pillar = state.pillar && state.pillar.cells.length ? state.pillar : null; engine.resync()
    }
    if (!state.site) {
      const r = surveyNow(centreOf())
      if (r.site) { state.site = r.site; state.centre = centreOf(); state.placed = []; engine.resync() }
      else if (!(r.counts.unloaded && r.counts.unloaded >= r.scanned / 2)) { say(`Tower: ${r.reason}.`.slice(0, 230)); return }
      else state.centre = centreOf()                                      // not loaded from here: the job walks there and looks again
    }
    // With the scheduler's outdoor gate present the task is queued and HELD until it is safe (so a restart or an unsafe moment never drops Walter's go);
    // without it (old scheduler, tests) the module refuses on its own.
    const why = scheduler.gate ? null : unsafeNow()
    if (why) { state.active = false; state.pauseReason = `not now: ${why}`; save(); return say(`Not starting the tower now: ${why}. Say "resume building" in daylight when I am healthy.`.slice(0, 230)) }
    state.active = true; state.pauseReason = null; save()
    if (s.running) say(`OK, the tower starts when I am done with ${s.running.name}. It yields to anything more important.`)
    if (!scheduler.resumeParked('build')) submit()
  }
  function resume() {
    const s = scheduler.status()
    const has = (s.running && s.running.name === 'build') || s.queue.some(t => t.name === 'build') || s.parked.some(t => t.name === 'build')
    if (!state.site && !has) return say('There is no tower under way. Say "build tower" to start one.')
    go()
  }
  function pause() {
    const s = scheduler.status()
    const has = (s.running && s.running.name === 'build') || s.queue.some(t => t.name === 'build') || s.parked.some(t => t.name === 'build')
    if (!has) return say('I am not building.')
    scheduler.cancel('build', 'user-stop')
    if (state.active) { state.active = false; state.pauseReason = 'stopped by Walter.'; save() }
    say('OK, pausing the tower. Say "resume building" when you want it back.')
  }
  function surveyOnly() {
    if (state.site) return say(`My tower site is ${where(state.site)} (${state.finished ? 'built' : 'in progress'}).`)
    const r = surveyNow(centreOf())
    if (r.site) say(`Best tower site: ${where(r.site)} (${r.site.flat ? 'slope ' + r.site.flat : 'flat'}, ${r.site.dist} blocks from the centre).`)
    else say(`Tower: ${r.reason}.`.slice(0, 230))
  }

  const commands = [
    { name: 'build-survey', help: 'build survey', risk: 'low', match: SURVEY, run: surveyOnly },
    { name: 'build-status', help: 'build status | how is the tower going', risk: 'low', match: isStatus, run() { say(engine.statusLine().slice(0, 235)) } },
    { name: 'build-pause', help: 'pause building | stop building', risk: 'low', match: isPause, run: pause },
    { name: 'build-resume', help: 'resume building | continue the tower', risk: 'high', match: isResume, run: resume },
    { name: 'build-site', help: 'build site <x> <z>', risk: 'high', match: isSite, run(user, text) { const m = SITE.exec(text); go({ x: +m[1], z: +m[2] }) } },
    { name: 'build-tower', help: 'build tower | build my tower | start the tower', risk: 'high', match: isGo, run: () => go() }
  ]
  for (const c of commands) { try { api.commands.add(c) } catch (e) { log(`command ${c.name} not added: ${e.message}`) } }

  // keep our saved flag honest when the scheduler parks/cancels the task without running our abort hook (e.g. it was still queued)
  const stopped = (t) => { if (t && t.key === 'build' && state.active) { state.active = false; state.pauseReason = state.pauseReason || 'stopped by Walter.'; save() } }
  const subs = [['parked', stopped], ['ended', stopped]]
  if (typeof scheduler.on === 'function') for (const [ev, fn] of subs) scheduler.on(ev, fn)

  return {
    name: 'build',
    start() {
      // a pillar left in the world by a crash is taken down again even without a go (only our own recorded cobblestone; nothing is built)
      if (state.site && state.pillar && state.pillar.cells && state.pillar.cells.length) { log('pillar left from an earlier run; coming down'); submit({ cleanup: !(state.active && config.autoResumeOnStart) }); return }
      if (state.active && !state.finished && state.site && config.autoResumeOnStart) { log('Walter had the tower running; continuing it after the restart'); submit() }
    },
    stop() { if (typeof scheduler.off === 'function') for (const [ev, fn] of subs) scheduler.off(ev, fn) },
    status: () => engine.snapshot(),
    needs: () => engine.missing(),
    engine, state, go, pause, resume
  }
}
register.meta = require('./meta.json')

module.exports = register
module.exports.meta = register.meta
module.exports.phrases = { SITE, SURVEY, STATUS, PAUSE, RESUME, GO, isGo, isResume, isPause, isStatus, isSite }
module.exports.blueprint = blueprint
