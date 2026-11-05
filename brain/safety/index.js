// brain/safety: mob safety module (see README.md and brain/INTERFACE.md).
const fs = require('fs')
const runtime = require('./runtime')
const { assess, compass, Tracker, DEFAULTS } = require('./assess')
const { PROFILES } = require('./profiles')
const health = require('./health')

const NO_FIGHT = /\b(do not|dont|don't|no|never|stop|not)\b.*\b(fight|fighting|attack|attacking|kill)\b|\b(no fighting|run away|just retreat|only retreat|avoid (the )?(mobs|monsters)|stand down)\b/
const FIGHT = /\b(you can fight|fight back|fight if you (have to|need to)|defend (yourself|me)|self defen[cs]e|you can attack|attack (the )?(mobs|monsters|zombies)|kill (the )?(mobs|monsters|zombies))\b/
const STATUS = /\b(mob|safety|threat|danger)s? status\b|\bany (mobs|monsters|zombies|creepers)\b/

// safety.log: path-filter suppressions and creeper decisions, so Walter can check the heuristics. Capped at ~200 KB (keeps the tail).
function makeSlog(file, now) {
  const fs = require('fs')
  return (msg) => {
    try {
      try { if (fs.statSync(file).size > 200000) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(-100000)) } catch { /* no file yet */ }
      fs.appendFileSync(file, `${new Date(now()).toISOString()} ${msg}
`)
    } catch { /* logging must never break the bot */ }
  }
}

// Night rule (post-mortem of the 03:51 death): when it is night and the bot stands under open sky with a shelter known, walk there and stay
// out of the dark. The outdoor gate in the scheduler keeps build/mining/treefarm from starting; this moves the bot itself. Walter's own orders
// win: it stays quiet for 2 minutes after any chat from him and while "go anyway" is active.
function nightRoutine(api, rt, state) {
  const sched = api.scheduler
  if (!sched || typeof sched.routine !== 'function') return
  // Once the bot has slept (or got up because the night did not skip), the night is over for this routine: no shelter walk until the next
  // dusk. A night is identified by the world day number (the whole night, 12542-23460, lies inside one day). Remembered across restarts.
  const dayOf = (b) => (b.time ? (b.time.day != null ? b.time.day : Math.floor((b.time.age || 0) / 24000)) : null)
  const file = api.statePath ? api.statePath('night-shelter.json') : null
  try { if (file) state.sleptDay = JSON.parse(fs.readFileSync(file, 'utf8')).sleptDay } catch { /* first run */ }
  const markSlept = () => {
    const d = dayOf(api.bot); if (d == null) return
    state.sleptDay = d
    if (file) try { fs.writeFileSync(file, JSON.stringify({ sleptDay: d })) } catch { /* ignore */ }
  }
  api.bot.on('sleep', markSlept); api.bot.on('wake', markSlept)
  state.off = () => { api.bot.removeListener('sleep', markSlept); api.bot.removeListener('wake', markSlept) }
  sched.routine({
    name: 'night-shelter', priority: 60, intervalMs: 10000, defaultEnabled: true,
    due() {
      const b = api.bot, t = (api.now || Date.now)()
      if (!b.entity || b.isSleeping || t < state.cooldownUntil) return false
      if (state.sleptDay != null && dayOf(b) === state.sleptDay) return false     // already slept this night
      if (sched.gateOverrideUntil && t < sched.gateOverrideUntil) return false
      if (t - (sched.lastChatAt || 0) < 120000) return false
      const e = rt.environment()
      return !!(e.night && e.outdoors && e.shelter && e.shelter.dist > 8)
    },
    make() {
      return {
        name: 'night-shelter', onUserStop: 'cancel',
        async run(ctx) {
          const e = rt.environment(), sh = e.shelter
          if (!sh) return { status: 'done' }
          state.cooldownUntil = (api.now || Date.now)() + 5 * 60000
          api.say(`It's night and I'm out in the open. Heading to ${sh.name}.`)
          api.log('safety', `night: walking to ${sh.name} (${Math.round(sh.dist)} blocks)`)
          try { await api.safehand.ensureSafeForMove() } catch { return { status: 'done' } }
          await api.gotoNear({ pos: sh.pos, radius: 2, label: 'shelter', ctx, ms: 90000 })
          return { status: 'done' }
        }
      }
    }
  })
}

