// brain/mode: the bot's two modes (Walter 2026-11-01).
//   task        : does what it is told (chat tasks) and runs its routines when idle (farm, sleep, furnace upkeep, lighting). No self-chosen goals, the autopilot is parked.
//   autonomous  : the autopilot plays on its own goals (progress, gear, exploring) and the free-time "whimsy" slot is the bot's own.
// Chat: "mode" (status), "task mode" / "mode task", "autonomous mode" / "mode autonomous". File: brain/state/mode.json. Env BOT_MODE sets the start mode.
const fs = require('fs')

const SWITCH = /^\W*(?:(?:switch|go|change|set)\s+(?:to\s+|into\s+)?|back to\s+)?(?:the\s+)?(task|routine|autonomous|auto|free)(?:\s+and\s+routine)?\s*(?:mode)?\W*$|^\W*mode\s*[:=]?\s*(task|routine|autonomous|auto|free)?\W*$/i

module.exports = function register(api) {
  const { bot, scheduler } = api
  const file = api.statePath('mode.json')
  const log = (m) => api.log('mode', m)
  let state = { mode: process.env.BOT_MODE === 'autonomous' ? 'autonomous' : 'task', since: Date.now() }
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); if (s && (s.mode === 'task' || s.mode === 'autonomous') && !process.env.BOT_MODE) state = s } catch {}
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(state)) } catch {} }
  const ap = () => bot._ap

  // in task mode ap.enabled is pinned to false (the watchdog 'kick' and idle repairs would otherwise switch the autopilot back on and preempt the task)
  function pin(a, on) {
    try {
      if (on) Object.defineProperty(a, 'enabled', { get: () => false, set: () => {}, configurable: true, enumerable: true })
      else Object.defineProperty(a, 'enabled', { value: true, writable: true, configurable: true, enumerable: true })
    } catch {}
  }
  function apply() {
    const a = ap()
    if (state.mode === 'task') {
      if (a) { pin(a, true); a.keepTaskOff = false; try { a.S && a.S.stopMoving() } catch {} }
      try { scheduler.cancel('autopilot', 'mode: task') } catch {}
    } else if (a) {
      pin(a, false)
      a.enabled = true
      try { a.ensureTask() } catch {}
    }
  }
  function set(mode, why) {
    if (state.mode === mode) return false
    state = { mode, since: Date.now(), why }
    save(); apply(); log(`mode -> ${mode} (${why || 'chat'})`)
    return true
  }
  // the autopilot can re-register itself after a reload; keep the mode honest
  const guard = setInterval(() => { try { const a = ap(); if (!a) return; try { const f = JSON.parse(fs.readFileSync(file, 'utf8')); if (f && (f.mode === 'task' || f.mode === 'autonomous') && f.mode !== state.mode) { state = f; log('mode -> ' + f.mode + ' (file)'); apply() } } catch {} if (state.mode === 'task' && a.enabled) apply(); else if (state.mode === 'autonomous' && !a.enabled) apply() } catch {} }, 5000)
  if (guard.unref) guard.unref()

  const say = (t) => { try { api.say(t) } catch {} }
  const describe = () => state.mode === 'task'
    ? 'Task mode: I do what you ask in chat and run my routines when idle (farm, sleep, furnace, lighting). No goals of my own. Say "autonomous mode" to hand me the wheel.'
    : 'Autonomous mode: I play on my own goals (gear, mining, exploring) and keep my free time. Say "task mode" for tasks and routines only.'
  try {
    api.commands.add({
      name: 'mode', help: 'mode | task mode | autonomous mode', risk: 'low',
      match: (t) => SWITCH.test(String(t || '').trim()),
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
module.exports.meta = { name: 'mode', version: 1 }
module.exports.phrases = { SWITCH }
