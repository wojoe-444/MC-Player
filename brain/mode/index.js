// brain/mode: the bot's two modes (Walter 2026-11-01).
//   task        : does what it is told (chat tasks) and runs its routines when idle (farm, sleep, furnace upkeep, lighting). No self-chosen goals, the autopilot is parked.
//   autonomous  : the autopilot plays on its own goals (progress, gear, exploring) and the free-time "whimsy" slot is the bot's own.
// Chat: "mode" (status), "task mode" / "mode task", "autonomous mode" / "mode autonomous". Stored as "stance" in the bot profile (profile.json; mode.json when there is no profile). Env BOT_MODE sets the start mode.

const SWITCH = /^\W*(?:(?:switch|go|change|set)\s+(?:to\s+|into\s+)?|back to\s+)?(?:the\s+)?(task|routine|autonomous|auto|free)(?:\s+and\s+routine)?\s*(?:mode)?\W*$|^\W*mode\s*[:=]?\s*(task|routine|autonomous|auto|free)?\W*$/i

module.exports = function register(api) {
  const { bot, scheduler } = api
  const profile = api.profile
  const log = (m) => api.log('mode', m)
  // the stance lives in the bot profile (profile.json, falling back to mode.json); env BOT_MODE still wins at start
  let lastFile = profile.get().stance
  let state = process.env.BOT_MODE ? { mode: process.env.BOT_MODE === 'autonomous' ? 'autonomous' : 'task', since: Date.now(), why: 'env BOT_MODE' } : { mode: lastFile, since: profile.get().stanceSince || Date.now() }
  const save = () => { profile.setStance(state.mode, state.why) }
  const ap = () => bot._ap

  // The gate is what the autopilot asks ("may I play my own goals?"); nothing here touches ap.enabled's definition any more, so the watchdog kick
  // and chat "autopilot on" can set ap.enabled freely: in task stance ap.active() is still false.
  const gate = () => state.mode === 'autonomous'
  function apply() {
    const a = ap()
    if (a) a.gate = gate
    if (state.mode === 'task') {
      if (a) { a.keepTaskOff = false; try { a.S && a.S.stopMoving() } catch {} }
      try { scheduler.cancel('autopilot', 'mode: task') } catch {}
    } else if (a) {
      a.enabled = true
      try { a.ensureTask() } catch {}
    }
  }
  function set(mode, why) {
    if (state.mode === mode) return false
    state = { mode, since: Date.now(), why }
    save(); lastFile = mode; apply(); log(`mode -> ${mode} (${why || 'chat'})`)
    return true
  }
  // the autopilot can re-register itself after a reload (new ap object, no gate); someone may also edit profile.json / mode.json: keep the stance honest
  const guard = setInterval(() => {
    try {
      const a = ap(); if (!a) return
      profile.invalidate()
      const f = profile.get().stance
      if (f !== lastFile) { lastFile = f; if (f !== state.mode) { state = { mode: f, since: Date.now(), why: 'file' }; log('mode -> ' + f + ' (file)'); apply() } }
      else if (a.gate !== gate) apply()
      else if (state.mode === 'task' && a.active && a.active()) apply()
    } catch {}
  }, 5000)
  if (guard.unref) guard.unref()

  const say = (t) => { try { api.say(t) } catch {} }
  const describe = () => state.mode === 'task'
    ? 'Task mode: I do what you ask in chat and run my routines when idle (farm, sleep, furnace, lighting). No goals of my own. Say "autonomous mode" to hand me the wheel.'
    : 'Autonomous mode: I play on my own goals (gear, mining, exploring) and keep my free time. Say "task mode" for tasks and routines only.'
  try {
    api.commands.add({
      name: 'mode', help: 'mode | task mode | autonomous mode', risk: 'low',
      match: (u, t) => SWITCH.test(String(t || '').trim()),
      run(user, text) {
        const m = SWITCH.exec(String(text || '').trim()), w = String((m && (m[1] || m[2])) || '').toLowerCase()
        if (!w) return say(describe())
        const mode = /^(task|routine)$/.test(w) ? 'task' : 'autonomous'
        say(set(mode, 'chat from ' + user) ? describe() : 'Already in ' + mode + ' mode.')
      }
    })
  } catch (e) { log('command not added: ' + e.message) }

  return {
    name: 'mode',
    start() { apply(); log('start in ' + state.mode + ' mode') },
    stop() { clearInterval(guard) },
    status: () => ({ ...state }),
    set, apply, get: () => state.mode
  }
}
module.exports.meta = require('./meta.json')
module.exports.phrases = { SWITCH }
