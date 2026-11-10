// Persistent state for brain/husbandry (api.statePath('husbandry-state.json')): the pens and the lichen farms, with what was last seen and done.
const fs = require('fs')

const blank = () => ({
  version: 1, pens: [], lichen: [], lastRun: 0, lastResult: null,
  stats: { placed: 0, lured: 0, bred: 0, culled: 0, sheared: 0, lichenGrown: 0, lichenHarvested: 0 }, updatedAt: null
})

function load({ file, log = () => {} }) {
  const s = blank()
  try {
    const own = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
    Object.assign(s, own, { stats: { ...s.stats, ...(own.stats || {}) } })
  } catch (e) { if (e.code !== 'ENOENT') log(`husbandry state unreadable (${e.message}); starting fresh`) }
  if (!Array.isArray(s.pens)) s.pens = []
  if (!Array.isArray(s.lichen)) s.lichen = []
  return s
}

function save(file, state, now = Date.now, log = () => {}) {
  state.updatedAt = new Date(now()).toISOString()
  try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 1)); fs.renameSync(tmp, file) } catch (e) { log('husbandry state save failed: ' + e.message) }
}

module.exports = { load, save, blank }
