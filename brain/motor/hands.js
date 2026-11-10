// Hands, watch stage (docs/BUG-HUNT-2026-11-10.md finding 5; docs/HILLCLIMB-INSIGHTS.md "BodyLease applied to the hand first"). Five eaters, the hotbar sorter, the
// resync, the combat reflex and every job equip and unequip without a shared lock, so a job that holds saplings can find a sword in its hand a moment later.
// Before a lease that all of them must take, this finds out WHO swaps the hand under WHOM: every call of bot.equip / bot.unequip / bot.setQuickBarSlot is attributed to
// its repo call site, and when a different call site changes the held item within swapMs of the previous one (to a different item), that pair is recorded as a
// hand swap { a, b, count, items, last }. brain/state/hands-log.json lists them; `node tools/hands-report.js`. Nothing is blocked or changed here.
'use strict'
const fs = require('fs')
const path = require('path')
const { callSites } = require('../gate')

const WRAPPED = ['equip', 'unequip', 'setQuickBarSlot']

function install(bot, opts = {}) {
  if (bot._hands && bot._hands.v === 1) return bot._hands
  const now = opts.now || Date.now, swapMs = opts.swapMs ?? 2000
  const root = opts.root || path.join(__dirname, '..', '..')
  const file = opts.logFile === undefined ? path.join(opts.stateDir || path.join(__dirname, '..', 'state'), 'hands-log.json') : opts.logFile
  const log = opts.log || (() => {})
  const swaps = {}, stats = { since: now(), v: 1, calls: 0, byCaller: {}, swaps }
  let last = null, dirty = false, timer = null
  const save = () => { dirty = false; if (!file) return; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ...stats, savedAt: now() }, null, 1)) } catch { /* a nicety */ } }
  const schedule = () => { if (timer || !file) return; timer = setTimeout(() => { timer = null; if (dirty) save() }, 5000); if (timer.unref) timer.unref() }
  const heldName = () => (bot.heldItem ? bot.heldItem.name : null)

  const orig = {}
  for (const fn of WRAPPED) {
    if (typeof bot[fn] !== 'function') continue
    orig[fn] = bot[fn]
    bot[fn] = function watchedHands() {
      let site = null, before = null
      try { site = callSites(new Error().stack, root).find(s => !s.startsWith('brain/motor/hands.js')) || '(no repo frame)'; before = heldName(); stats.calls++; stats.byCaller[site] = (stats.byCaller[site] || 0) + 1 } catch { /* observer */ }
      const res = orig[fn].apply(this, arguments)
      const after = () => {
        try {
          const to = heldName(), t = now()
          if (to === before) return
          if (last && last.site !== site && t - last.t <= swapMs && last.to !== to) {
            const [a, b] = [last.site, site].sort(), key = `${a}|${b}`
            const s = swaps[key] = swaps[key] || { a, b, count: 0, items: {}, last: 0 }
            s.count++; s.last = t; const it = `${last.to || 'nothing'} -> ${to || 'nothing'}`; s.items[it] = (s.items[it] || 0) + 1
            dirty = true; schedule(); if (s.count === 1) log(`hand swap: ${a} and ${b} (${it})`)
          }
          last = { site, to, t }
        } catch { /* observer */ }
      }
      if (res && typeof res.then === 'function') return res.then((v) => { after(); return v }, (e) => { after(); throw e })
      after(); return res
    }
  }
  const hands = {
    v: 1, swaps: () => JSON.parse(JSON.stringify(swaps)), calls: () => stats.calls, flush: save,
    uninstall() { for (const [fn, f] of Object.entries(orig)) if (bot[fn] !== f) bot[fn] = f; if (timer) clearTimeout(timer); if (dirty) save(); delete bot._hands }
  }
  bot._hands = hands
  return hands
}

module.exports = { install }
