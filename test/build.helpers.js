// Test rig for brain/build: the shared mock bot plus a small physical world (place, dig, jump, ladders, a breadth-first "pathfinder", raycast)
// so the whole tower can be built offline and every placement checked (whitelist, volume, line of sight, reach).
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { mockBot, mcData } = require('./mock-bot')
const { Scheduler, PRIORITY, AbortError } = require('../brain/scheduler')
const safehand = require('../brain/safehand')
const los = require('../brain/los')
const stateStore = require('../brain/build/state')
const createEngine = require('../brain/build/engine')
const blueprint = require('../brain/build/blueprint')
const baseConfig = require('../brain/build/config.json')

const wait = (ms) => new Promise(r => setTimeout(r, ms))
// no collision for rays and walking (doors are open for the bot; ladders and torches are thin)
const NONSOLID = /^(air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|torch|wall_torch|ladder|[a-z_]*_door)$/
const LIQUID = /^(water|lava)$/
const REPLACEABLE = /^(short_grass|tall_grass|fern)$/

function extend(bot, { pillarCol = null } = {}) {
  const baseBlockAt = bot.blockAt
  bot.unloaded = new Set()
  bot.placements = []; bot.digLog = []; bot.gotoLog = []; bot.losViolations = []; bot.reachViolations = []; bot.walkedOnPillar = []
  bot.pillarCol = pillarCol
  bot.enforceLos = true
  // a plain map of names next to the mock's own, so rays and walks do not build a block object per sample
  const names = new Map()
  const baseSet0 = bot.setBlock
  bot.setBlock = (x, y, z, n, props) => { names.set(`${x},${y},${z}`, n); baseSet0(x, y, z, n, props) }
  const name = (x, y, z) => names.get(`${x},${y},${z}`) || 'air'
  bot.blockAt = (p) => {
    if (!p || typeof p.floored !== 'function') throw new TypeError('pos.floored is not a function')
    if (bot.unloaded.has(`${p.x},${p.y},${p.z}`)) return null
    const b = baseBlockAt(p)
    b.boundingBox = NONSOLID.test(b.name) ? 'empty' : 'block'
    b.diggable = b.name !== 'bedrock'
    b.digTime = (type) => { const it = mcData.items[type]; return it && /_pickaxe$/.test(it.name) ? 300 : 3000 }
    return b
  }
  const solidAt = (x, y, z) => !NONSOLID.test(name(x, y, z))
  const passable = (x, y, z) => { if (bot.unloaded.has(`${x},${y},${z}`)) return false; const n = name(x, y, z); return NONSOLID.test(n) && !LIQUID.test(n) }
  const isLadder = (x, y, z) => name(x, y, z) === 'ladder'

  bot.nearestEntity = (f = () => true) => Object.values(bot.entities).filter(f).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null
  bot.stopDigging = () => {}

  // ---- rays: the first block with collision ----
  bot.world = {
    raycast(from, dir, range) {
      for (let t = 0; t <= range; t += 0.02) {
        const bx = Math.floor(from.x + dir.x * t), by = Math.floor(from.y + dir.y * t), bz = Math.floor(from.z + dir.z * t)
        if (solidAt(bx, by, bz)) return { position: new Vec3(bx, by, bz), name: name(bx, by, bz) }
      }
      return null
    }
  }
  // independent of brain/los.js: the block centre or an inset face centre must be reached first
  bot.losFrom = (from, block) => {
    const p = block.position
    const pts = [[0.5, 0.5, 0.5], [0.95, 0.5, 0.5], [0.05, 0.5, 0.5], [0.5, 0.95, 0.5], [0.5, 0.05, 0.5], [0.5, 0.5, 0.95], [0.5, 0.5, 0.05]]
    return pts.some(([a, b, c]) => {
      const to = new Vec3(p.x + a, p.y + b, p.z + c), d = to.minus(from), r = d.norm()
      const hit = bot.world.raycast(from, d.scaled(1 / r), r)
      return !hit || hit.position.equals(p)
    })
  }
  const eye = () => bot.entity.position.offset(0, 1.62, 0)
  const assertLos = (block, what) => {
    if (!bot.enforceLos) return
    if (!bot.losFrom(eye(), block)) { bot.losViolations.push(`${what} ${block.name} at ${block.position}`); throw new Error(`NO LINE OF SIGHT: ${what} ${block.name} at ${block.position}`) }
  }

  // ---- a little physics: jump = up 1.25 for 25 ms then land on the highest solid under the feet; a ladder cell holds the bot and climbs while jumping ----
  const cellOf = () => { const p = bot.entity.position; return [Math.floor(p.x), Math.floor(p.y + 0.01), Math.floor(p.z)] }
  const land = () => {
    const [x, y0, z] = cellOf()
    if (isLadder(x, y0, z)) { bot.entity.onGround = true; return }
    for (let yy = y0; yy > -60; yy--) if (solidAt(x, yy, z)) { bot.entity.position.y = yy + 1; bot.entity.onGround = true; return }
  }
  const fallIfUnsupported = () => {
    const p = bot.entity.position
    if (Math.abs(p.y - Math.round(p.y)) < 1e-6) { const [x, y, z] = cellOf(); if (!solidAt(x, y - 1, z) && !isLadder(x, y, z)) { bot.entity.onGround = false; land() } }
  }
  bot.physics = true
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.lookAt = async (pt) => { const p = bot.entity.position; bot.entity.yaw = Math.atan2(-(pt.x - p.x), -(pt.z - p.z)) }
  const baseSet = bot.setControlState
  let jumping = false
  bot.setControlState = (k, v) => { baseSet(k, v); if (k === 'jump' && v && bot.physics) bot.jumpLoop() }
  bot.jumpLoop = async () => {
    if (jumping) return
    jumping = true
    while (bot.controlStates.jump) {
      const [x, y, z] = cellOf()
      if (isLadder(x, y, z)) { bot.entity.position.y += 0.2; await wait(10); if (!isLadder(...cellOf())) { /* left the ladder cell upwards */ land() } }
      else if (bot.entity.onGround) { bot.entity.onGround = false; bot.entity.position.y += 1.25; await wait(25); land() }
      else await wait(10)
    }
    jumping = false
  }
  const AABB_W = 0.3
  const inTheWay = (t) => { const p = bot.entity.position; return Math.abs(p.x - (t.x + 0.5)) < 0.5 + AABB_W && Math.abs(p.z - (t.z + 0.5)) < 0.5 + AABB_W && p.y < t.y + 1 - 1e-6 && p.y + 1.8 > t.y }
  const dirOfYaw = () => { const y = bot.entity.yaw; const dx = -Math.sin(y), dz = -Math.cos(y); return Math.abs(dx) > Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)] }

  bot.onPlace = null
  bot.placeBlock = async (ref, face) => {
    const held = bot.heldItem; if (!held) throw new Error('nothing in hand')
    assertLos(ref, 'place on')
    const fc = ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
    if (eye().distanceTo(fc) > 4.5 + 1e-9) { bot.reachViolations.push(`${held.name} on ${ref.position}`); throw new Error('out of reach') }
    if (ref.boundingBox !== 'block') throw new Error('reference block is not solid')
    const t = ref.position.plus(face)
    const cur = name(t.x, t.y, t.z)
    if (cur !== 'air' && !REPLACEABLE.test(cur)) throw new Error('target cell is not empty')
    const n = held.name
    const solid = !/^(ladder|torch|.*_door)$/.test(n)
    if (solid && inTheWay(t)) throw new Error('entity in the way')
    const rec = { name: n, x: t.x, y: t.y, z: t.z, ref: { x: ref.position.x, y: ref.position.y, z: ref.position.z }, face: { x: face.x, y: face.y, z: face.z }, los: true, feetY: bot.entity.position.y, held: n }
    if (/_log$/.test(n)) bot.setBlock(t.x, t.y, t.z, n, { axis: face.y !== 0 ? 'y' : face.x !== 0 ? 'x' : 'z' })
    else if (n === 'ladder') { if (face.y !== 0) throw new Error('ladders need a wall'); bot.setBlock(t.x, t.y, t.z, n, { facing: face.x === 1 ? 'east' : face.x === -1 ? 'west' : face.z === 1 ? 'south' : 'north' }) }
    else if (n === 'torch') bot.setBlock(t.x, t.y, t.z, face.y === 1 ? 'torch' : 'wall_torch')
    else if (/_door$/.test(n)) {
      if (face.y !== 1) throw new Error('doors need a floor')
      if (name(t.x, t.y + 1, t.z) !== 'air') throw new Error('no room for the door')
      bot.setBlock(t.x, t.y, t.z, n, { half: 'lower' }); bot.setBlock(t.x, t.y + 1, t.z, n, { half: 'upper' })
    } else if (/_bed$/.test(n)) {
      const [dx, dz] = dirOfYaw(), h = new Vec3(t.x + dx, t.y, t.z + dz)
      if (name(h.x, h.y, h.z) !== 'air') throw new Error('no room for the bed head')
      if (!solidAt(h.x, h.y - 1, h.z)) throw new Error('the bed head needs a floor')
      bot.setBlock(t.x, t.y, t.z, n, { part: 'foot' }); bot.setBlock(h.x, h.y, h.z, n, { part: 'head' }); rec.head = { x: h.x, y: h.y, z: h.z }
    } else bot.setBlock(t.x, t.y, t.z, n)
    bot.take(n, 1)
    bot.placements.push(rec)
    if (n === 'chest') bot.addChest(t.x, t.y, t.z, 27, {})
    if (bot.onPlace) bot.onPlace(bot.placements.length, rec)
    if (bot.onPlaceAsync) await bot.onPlaceAsync(bot.placements.length, rec)
  }
  bot.canDigBlock = (b) => eye().distanceTo(b.position.offset(0.5, 0.5, 0.5)) <= 5.1
  bot.dig = async (b) => {
    assertLos(b, 'dig')
    if (!bot.canDigBlock(b)) throw new Error('out of reach')
    const { x, y, z } = b.position
    bot.digLog.push({ name: b.name, x, y, z, held: bot.heldItem && bot.heldItem.name, placedSoFar: bot.placements.length })
    bot.setBlock(x, y, z, 'air')
    if (b.name === 'cobblestone' && bot.heldItem && /_pickaxe$/.test(bot.heldItem.name)) bot.give('cobblestone', 1)    // only a pickaxe drops it; the drop lands in the shaft under the bot
    fallIfUnsupported()
    await wait(0)
  }

  // ---- breadth-first walker: where could the pathfinder get to (steps up 1, drops up to 3, ladders, open doors)? ----
  const standable = (x, y, z) => passable(x, y, z) && passable(x, y + 1, z) && (solidAt(x, y - 1, z) || isLadder(x, y, z))
  const neighbours = (x, y, z) => {
    const out = []
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz
      if (passable(nx, y, nz) && passable(nx, y + 1, nz)) {
        for (let d = 0; d <= 3; d++) {
          if (d > 0 && !passable(nx, y - d, nz)) break
          if (standable(nx, y - d, nz)) { out.push([nx, y - d, nz]); break }
        }
      } else if (solidAt(nx, y, nz) && passable(nx, y + 1, nz) && passable(nx, y + 2, nz) && passable(x, y + 2, z) && standable(nx, y + 1, nz)) out.push([nx, y + 1, nz])
    }
    if (isLadder(x, y, z)) {
      if (passable(x, y + 1, z) && passable(x, y + 2, z) && isLadder(x, y + 1, z)) out.push([x, y + 1, z])
      if (standable(x, y - 1, z)) out.push([x, y - 1, z])
    }
    return out
  }
  bot.reachable = (goalTest) => {
    const [sx, sy, sz] = cellOf()
    const seen = new Set([`${sx},${sy},${sz}`]), queue = [[sx, sy, sz]]
    for (let i = 0; i < queue.length && queue.length < 80000; i++) {
      const n = queue[i]
      if (goalTest(...n)) return n
      for (const m of neighbours(...n)) { const k = m.join(','); if (!seen.has(k)) { seen.add(k); queue.push(m) } }
    }
    return null
  }
  bot.gotoFails = null
  bot.tryGoto = async (goal, label = '', ms) => {
    if (bot.heldItem && bot.heldItem.name === 'lava_bucket') bot.lavaHeldWhileMoving.push(label)
    const onPillar = bot.pillarCol && Math.floor(bot.entity.position.x) === bot.pillarCol.x && Math.floor(bot.entity.position.z) === bot.pillarCol.z && bot.entity.position.y > bot.pillarCol.baseY + 0.3 && name(bot.pillarCol.x, Math.floor(bot.entity.position.y + 0.01) - 1, bot.pillarCol.z) === 'cobblestone'
    if (onPillar) bot.walkedOnPillar.push(label)
    bot.gotoLog.push({ label, goal: { ...goal }, feetY: bot.entity.position.y })
    bot.actions.push(['goto', label, goal.x, goal.y, goal.z])
    if (bot.gotoFails && bot.gotoFails(goal, label)) return { ok: false, err: 'no path' }
    let test
    if (goal.constructor === bot.goals.GoalBlock) test = (x, y, z) => x === goal.x && y === goal.y && z === goal.z
    else if (goal.constructor === bot.goals.GoalNear) test = (x, y, z) => new Vec3(x + 0.5, y, z + 0.5).distanceTo(new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5)) <= goal.r + 0.01
    else if (goal.constructor === bot.goals.GoalNearXZ) test = (x, y, z) => Math.hypot(x + 0.5 - goal.x, z + 0.5 - goal.z) <= goal.r
    else return { ok: false, err: 'unknown goal' }
    const hit = bot.reachable(test)
    if (!hit) return { ok: false, err: 'no path' }
    bot.entity.position = new Vec3(hit[0] + 0.5, hit[1], hit[2] + 0.5)
    await wait(0)
    return { ok: true, secs: 0.1 }
  }
  return bot
}

