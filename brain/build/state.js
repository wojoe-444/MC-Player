// Persistent progress of the tower (api.statePath('build-state.json')). Written atomically; the pillar cells and the placed cells go in as they happen.
const fs = require('fs')

const blank = () => ({ version: 1, active: false, finished: false, site: null, centre: null, phase: 'idle', pillar: null, placed: [], blocks: 0, skipped: {}, startedAt: null, finishedAt: null, pauseReason: null, updatedAt: null })
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))

function load({ file, log = () => {} }) {
  const state = blank()
  try { Object.assign(state, readJson(file)) } catch (e) { if (e.code !== 'ENOENT') log(`build state unreadable (${e.message}); starting blank`) }
  if (!Array.isArray(state.placed)) state.placed = []
  if (!state.skipped || typeof state.skipped !== 'object') state.skipped = {}
  return state
}

function save(file, state, now = Date.now, log = () => {}) {
  state.updatedAt = new Date(now()).toISOString()
  try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state)); fs.renameSync(tmp, file) } catch (e) { log('build state save failed: ' + e.message) }
}

module.exports = { load, save, blank }
