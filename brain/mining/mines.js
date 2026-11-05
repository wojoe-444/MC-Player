// Waypoints for mines: reading Walter's "mine ..." waypoints (waypoints.json and Xaero, through the nav module's book) and recording ours.
// Recording writes waypoints.json (read-modify-write, atomic) because that is where "set waypoint ..." and the nav module look.
// This is the one file outside brain/state this module writes (INTERFACE.md rule 7); config.recordWaypoint = false switches it off.
const fs = require('fs')
const path = require('path')

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch { return fallback } }

const MINE_NAME = /^\s*(?:the\s+)?(?:\w+\s+)?mine\b/i

// -> { list(): [{name,x,y,z,dim}], add(name, {x,y,z}) -> storedName }
function create({ dir, book = null, record = true, log = () => {} }) {
  const file = path.join(dir, 'waypoints.json')
  function list() {
    let all = []
    try { if (book) { book.load(true); all = book.all(0).map(w => ({ name: w.name, x: w.x, y: typeof w.y === 'number' ? w.y : null, z: w.z, dim: w.dim })) } } catch (e) { log('waypoint book: ' + e.message) }
    if (!all.length) {
      const local = readJson(file, {})
      all = Object.entries(local).filter(([, c]) => c && typeof c.x === 'number' && typeof c.z === 'number' && (c.dim ?? 0) === 0).map(([name, c]) => ({ name, x: c.x, y: typeof c.y === 'number' ? c.y : null, z: c.z, dim: 0 }))
    }
    return all.filter(w => MINE_NAME.test(w.name))
  }
  function add(name, p) {
    if (!record) return null
    const cur = readJson(file, {})
    let n = name, i = 1
    while (cur[n] && Math.hypot(cur[n].x - p.x, cur[n].z - p.z) > 24) { i++; n = `${name} ${i}` }
    if (cur[n]) return n                                  // the same place again
    cur[n] = { x: p.x, y: p.y, z: p.z, source: 'mining' }
    try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cur, null, 2)); fs.renameSync(tmp, file) } catch (e) { log('waypoint write failed: ' + e.message); return null }
    return n
  }
  function remove(name) {
    if (!record) return false
    const cur = readJson(file, {})
    if (!cur[name] || cur[name].source !== 'mining') return false          // only our own entries
    delete cur[name]
    try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cur, null, 2)); fs.renameSync(tmp, file) } catch (e) { log('waypoint write failed: ' + e.message); return false }
    return true
  }
  return { list, add, remove, file }
}

// How well does a "mine ..." waypoint fit this ore? 0 = no.
function fit(wp, ore, def) {
  const words = [ore, ...Object.entries(require('./config.json').aliases).filter(([, v]) => v === ore).map(([k]) => k)]
  const named = words.some(w => new RegExp(`\\b${w}s?\\b`, 'i').test(wp.name))
  if (named) return 3
  const otherOre = Object.keys(require('./config.json').ores).some(o => o !== ore && new RegExp(`\\b${o}s?\\b`, 'i').test(wp.name))
  if (otherOre) return 0
  if (typeof wp.y === 'number' && wp.y >= def.range[0] - 6 && wp.y <= def.range[1] + 6) return 2
  return 0
}

module.exports = { create, fit, MINE_NAME }