// a flat (or bumpy) patch of grass: ground(x, z) -> y of the top block
function makeGround(bot, { x0, x1, z0, z1, ground }) {
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    const g = ground(x, z)
    for (let y = g - 3; y < g; y++) bot.setBlock(x, y, z, 'stone')
    bot.setBlock(x, g, z, 'grass_block')
  }
}

const fakeCtx = (over = {}) => ({
  state: {}, resumed: false, aborted: false,
  checkpoint() { if (this.aborted) throw new AbortError('test') },
  progress() {}, onAbort: () => () => {}, sleep: wait, ...over
})

const MATERIALS = { stone_bricks: 130, spruce_log: 40, spruce_planks: 60, ladder: 12, torch: 6, spruce_door: 1, cobblestone: 40, stone_pickaxe: 1 }
const FURNISHING = { white_bed: 1, chest: 1, crafting_table: 1 }

// ox,oy,oz: where the tower goes (oy = first course); ground: optional (x,z)->y of the grass top block (default oy-1 everywhere)
function rig({ ox = 100, oy = 70, oz = 200, ground = null, materials = MATERIALS, furnishing = true, config = {}, site = true } = {}) {
  const bot = extend(mockBot({ pos: [ox - 3 + 0.5, oy, oz + 2 + 0.5] }), { pillarCol: { x: ox + 2, z: oz + 2, baseY: oy } })
  const g = ground || (() => oy - 1)
  makeGround(bot, { x0: ox - 8, x1: ox + 12, z0: oz - 8, z1: oz + 12, ground: g })
  for (const [n, c] of Object.entries(materials)) if (c) bot.give(n, c)
  if (furnishing) for (const [n, c] of Object.entries(FURNISHING)) bot.give(n, c)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'))
  const file = path.join(dir, 'build-state.json')
  const said = [], logs = []
  const sh = safehand({ bot })
  const state = stateStore.load({ file })
  const save = () => fs.writeFileSync(file, JSON.stringify(state))          // plain write: the atomic rename of state.js is slow on Windows and tested separately
  if (site) {
    const low = []
    for (let dx = 0; dx <= 4; dx++) for (let dz = 0; dz <= 4; dz++) { const gy = g(ox + dx, oz + dz); if (gy < oy - 1) low.push([dx, dz, gy]) }
    state.site = { ox, oy, oz, score: 0, flat: low.length ? 1 : 0, low }; state.centre = { x: ox + 2, z: oz + 2 }
  }
  const canSee = (t) => los.canSee(bot, t)
  const ensureLineOfSight = (o) => los.ensureLineOfSight({ bot, goals: bot.goals, tryGoto: bot.tryGoto, ...o })
  const cfg = { ...baseConfig, ...config, limits: { ...baseConfig.limits, ...(config.limits || {}) }, timing: { stepMs: 2, landMs: 50, confirmMs: 4, ...(config.timing || {}) } }
  const make = (st = state, sv = save) => createEngine({ bot, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, safehand: sh, stopNav: () => {}, config: cfg, state: st, save: sv, canSee, ensureLineOfSight, now: Date.now, log: (m) => logs.push(m) })
  const engine = make()
  const scheduler = new Scheduler({ graceMs: 10000, idleAfterMs: 0 })
  const submit = (extra = {}) => scheduler.submit({ name: 'build', key: 'build', priority: PRIORITY.OUTING, onUserStop: 'park', abort: (r) => engine.abort(r), run: (ctx) => engine.run(ctx), ...extra })
  return { bot, engine, state, said, logs, dir, file, sh, save, scheduler, submit, cfg, canSee, ensureLineOfSight, make, origin: { ox, oy, oz }, ground: g, steps: () => engine.steps(), cx: ox + 2, cz: oz + 2 }
}

