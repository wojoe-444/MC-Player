// Emergency shelter: wall the bot in where it stands (a player's oldest trick: cobble on every open side and overhead), then eat and heal.
// Only used when Walter has allowed it (`emergencyEntomb`, default OFF) because it places and later digs blocks. It places filler blocks only,
// remembers every block it placed, and digs out through those blocks only. Pure planning first, then an executor that needs placeBlock/dig.
const { Vec3 } = require('vec3')
const { lineOfSight } = require('./reach')

const FILLER = ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'dirt', 'netherrack', 'blackstone']
const PICKS = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe']
const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

// kindAt(x,y,z) -> 'solid' | 'air' | 'decor' | 'water' | 'lava' | 'unknown'. 'decor' = a non-solid block that is not air (sculk_vein, glow lichen, vines,
// a torch, snow, ...): the server refuses to place a block into it, so it is dug out (instant, no tool) before the filler goes in. Cells to fill, most protective first:
// overhead, head-level sides, feet-level sides, floor. Lava next to us cannot be sealed safely: reported as `blocked`.
function planEntomb(pos, kindAt) {
  const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z)
  const order = [[0, 2, 0], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]
  const fill = [], blocked = []
  for (const [dx, dy, dz] of order) {
    const k = kindAt(x + dx, y + dy, z + dz)
    if (k === 'air' || k === 'water' || k === 'decor') { const c = new Vec3(x + dx, y + dy, z + dz); c.decor = k === 'decor'; fill.push(c) }
    else if (k === 'lava' || k === 'unknown') blocked.push({ pos: new Vec3(x + dx, y + dy, z + dz), kind: k })
  }
  return { fill, blocked, here: new Vec3(x, y, z) }
}

// A solid neighbour of `cell` to click on, and the face vector (cell - reference).
function referenceFor(cell, kindAt) {
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const rx = cell.x + dx, ry = cell.y + dy, rz = cell.z + dz
    if (kindAt(rx, ry, rz) === 'solid') return { ref: new Vec3(rx, ry, rz), face: new Vec3(dx ? -dx : 0, dy ? -dy : 0, dz ? -dz : 0) }
  }
  return null
}

const fillerItem = (items) => { for (const n of FILLER) { const it = items.find(i => i.name === n); if (it) return it } return null }
const pickaxe = (items) => { for (const n of PICKS) { const it = items.find(i => i.name === n); if (it) return it } return null }
const countFiller = (items) => items.filter(i => FILLER.includes(i.name)).reduce((s, i) => s + i.count, 0)

// Exits: the side cells (feet+head) we placed; prefer the side facing `toward` (a shelter / Walter), else the first.
function exitCells(placed, here, toward) {
  const sides = placed.filter(p => p.y >= here.y && p.y <= here.y + 1 && Math.abs(p.x - here.x) + Math.abs(p.z - here.z) === 1)
  const byCol = new Map()
  for (const p of sides) { const k = `${p.x},${p.z}`; (byCol.get(k) || byCol.set(k, []).get(k)).push(p) }
  const cols = [...byCol.values()].filter(c => c.length === 2)
  if (!cols.length) return sides.slice(0, 2)
  if (toward) cols.sort((a, b) => Math.hypot(a[0].x - toward.x, a[0].z - toward.z) - Math.hypot(b[0].x - toward.x, b[0].z - toward.z))
  return cols[0].sort((a, b) => b.y - a.y)       // head first, then feet
}

