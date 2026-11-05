// Persistent state for the routines. Our own file (api.statePath) is authoritative; the first time we only read the driver's
// routine-state.json (farm flag, last farm run) and sleep-state.json (last wake, last ping) to inherit them. Legacy files are never written.
const fs = require('fs')

const blank = () => ({
  version: 1,
  farm: { enabled: false, lastRun: 0, pending: [], lastResult: null, fullWarnedDay: null },
  sleep: { lastWakeAge: -1e9, pingedDay: -99, noBedDay: -99, night: -1, attempts: 0, lastResult: null },
  importedFrom: [], updatedAt: null
})
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))

function load({ file, legacyRoutineFile, legacySleepFile, log = () => {} }) {
  const s = blank()
  let loaded = false
  try {
    const own = readJson(file)
    s.farm = { ...s.farm, ...(own.farm || {}) }; s.sleep = { ...s.sleep, ...(own.sleep || {}) }; s.importedFrom = own.importedFrom || []
    loaded = true
  } catch (e) { if (e.code !== 'ENOENT') log(`routines state unreadable (${e.message}); importing the driver's files instead`) }
  if (!loaded) {
    try {
      const r = readJson(legacyRoutineFile)
      s.farm.enabled = !!r.farm; s.farm.lastRun = Number(r.lastFarmRun) || 0; s.importedFrom.push(legacyRoutineFile)
    } catch (e) { if (e.code !== 'ENOENT') log(`routine-state.json unreadable: ${e.message}`) }
    try {
      const sl = readJson(legacySleepFile)
      if (Number.isFinite(sl.lastWakeAge)) s.sleep.lastWakeAge = sl.lastWakeAge
      if (Number.isFinite(sl.pingedDay)) s.sleep.pingedDay = sl.pingedDay
      s.importedFrom.push(legacySleepFile)
    } catch (e) { if (e.code !== 'ENOENT') log(`sleep-state.json unreadable: ${e.message}`) }
    if (s.importedFrom.length) log(`imported ${s.importedFrom.length} driver state file(s)`)
  }
  if (!Array.isArray(s.farm.pending)) s.farm.pending = []
  return s
}

function save(file, state, now = Date.now, log = () => {}) {
  state.updatedAt = new Date(now()).toISOString()
  try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 1)); fs.renameSync(tmp, file) } catch (e) { log('routines state save failed: ' + e.message) }
}

module.exports = { load, save, blank }
