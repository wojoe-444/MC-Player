// Persistent state of the mining module (brain/state/mining-state.json via api.statePath). Atomic writes.
const fs = require('fs')

const blank = () => ({ version: 1, active: false, job: null, mineId: null, mineSeq: 0, mines: [], announced: false, pauseReason: null, stripsDone: 0, auto: false, autoSaidAt: 0, sinceTorch: 0, routine: { holdUntil: 0, nextAt: 0, backoff: 0, hintedAt: 0 }, stats: { dug: 0, ores: 0, skipped: {} }, updatedAt: null })

function load({ file, log = () => {} }) {
  const state = blank()
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
    Object.assign(state, old)
    state.stats = { ...blank().stats, ...(old.stats || {}) }
    state.stats.skipped = state.stats.skipped || {}
    state.mines = Array.isArray(old.mines) ? old.mines : []
    state.routine = { ...blank().routine, ...(old.routine || {}) }
    // Walter's go survives a restart: a job that was running (not stopped, not parked) when the bot went down is continued by start()
    state.resumeOnStart = !!(old.active && old.job && !old.job.finished)
    state.active = false              // an old "active" flag is never Walter's go; mining starts only from his command
  } catch (e) { if (e.code !== 'ENOENT') log(`mining state unreadable (${e.message}); starting clean`) }
  return state
}

function save(file, state, now = Date.now, log = () => {}) {
  state.updatedAt = new Date(now()).toISOString()
  try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 1)); fs.renameSync(tmp, file) } catch (e) { log('mining state save failed: ' + e.message) }
}

module.exports = { load, save, blank }