function makeEntomb({ bot, log = () => {}, canSee = null, sleep = (ms) => new Promise(r => setTimeout(r, ms)) }) {
  const kindAt = (x, y, z) => {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) return 'unknown'
    if (b.name === 'lava') return 'lava'
    if (b.name === 'water') return 'water'
    if (b.boundingBox === 'block') return 'solid'
    return /^(air|cave_air|void_air)$/.test(b.name) ? 'air' : 'decor'
  }
  const state = { placed: [], here: null, active: false }

  // ---- placement that the server accepts ----
  // A face can only be clicked from outside it: the eye must be on the outer side of the face plane (a top face above the eye cannot be clicked),
  // and nothing may stand between the eye and the face. The 17:18 failures ("Server refused to place cobblestone ... the block is still air") were
  // clicks on faces the eye could not see (roof cells, stepping blocks above head height).
  const eyeOf = () => { const p = bot.entity.position; return { x: p.x, y: p.y + 1.62, z: p.z } }
  const solidAt = (x, y, z) => kindAt(x, y, z) === 'solid'
  function visibleRef(cell) {
    const eye = eyeOf(), best = []
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const rx = cell.x + dx, ry = cell.y + dy, rz = cell.z + dz
      if (!solidAt(rx, ry, rz)) continue
      const face = new Vec3(-dx, -dy, -dz)
      const fc = { x: rx + 0.5 + face.x * 0.5, y: ry + 0.5 + face.y * 0.5, z: rz + 0.5 + face.z * 0.5 }
      if ((eye.x - fc.x) * face.x + (eye.y - fc.y) * face.y + (eye.z - fc.z) * face.z <= 0.05) continue      // eye behind the face plane
      const d = Math.hypot(eye.x - fc.x, eye.y - fc.y, eye.z - fc.z)
      if (d > 4.5) continue
      const to = { x: fc.x + face.x * 0.02, y: fc.y + face.y * 0.02, z: fc.z + face.z * 0.02 }
      if (!lineOfSight(eye, to, solidAt)) continue
      best.push({ ref: new Vec3(rx, ry, rz), face, d })
    }
    best.sort((m, n) => m.d - n.d)
    return best[0] || null
  }
  // Place one filler block at `target` against the visible face `r`. Waits for the block to appear (the server's blockUpdate) and retries once.
  async function placeOne(target, r) {
    const refBlock = bot.blockAt(r.ref)
    if (canSee && refBlock && !(await canSee(refBlock))) return false
    const here = bot.blockAt(target)
    if (here && kindAt(target.x, target.y, target.z) === 'decor') {          // sculk vein, lichen, vine, torch ...: the server refuses to place into it
      try { await bot.dig(here); log(`entomb cleared ${here.name} at ${target.x},${target.y},${target.z}`); for (let w = 0; w < 6 && kindAt(target.x, target.y, target.z) === 'decor'; w++) await sleep(60) } catch (e) { log(`entomb clear ${here.name}: ${e.message}`); return false }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const item = fillerItem(bot.inventory.items())
      if (!item) return false
      try { await bot.equip(item, 'hand'); await bot.placeBlock(refBlock, r.face) } catch (e) { log(`entomb place ${target.x},${target.y},${target.z} (try ${attempt + 1}): ${e.message}`) }
      for (let w = 0; w < 8; w++) { if (kindAt(target.x, target.y, target.z) === 'solid') { state.placed.push(target); return true } await sleep(70) }
    }
    return false
  }

  // A side cell over a void (no floor within 3 blocks under the feet level) is no way in for anything that walks: on a bridge only the two ends need sealing.
  const overVoid = (c) => { for (let dy = 1; dy <= 3; dy++) if (solidAt(c.x, state.here.y - dy, c.z)) return false; return true }
  const inColumn = (c) => c.x === state.here.x && c.z === state.here.z && c.y >= state.here.y && c.y <= state.here.y + 1
  async function sidesPass() {
    let progressed = false
    const plan = planEntomb(bot.entity.position, kindAt)
    const sides = plan.fill.filter(c => (c.y === state.here.y || c.y === state.here.y + 1) && !overVoid(c)).sort((m, n) => m.y - n.y)      // feet level first: they have a floor to click
    for (const cell of sides) {
      if (kindAt(cell.x, cell.y, cell.z) === 'solid') continue
      if (!fillerItem(bot.inventory.items())) return { progressed, out: true }
      const r = visibleRef(cell)
      if (r && await placeOne(cell, r)) { progressed = true; continue }
      if (!r) {
        // a stepping block beside it (below it, on a bridge) that has a visible face to click, then the cell itself next pass
        const bridge = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map(([dx, dy, dz]) => new Vec3(cell.x + dx, cell.y + dy, cell.z + dz))
          .find(bb => kindAt(bb.x, bb.y, bb.z) === 'air' && !inColumn(bb) && visibleRef(bb))
        if (bridge && await placeOne(bridge, visibleRef(bridge))) progressed = true
      }
    }
    return { progressed, out: false }
  }
  // Roof: a visible face if one exists (an overhang), else jump and place against the TOP face of a head-level side block (the eye is above
  // that plane at the top of the jump), land, then click the side of that block to close the cell above the head.
  async function roof() {
    const cell = new Vec3(state.here.x, state.here.y + 2, state.here.z)
    const k = kindAt(cell.x, cell.y, cell.z)
    if (k === 'solid' || k === 'lava' || k === 'unknown') return k === 'solid'
    const direct = visibleRef(cell)
    if (direct && await placeOne(cell, direct)) return true
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const side = new Vec3(cell.x + dx, state.here.y + 1, cell.z + dz), step = new Vec3(side.x, side.y + 1, side.z)
      if (!solidAt(side.x, side.y, side.z) || kindAt(step.x, step.y, step.z) !== 'air' || !fillerItem(bot.inventory.items())) continue
      try { bot.setControlState('jump', true) } catch { return false }
      await sleep(230)                                                       // near the top of the jump
      const topRef = { ref: side, face: new Vec3(0, 1, 0) }
      const eye = eyeOf()
      const canClick = eye.y > side.y + 1.05
      let placedStep = false
      if (canClick) placedStep = await placeOne(step, topRef)
      try { bot.setControlState('jump', false) } catch { /* ignore */ }
      await sleep(450)                                                       // land
      if (!placedStep) continue
      const r = visibleRef(cell)
      if (r && await placeOne(cell, r)) return true
    }
    return kindAt(cell.x, cell.y, cell.z) === 'solid'
  }

  async function seal() {
    const items = bot.inventory.items()
    if (!fillerItem(items)) return { ok: false, why: 'no cobblestone or other filler block' }
    state.active = true
    state.here = new Vec3(Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z))
    try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch { /* ignore */ }
    for (let pass = 0; pass < 4; pass++) {
      const r = await sidesPass()
      if (r.out) return { ok: false, why: 'ran out of filler blocks', placed: state.placed.length }
      if (!r.progressed) break
    }
    const sidesLeft = () => planEntomb(state.here, kindAt).fill.filter(c => (c.y === state.here.y || c.y === state.here.y + 1) && !overVoid(c))
    const left = planEntomb(state.here, kindAt)
    const open = sidesLeft().length
    return { ok: open === 0 && left.blocked.every(bb => bb.kind !== 'lava'), placed: state.placed.length, open, roof: kindAt(state.here.x, state.here.y + 2, state.here.z) === 'solid', lava: left.blocked.filter(bb => bb.kind === 'lava').length }
  }

  // Dig out through one pair of cells we placed ourselves. Returns true when an exit exists.
  async function digOut(toward) {
    const cells = exitCells(state.placed, state.here || bot.entity.position.floored(), toward)
    if (!cells.length) return false
    const pick = pickaxe(bot.inventory.items())
    if (pick) await bot.equip(pick, 'hand').catch(() => {})
    for (const c of cells) {
      const b = bot.blockAt(c)
      if (!b || b.boundingBox !== 'block') continue
      if (canSee && !(await canSee(b))) continue
      try { await bot.dig(b) } catch (e) { log(`entomb dig ${c.x},${c.y},${c.z}: ${e.message}`); return false }
      state.placed = state.placed.filter(p => !(p.x === c.x && p.y === c.y && p.z === c.z))
    }
    state.active = false
    return true
  }

  // Called once the sides are sealed (the bot is already safe from walkers): try to close the cell above the head. Slow (a jump per attempt), so not part of seal().
  const closeRoof = () => roof().catch(() => false)
  return { seal, closeRoof, digOut, state, planEntomb: () => planEntomb(bot.entity.position, kindAt) }
}

module.exports = { planEntomb, referenceFor, exitCells, makeEntomb, fillerItem, countFiller, FILLER }
