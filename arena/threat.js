// Threat assessment for the combat reflex layer. Swappable: combat.js only needs assess(bot, tracks, P) -> { threats, arrows }.
// Line of sight + reachability aware: a mob behind a wall that cannot hurt us right now has canHurt=false and triggers no reaction.
const { Vec3 } = require('vec3')
const { lineOfSight } = require('../brain/safety/reach')

const MELEE = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'spider', 'cave_spider', 'silverfish', 'vindicator', 'piglin_brute', 'zombified_piglin', 'slime', 'magma_cube'])
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager'])
const solidAt = (bot, glassBlocks) => (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox === 'block' && (glassBlocks || !/(glass|fence|bars|leaves)/.test(b.name)) }   // glassBlocks: glass stops arrows and mobs, so a skeleton behind glass cannot hurt us

function kindOf(e) {
  if (e.name === 'creeper') return 'creeper'
  if (RANGED.has(e.name)) return 'ranged'
  if (MELEE.has(e.name)) return 'melee'
  return e.type === 'hostile' ? 'melee' : null
}

// distance from point p to the mob's axis-aligned box
function boxDist(p, e) {
  const w = (e.width || 0.6) / 2, h = e.height || 1.8, q = e.position
  const dx = Math.max(q.x - w - p.x, 0, p.x - (q.x + w)), dy = Math.max(q.y - p.y, 0, p.y - (q.y + h)), dz = Math.max(q.z - w - p.z, 0, p.z - (q.z + w))
  return Math.hypot(dx, dy, dz)
}

function visible(bot, eye, e, glassBlocks) {
  const s = solidAt(bot, glassBlocks), q = e.position, h = e.height || 1.8
  for (const f of [0.5, 0.9, 0.1]) if (lineOfSight(eye, { x: q.x, y: q.y + h * f, z: q.z }, s)) return true
  return false
}

function assess(bot, tracks, P) {
  const me = bot.entity.position, eye = { x: me.x, y: me.y + 1.62, z: me.z }
  const threats = [], arrows = []
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position) continue
    const d = Math.hypot(e.position.x - me.x, e.position.y - me.y, e.position.z - me.z)
    if (e.name === 'arrow' || e.name === 'spectral_arrow') {
      if (d > 20) continue
      const t = tracks.get(e.id); const v = (e.velocity && (e.velocity.x || e.velocity.z)) ? e.velocity : (t && t.vel)
      if (!v || Math.hypot(v.x, v.y, v.z) < 0.3) continue
      const sp = Math.hypot(v.x, v.y, v.z), dir = { x: v.x / sp, y: v.y / sp, z: v.z / sp }
      const rx = me.x - e.position.x, ry = me.y + 1 - e.position.y, rz = me.z - e.position.z
      const along = rx * dir.x + ry * dir.y + rz * dir.z
      if (along < 0 || along > 20) continue
      const miss = Math.hypot(rx - dir.x * along, ry - dir.y * along, rz - dir.z * along)
      if (miss < 1.6) arrows.push({ e, along, eta: along / sp, miss, dir })   // eta in ticks (velocity is blocks per tick)
      continue
    }
    const kind = kindOf(e); if (!kind || d > P.scanRange) continue
    if (e.health !== undefined && e.health <= 0) continue
    const reach = boxDist(eye, e)
    const los = visible(bot, eye, e, P.glassBlocksLos)
    const t = tracks.get(e.id); const vel = (t && t.vel) || { x: 0, y: 0, z: 0 }
    const md = e.metadata || []
    const fusing = kind === 'creeper' && (md[16] === 1 || md[18] === true)
    const drawing = kind === 'ranged' && (((md[8] | 0) & 1) === 1)
    // canHurt: can it hurt us right now (or within ~1 s)? walls make this false
    let canHurt
    if (kind === 'ranged') canHurt = los && d < 24
    else if (kind === 'creeper') canHurt = (los && d < 8) || d < 3.5
    else canHurt = (los && d < 10) || d < 2.2
    threats.push({ e, name: e.name, kind, d, reach, los, canHurt, vel, fusing, drawing, hp: e.health })
  }
  return { threats, arrows }
}

module.exports = { assess, boxDist, kindOf, visible, solidAt }
