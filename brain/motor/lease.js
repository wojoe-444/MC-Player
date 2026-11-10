// Body lease, first stage: WATCH who presses the movement keys (docs/HILLCLIMB-INSIGHTS.md, "One owner for the body").
// 73 direct setControlState calls and 51 timers mean two loops can fight over jump, sneak or a direction. Before gating key presses behind a token, this finds
// out WHICH loops fight: every change of a control state is attributed to its repo call site, and when a different call site flips the same control back within
// fightMs, three times running, that pair is recorded as a fight { control, a, b, count, last }. brain/state/lease-log.json lists them; read it with
// `node tools/lease-report.js`. The key press itself is never changed here. Enforcement (drop a press made without the current token) comes after the list exists.
'use strict'
const fs = require('fs')
const path = require('path')
const { callSites } = require('../gate')

function install(bot, opts = {}) {
  if (bot._lease && bot._lease.v === 1) return bot._lease
  const now = opts.now || Date.now, fightMs = opts.fightMs ?? 300, need = opts.need ?? 3
  const root = opts.root || path.join(__dirname, '..', '..')
  const file = opts.logFile === undefined ? path.join(opts.stateDir || path.join(__dirname, '..', 'state'), 'lease-log.json') : opts.logFile
  const log = opts.log || (() => {})
  const last = {}                                           // control -> { site, value, t }
  const run = {}                                            // "control|a|b" -> consecutive flips between two sites
  const fights = {}                                         // key -> { control, a, b, count, last }
  const stats = { since: now(), v: 1, changes: 0, fights }
  let dirty = false, timer = null
  const save = () => { dirty = false; if (!file) return; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ...stats, savedAt: now() }, null, 1)) } catch { /* a nicety */ } }
  const schedule = () => { if (timer || !file) return; timer = setTimeout(() => { timer = null; if (dirty) save() }, 5000); if (timer.unref) timer.unref() }

  const orig = bot.setControlState
  function watched(control, value) {
    try {
      const prev = last[control]
      if (!prev || prev.value !== !!value) {                // only a change of state is an act; repeating the same value is nothing
        const site = callSites(new Error().stack, root).find(s => !s.startsWith('brain/motor/lease.js')) || '(no repo frame)', t = now()
        stats.changes++
        if (prev && prev.site !== site && t - prev.t <= fightMs) {
          const [a, b] = [prev.site, site].sort(), key = `${control}|${a}|${b}`
          run[key] = (run[key] || 0) + 1
          if (run[key] >= need) {
            const f = fights[key] = fights[key] || { control, a, b, count: 0, last: 0 }
            f.count++; f.last = t; dirty = true; schedule()
            if (f.count === 1) log(`two loops fight over ${control}: ${a} and ${b}`)
          }
        } else if (prev && prev.site === site) { /* the same loop toggling its own key: not a fight */ }
        else for (const k of Object.keys(run)) if (k.startsWith(control + '|')) run[k] = 0
        last[control] = { site, value: !!value, t }
      }
    } catch { /* an observer never breaks a key press */ }
    return orig.apply(this, arguments)
  }
  bot.setControlState = watched
  const lease = {
    v: 1,
    fights: () => JSON.parse(JSON.stringify(fights)), changes: () => stats.changes, flush: save,
    uninstall() { if (bot.setControlState === watched) bot.setControlState = orig; if (timer) clearTimeout(timer); if (dirty) save(); delete bot._lease }
  }
  bot._lease = lease
  return lease
}

module.exports = { install }
