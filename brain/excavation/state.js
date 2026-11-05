// Persistent progress for the excavation. Our own file (api.statePath) is authoritative; the very first time we only
// read the legacy exc-state.json of excavate.js to inherit the finished sections. We never write the legacy file.
const fs = require('fs')

const blank = () => ({ version: 1, active: false, finished: false, done: [], doneCeiling: [], doneHigh: [], pillar: null, leftCells: 0, dug: 0, skipped: {}, startedAt: null, finishedAt: null, total: null, pauseReason: null, unreachable: [], importedFrom: null, updatedAt: null })
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))

function load({ file, legacyFile, log = () => {} }) {
  const state = blank()
  let loaded = false
  try { Object.assign(state, readJson(file)); loaded = true } catch (e) { if (e.code !== 'ENOENT') log(`excavation state unreadable (${e.message}); importing the legacy file instead`) }
  if (!loaded && legacyFile) {
    try {
      const old = readJson(legacyFile)
      state.done = Array.isArray(old.done) ? [...new Set(old.done)] : []
      state.dug = Number(old.dug) || 0
      state.skipped = old.skipped && typeof old.skipped === 'object' ? old.skipped : {}
      state.startedAt = old.startedAt || null
      state.importedFrom = legacyFile
      state.active = false          // an old "active" flag is not Walter's go for this module
      log(`imported ${state.done.length} finished sections from ${legacyFile}`)
    } catch (e) { if (e.code !== 'ENOENT') log(`legacy excavation state unreadable: ${e.message}`) }
  }
  for (const k of ['done', 'doneCeiling', 'doneHigh']) state[k] = [...new Set(state[k] || [])]
  return state
}

function save(file, state, now = Date.now, log = () => {}) {
  state.updatedAt = new Date(now()).toISOString()
  try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 1)); fs.renameSync(tmp, file) } catch (e) { log('excavation state save failed: ' + e.message) }
}

module.exports = { load, save, blank }