// Prep before descent as a hard reflex (17:18 death, third in the mine): right before a task that goes underground starts, make sure sword, pickaxe,
// torches and food are in the bag (equip armor, ask crafting for what can be crafted). If a must-have is still missing the task sits out 45 s and tries the prep again.
// After GUARD_GIVE_UP failed rounds it goes anyway (no deadlock, no questions to Walter) but says what is missing; the retreat reflex is then 12 health, not 10.
const GUARD_TASKS = new Set(['mining'])
const GUARD_MUST = ['sword', 'pickaxe', 'torches', 'food']
const GUARD_GIVE_UP = 4
function installDescentGuard(api, rt) {
  const sched = api.scheduler
  if (!sched || typeof sched.addPreStart !== 'function') return false
  const told = new Map()
  const tell = (key, text) => { const t = (api.now || Date.now)(); if (t - (told.get(key) || 0) > 5 * 60000) { told.set(key, t); api.say(text.slice(0, 220)) } }
  sched.addPreStart({
    applies: (task) => GUARD_TASKS.has(task.name),
    async run(ctx, task) {
      if (task.guardDef) task.def = task.guardDef                       // undo the stub from the last round
      const r = await rt.loadout.ensure('cave', { ctx })
      const hard = r.missing.filter(m => GUARD_MUST.includes(m.what))
      task.guardTries = hard.length ? (task.guardTries || 0) + 1 : 0
      if (hard.length && task.guardTries < GUARD_GIVE_UP) {
        tell('block:' + task.name, `Not going down yet: need ${hard.map(m => `${m.what} ${m.have}/${m.need}`).join(', ')}. Getting ready first.`)
        api.log('safety', `descent guard: holding ${task.name} (${hard.map(m => m.what).join(', ')} missing), round ${task.guardTries}`)
        task.guardDef = task.guardDef || task.def
        task.def = { ...task.def, run: async () => ({ status: 'retry', afterMs: 45000 }) }
        return
      }
      if (r.missing.length) tell('go:' + task.name, `Going down short of ${r.missing.map(m => `${m.what} ${m.have}/${m.need}`).join(', ')}; I will turn back sooner (12 health).`)
    }
  })
  return true
}

