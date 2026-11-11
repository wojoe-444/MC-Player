// brain/bases/lib.js: pure helpers for the base record and the dug-block log (no bot, no timers). The dashboard reads the same files with
// dashboard/basecast.js (no dependency on brain/), so the file shapes below are the contract.
//
//   bot-shared/bases.json   { worlds: { "<spawn x,z>": { bases: [ { id, name, x, y, z, radius, save, source, at } ] } } }
//   bot-shared/base-dug/<base id>.jsonl   one JSON line per block a bot dug inside the base: [x, y, z, blockName, botName, epochMs]
//
// A base is a waypoint (Walter's, from Xaero or waypoints.json) that the code treats as a place the bots live and build around. "Inside the base" is
// a horizontal circle of `radius` blocks around the waypoint, at any height (the underground below it is the point).
'use strict'
const crypto = require('crypto')

const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'base'
const worldHash = (world) => crypto.createHash('sha1').update(String(world)).digest('hex').slice(0, 4)
const baseId = (name, world) => `${slug(name)}-${worldHash(world)}`

// the base whose circle holds the position; the nearest when circles overlap. null = not in any base
function baseAt(bases, p) {
  let best = null, bd = Infinity
  for (const b of bases || []) {
    const d = Math.hypot(p.x - b.x, p.z - b.z)
    if (d <= b.radius && d < bd) { best = b; bd = d }
  }
  return best
}

// One dug-log line, or null when the block is not "space" (tree trunks, plants, things the bot placed itself: taking those out hollows nothing).
function digLine(block, by, t, ignoreRe, placed) {
  if (!block || !block.position || !block.name) return null
  if (ignoreRe && ignoreRe.test(block.name)) return null
  const p = block.position
  if (placed && placed(p, block.name)) return null
  return JSON.stringify([p.x, p.y, p.z, block.name, by, t])
}

// merge a computed base into the list of the world: update an existing id in place, keep the others (other waypoints, other bots' writes)
function mergeBase(file, world, base) {
  const all = file && typeof file === 'object' ? file : {}
  all.worlds = all.worlds || {}
  const w = all.worlds[world] = all.worlds[world] || { bases: [] }
  w.bases = Array.isArray(w.bases) ? w.bases : []
  const i = w.bases.findIndex(b => b.id === base.id)
  if (i < 0) { w.bases.push(base); return { file: all, changed: true } }
  const old = w.bases[i]
  const same = old.x === base.x && old.y === base.y && old.z === base.z && old.radius === base.radius && old.name === base.name && (old.save || null) === (base.save || null)
  if (same) return { file: all, changed: false }
  w.bases[i] = { ...old, ...base, at: old.at || base.at }
  return { file: all, changed: true }
}

module.exports = { slug, worldHash, baseId, baseAt, digLine, mergeBase }
