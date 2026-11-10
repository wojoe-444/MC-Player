// Persistent state for the tree farm (api.statePath('treefarm-state.json')): marked sites, replant spots that are still open,
// a pillar we may still be standing on, run history.
const fs = require('fs')

const blank = () => ({ version: 1, sites: [], farms: [], pending: [], pillar: null, worksite: null, groveAt: {}, decay: [], lastRun: 0, lastResult: null, askedAt: 0, stats: { trees: 0, logs: 0, planted: 0, lit: 0, leavesBroken: 0 }, updatedAt: null })

function load({ file, log = () => {} }) {
  const s = blank()
  try {
    const own = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
    Object.assign(s, own, { stats: { ...s.stats, ...(own.stats || {}) } })
  } catch (e) { if (e.code !== 'ENOENT') log(`treefarm state unreadable (${e.message}); starting fresh`) }
  if (!Array.isArray(s.sites)) s.sites = []
  if (!Array.isArray(s.farms)) s.farms = []
  if (!Array.isArray(s.pending)) s.pending = []
  if (!Array.isArray(s.decay)) s.decay = []
  return s
}

function save(file, state, now = Date.now, log = () => {}) {
  state.updatedAt = new Date(now()).toISOString()
  try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 1)); fs.renameSync(tmp, file) } catch (e) { log('treefarm state save failed: ' + e.message) }
}

module.exports = { load, save, blank }
