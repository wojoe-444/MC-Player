// Shelter finding and night/outdoor checks for the safety module. Post-mortem of the 03:51 death: the bot fought skeletons in the
// open at night and, hurt, stayed where it stood. Now: low health or night-outdoors retreats to the nearest known shelter.
const fs = require('fs')
const { Vec3 } = require('vec3')

const SHELTER_DEFAULTS = {
  shelterRe: /(house|home|shelter|\bbed\b|furnace station|crafting table|mine storage|base)/i,
  notShelterRe: /(farm|portal|village|lava|chest|depot|mt |spookville)/i,
  shelterMax: 90,        // never run further than this to hide
  bedRadius: 48,
  nightStart: 12542, nightEnd: 23460,
  skyScan: 48
}

const isNight = (bot) => !!bot.time && bot.time.timeOfDay >= SHELTER_DEFAULTS.nightStart && bot.time.timeOfDay < SHELTER_DEFAULTS.nightEnd && !(bot.game && bot.game.dimension && bot.game.dimension !== 'overworld')

// Is there open sky above the bot? Solid blocks above (not leaves) within skyScan blocks mean roofed / underground.
function skyExposed(bot, pos = bot.entity.position, scan = SHELTER_DEFAULTS.skyScan) {
  const x = Math.floor(pos.x), z = Math.floor(pos.z), y0 = Math.floor(pos.y) + 2
  for (let dy = 0; dy < scan; dy++) {
    const b = bot.blockAt(new Vec3(x, y0 + dy, z))
    if (b && b.boundingBox === 'block' && !/_leaves$/.test(b.name || '')) return false
  }
  return true
}

function readWaypoints(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch { return {} }
}

// Candidate shelters: beds the bot can see plus named waypoints (house, furnace stations, ...). Returns [{ name, pos }].
function listShelters(bot, waypoints, cfg = {}) {
  const C = { ...SHELTER_DEFAULTS, ...cfg }
  const out = []
  for (const [name, w] of Object.entries(waypoints || {})) {
    if (!w || typeof w.x !== 'number') continue
    if (!C.shelterRe.test(name) || C.notShelterRe.test(name)) continue
    out.push({ name, pos: new Vec3(w.x, w.y, w.z) })
  }
  try {
    if (bot.findBlocks && bot.registry && bot.registry.blocksArray) {
      const ids = bot.registry.blocksArray.filter(b => b.name.endsWith('_bed')).map(b => b.id)
      for (const p of bot.findBlocks({ matching: ids, maxDistance: C.bedRadius, count: 4 })) out.push({ name: 'bed', pos: p })
    }
  } catch { /* no beds in range */ }
  return out
}

function pickShelter(me, shelters, max = SHELTER_DEFAULTS.shelterMax) {
  let best = null
  for (const s of shelters) {
    const d = Math.hypot(s.pos.x + 0.5 - me.x, s.pos.z + 0.5 - me.z) + Math.abs(s.pos.y - me.y) * 0.5
    if (d <= max && (!best || d < best.dist)) best = { name: s.name, pos: s.pos, dist: d }
  }
  return best
}

// Narrow ground / bridge over a drop: 4+ of the 8 neighbouring cells (or both cells on one axis) have no floor within 4 blocks below
// (a step there is a fall of more than 3). Running on such ground is how the bot went off the mining bridge at y26.
function dropExposure(bot, pos = bot.entity.position) {
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z)
  const solid = (a, b, c) => { const k = bot.blockAt(new Vec3(a, b, c)); return !!k && k.boundingBox === 'block' }
  const open = (dx, dz) => {
    if (solid(x + dx, y, z + dz) || solid(x + dx, y + 1, z + dz)) return false          // a wall, not a drop
    for (let dy = 1; dy <= 4; dy++) if (solid(x + dx, y - dy, z + dz)) return false
    return true
  }
  const ring = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
  const drops = ring.filter(([dx, dz]) => open(dx, dz)).length
  const narrow = drops >= 4 || (open(1, 0) && open(-1, 0)) || (open(0, 1) && open(0, -1))
  return { drops, narrow }
}

module.exports = { dropExposure, SHELTER_DEFAULTS, isNight, skyExposed, listShelters, pickShelter, readWaypoints }