function register(api) {
  const rt = runtime({
    bot: api.bot, say: api.say, goals: api.goals, scheduler: api.scheduler, PRIORITY: api.PRIORITY, safehand: api.safehand,
    stopNav: api.stopNav, canSee: typeof api.canSee === 'function' ? api.canSee : null, ownerName: api.ownerName, stateFile: api.statePath('safety-state.json'), now: api.now,
    waypointsFile: api.dir ? require('path').join(api.dir, 'waypoints.json') : null,
    lessonsFile: api.statePath('lessons.md'), tuningFile: api.statePath('safety-tuning.json'), commands: api.commands,
    log: (m) => api.log('safety', m), slog: makeSlog(api.statePath('safety.log'), api.now || Date.now)
  })
  const cmds = [
    { name: 'no-fight', help: 'do not fight | just retreat | run away', risk: 'low', match: (u, t) => NO_FIGHT.test(t),
      run() { rt.setMode('warn'); api.say('OK, I will back away from mobs and warn you instead of fighting.') } },
    { name: 'fight-mode', help: 'you can fight | fight back | defend yourself', risk: 'high', match: (u, t) => FIGHT.test(t) && !NO_FIGHT.test(t),
      run() { rt.setMode('fight'); api.say('OK, I will fight back with my sword when mobs get close.') } },
    { name: 'creeper-strike-on', help: 'hit creepers and back off | you can melee creepers', risk: 'high', match: (u, t) => /\b(hit creepers? and (back off|retreat|run)|melee (the )?creepers?|fight creepers? with (the |your )?sword)\b/.test(t) && !NO_FIGHT.test(t),
      run() { rt.setCreeperStrike(true); api.say('OK, I will hit creepers with my sword and back off right after (fight mode only).') } },
    { name: 'creeper-strike-off', help: 'do not melee creepers | only run from creepers', risk: 'low', match: (u, t) => /\b(do not|dont|don't|never|stop|no) (hit|melee|fight|attack) (the )?creepers?\b|\b(only|just) (run|flee|retreat) from creepers?\b/.test(t),
      run() { rt.setCreeperStrike(false); api.say('OK, I will only run from creepers (and shoot them if I get a bow).') } },
    { name: 'entomb-on', help: 'you can wall yourself in when hurt | emergency shelter on', risk: 'high',
      match: (u, t) => /\b(wall|seal|entomb|block|cobble) (yourself|your self) in\b|\bemergency (shelter|walls?) on\b|\bdig in when (you are )?hurt\b/.test(t) && !/\b(do not|dont|don't|never|stop|no)\b/.test(t),
      run() { rt.setEmergencyEntomb(true); api.say('OK. If I am badly hurt with mobs close and no safe way to shelter, I will wall myself in with cobblestone, heal, then dig out through my own blocks.') } },
    { name: 'entomb-off', help: 'do not wall yourself in | emergency shelter off', risk: 'low',
      match: (u, t) => /\b(do not|dont|don't|never|stop|no) (wall|seal|entomb|block|cobble) (yourself|your self) in\b|\bemergency (shelter|walls?) off\b/.test(t),
      run() { rt.setEmergencyEntomb(false); api.say('OK, I will not place blocks to wall myself in.') } },
    { name: 'loadout-check', help: 'check my gear | am i ready', risk: 'low',
      match: /\b(check|show|what is|whats|what's) (my |the )?(gear|loadout|kit)\b|\bam i (ready|packed)\b|\bloadout\b/,
      run() { api.say(rt.loadout.describe(rt.loadout.check('cave'))) } },
    { name: 'pack-up', help: 'pack up | get ready for a trip | gear up', risk: 'high',
      match: /\b(pack up|gear up)\b|\b(get ready|prepare|get geared up) for (a |the )?(trip|mine|mining|caves?|exploring|expedition)\b/,
      run() {
        api.scheduler.submit({ name: 'preflight', priority: api.PRIORITY.CHAT, onUserStop: 'cancel', async run(ctx) {
          const r = await rt.loadout.ensure('cave', { ctx })
          api.say(r.ok ? 'Packed: torches, cobble, food, sword and armor are in order.' : `Packed what I could${r.fixed.length ? ` (${r.fixed.join(', ')})` : ''}. Still missing: ${r.missing.map(m => `${m.what} ${m.have}/${m.need}`).join(', ')}.`)
          return { status: 'done' }
        } })
      } },
    { name: 'lessons', help: 'what did you learn | show your lessons', risk: 'low',
      match: /\bwhat did you learn\b|\b(show|read) (me )?(your )?lessons\b|\bwhy did you die\b/,
      run() {
        const d = rt.deaths.tuning().deaths, last = d[d.length - 1]
        api.say(last ? `Last death: ${last.cause}${last.by ? ' (' + last.by + ')' : ''} at ${last.pos}. More in lessons.md.`.slice(0, 220) : 'No deaths logged yet.')
      } },
    { name: 'mob-status', help: 'mob status | any mobs near', risk: 'low', match: STATUS,
      run() {
        const s = rt.status()
        const near = s.threats.length ? s.threats.map(m => `${m.name} ${m.dist}`).join(', ') : 'no hostiles close'
        api.say(`Mode ${s.mode}, creeper melee ${s.creeperStrike ? 'on' : 'off'}, wall-in ${s.emergencyEntomb ? 'on' : 'off'}, health ${Math.round(s.health)}/20. ${near}.`)
      } }
  ]
  for (const c of cmds) { try { api.commands.add(c) } catch (e) { api.log('safety', 'command ' + c.name + ' not added: ' + e.message) } }
  const nightState = { cooldownUntil: 0 }
  try { nightRoutine(api, rt, nightState) } catch (e) { api.log('safety', 'night routine not registered: ' + e.message) }
  function start() {
    rt.start()
    try { installDescentGuard(api, rt) } catch (e) { api.log('safety', 'descent guard not installed: ' + e.message) }
    // the farm routine works outdoors too: hold it at night like build/mining/treefarm (the gate lets it back in at daylight)
    try { const g = api.scheduler && api.scheduler.gate; if (g && g.names && typeof g.names.add === 'function') g.names.add('farm') } catch { /* no gate */ }
  }
  const stop = () => { rt.stop(); if (nightState.off) nightState.off() }
  // for the pilot / other modules: api.safety.preflight('cave'), api.safety.lightHere(), api.safety.lessons()
  api.safety = {
    preflight: (kind = 'cave', opts = {}) => rt.loadout.ensure(kind, opts), loadout: rt.loadout, lightHere: (o) => rt.light.lightHere(o),
    lessons: () => rt.deaths.tuning(), standGround: (ms) => rt.standGround(ms), status: rt.status
  }
  return { name: 'safety', start, stop, status: rt.status, rt }
}
register.meta = { name: 'safety', version: 1 }

module.exports = register
module.exports.meta = register.meta
module.exports.install = runtime
module.exports.assess = assess
module.exports.compass = compass
module.exports.Tracker = Tracker
module.exports.DEFAULTS = DEFAULTS
module.exports.PROFILES = PROFILES
module.exports.health = health