async function waitFor(cond, ms = 8000) { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition'); await wait(5) } }


// ---------------------------------------------------------------- shared assertions for the engine tests
const assert = require('node:assert')
const bp = blueprint
const nameAt = (r, x, y, z) => r.bot.blockAt(new Vec3(x, y, z)).name
const snapshot = (r) => {
  const o = r.origin, out = new Map()
  for (let x = o.ox - 9; x <= o.ox + 13; x++) for (let y = o.oy - 5; y <= o.oy + 18; y++) for (let z = o.oz - 9; z <= o.oz + 13; z++) out.set(`${x},${y},${z}`, nameAt(r, x, y, z))
  return out
}
const diff = (r, before) => { const out = []; for (const [k, v] of before) { const [x, y, z] = k.split(',').map(Number); const n = nameAt(r, x, y, z); if (n !== v) out.push({ x, y, z, was: v, now: n }) } return out }

// Everything a finished run has to satisfy, whatever route it took.
function assertClean(r, { allowDigs = true } = {}) {
  const o = r.origin, bot = r.bot
  const col = (p) => p.x === o.ox + 2 && p.z === o.oz + 2
  assert.deepStrictEqual(bot.losViolations, [], 'no placement or dig without line of sight'); assert.deepStrictEqual(bot.reachViolations, [])
  assert.deepStrictEqual(bot.walkedOnPillar, [], 'never walked while standing on the pillar')
  assert.deepStrictEqual(bot.lavaHeldWhileMoving, [])
  for (const p of bot.placements) {
    assert.ok(bp.allowedItem(p.name), `${p.name} is not on the whitelist`)
    assert.ok(bp.inBox(o, p), `${p.name} at ${p.x},${p.y},${p.z} is outside the volume`)
    assert.ok(p.los)
    if (p.name === 'cobblestone') assert.ok(col(p) || p.y < o.oy, 'cobblestone only in the pillar column or as foundation')
  }
  if (allowDigs) for (const d of bot.digLog) {
    assert.strictEqual(d.name, 'cobblestone', `only cobblestone is ever dug (dug ${d.name})`)
    assert.ok(col(d) && d.y >= o.oy && d.y <= o.oy + 11, 'only the pillar column')
    assert.match(d.held, /_pickaxe$/, 'dug with a pickaxe in hand')
  }
  const seen = new Map()
  for (const p of bot.placements) { if (p.name === 'cobblestone' && col(p)) continue; const k = `${p.x},${p.y},${p.z}`; assert.ok(!seen.has(k), `${k} placed twice`); seen.set(k, p.name) }
}

function assertBuilt(r, { furnished = true } = {}) {
  const o = r.origin, rel = (x, y, z) => nameAt(r, o.ox + x, o.oy + y, o.oz + z)
  for (const s of r.steps()) {
    if (s.optional && !furnished) continue
    assert.ok(bp.satisfied(s, nameAt(r, s.x, s.y, s.z)), `${s.key} should be ${s.block} but is ${nameAt(r, s.x, s.y, s.z)}`)
  }
  for (const c of [2, 6]) for (const [x, z] of [[2, 0], [2, 4], [0, 2], [4, 2]]) assert.strictEqual(rel(x, c, z), 'air', `window ${x},${c},${z}`)
  assert.strictEqual(rel(2, 0, 4), 'spruce_door'); assert.strictEqual(rel(2, 1, 4), 'spruce_door')
  for (const [x, z] of [[0, 0], [4, 0], [0, 4], [4, 4]]) for (let c = 0; c < 9; c++) assert.strictEqual(r.bot.blockAt(new Vec3(o.ox + x, o.oy + c, o.oz + z)).getProperties().axis, 'y')
  for (let y = 0; y <= 9; y++) assert.strictEqual(r.bot.blockAt(new Vec3(o.ox + 1, o.oy + y, o.oz + 1)).getProperties().facing, 'east')
  // the pillar column: open from the ground to the deck except the two plank fills
  for (let y = 0; y <= 11; y++) assert.strictEqual(rel(2, y, 2), y === 4 || y === 9 ? 'spruce_planks' : 'air', `pillar column y+${y}`)
  assert.strictEqual(rel(1, 4, 1), 'ladder'); assert.strictEqual(rel(1, 9, 1), 'ladder')
  assert.strictEqual(rel(-1, 9, -1), 'air'); assert.strictEqual(rel(5, 9, 5), 'air')       // the octagon's cut corners
  assert.strictEqual(r.state.pillar, null); assert.ok(r.state.finished)
}


module.exports = { nameAt, snapshot, diff, assertClean, assertBuilt, rig, extend, makeGround, fakeCtx, wait, waitFor, MATERIALS, FURNISHING, NONSOLID, PRIORITY, Scheduler, AbortError, mcData, blueprint, stateStore, createEngine, safehand, los, baseConfig, mockBot }
