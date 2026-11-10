// Test rig for brain/excavation: the shared mock bot plus digging, drops, crafting and a small rock room to carve.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { mockBot, mcData } = require('./mock-bot')
const { Scheduler, PRIORITY } = require('../brain/scheduler')
const safehand = require('../brain/safehand')
const stateStore = require('../brain/excavation/state')
const createEngine = require('../brain/excavation/engine')
const base = require('../brain/excavation/config.json')

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const tick = () => new Promise(r => setImmediate(r))
const DROPS = { stone: 'cobblestone', coal_ore: 'coal', grass_block: 'dirt', deepslate: 'cobbled_deepslate', iron_ore: 'raw_iron' }
const SMALL = { x1: -1069, x2: -1064, z1: 2299, z2: 2304 }        // 6x6 = four 3x3 sections, ids -1069,2299 -1069,2302 -1066,2299 -1066,2302

// adds digging / drops / crafting to the shared mock
function extend(bot) {
  const baseBlockAt = bot.blockAt
  bot.unloaded = new Set()
  bot.blockAt = (p) => {
    if (bot.unloaded.has(`${p.x},${p.y},${p.z}`)) return null
    const b = baseBlockAt(p)
    if (b.name === 'water' || b.name === 'lava') b.boundingBox = 'empty'
    b.diggable = b.name !== 'bedrock'
    b.digTime = () => 500
    return b
  }
  bot.digs = 0; bot.reach = 5.1; bot.noPickup = false; bot.gotoFails = null; bot.nextId = 1
  bot.canDigBlock = (b) => bot.entity.position.offset(0, 1.62, 0).distanceTo(b.position.offset(0.5, 0.5, 0.5)) <= bot.reach
  bot.stopDigging = () => bot.actions.push(['stopDigging'])
  bot.nearestEntity = (f = () => true) => Object.values(bot.entities).filter(f).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null
  bot.addItemEntity = (x, y, z, name = 'cobblestone', count = 1) => { const id = bot.nextId++; bot.entities[id] = { id, name: 'item', itemName: name, itemCount: count, position: new Vec3(x, y, z) }; return id }
  const canHold = (name) => bot.inventory.emptySlotCount() > 0 || bot.inventory.items().some(i => i.name === name && i.count < 64)
  bot.pickup = () => {
    if (bot.noPickup) return
    for (const [id, e] of Object.entries(bot.entities)) {
      if (e.name === 'item' && e.position.distanceTo(bot.entity.position.offset(0, 0.9, 0)) <= 1.5 && canHold(e.itemName)) { bot.give(e.itemName, e.itemCount); delete bot.entities[id] }
    }
  }
  // ---- line of sight: a ray test the modules must satisfy; breaking, opening, placing and sleeping through a wall is recorded and refused ----
  const NONSOLID = /^(air|cave_air|water|lava|wheat|carrots|potatoes|beetroots|sugar_cane|bamboo|bamboo_sapling|short_grass|torch)$/
  bot.world = {
    raycast(from, dir, range) {
      for (let t = 0; t <= range; t += 0.02) {
        const bx = Math.floor(from.x + dir.x * t), by = Math.floor(from.y + dir.y * t), bz = Math.floor(from.z + dir.z * t)
        const nm = baseBlockAt(new Vec3(bx, by, bz)).name
        if (!NONSOLID.test(nm)) return { position: new Vec3(bx, by, bz), name: nm }
      }
      return null
    }
  }
  bot.losFrom = (from, block) => {              // independent of the module under test: centre or an inset face centre must be reached first
    const p = block.position
    const pts = [[0.5, 0.5, 0.5], [0.95, 0.5, 0.5], [0.05, 0.5, 0.5], [0.5, 0.95, 0.5], [0.5, 0.05, 0.5], [0.5, 0.5, 0.95], [0.5, 0.5, 0.05]]
    return pts.some(([a, b, c]) => {
      const to = new Vec3(p.x + a, p.y + b, p.z + c), d = to.minus(from), r = d.norm()
      const hit = bot.world.raycast(from, d.scaled(1 / r), r)
      return !hit || hit.position.equals(p)
    })
  }
  bot.losViolations = []; bot.enforceLos = true
  bot.assertLos = (block, what) => {
    if (!bot.enforceLos) return
    if (!bot.losFrom(bot.entity.position.offset(0, 1.62, 0), block)) {
      bot.losViolations.push(`${what} ${block.name} at ${block.position}`)
      throw new Error(`NO LINE OF SIGHT: ${what} ${block.name} at ${block.position}`)
    }
  }
  const baseOpen = bot.openContainer
  bot.openContainer = async (block) => { bot.assertLos(block, 'open'); return baseOpen(block) }
  // ---- a little physics, enough for jump-and-place pillars: jump = up 1.25 for 70 ms, then land on the highest solid block under the feet ----
  const solidAt = (x, y, z) => !NONSOLID.test(baseBlockAt(new Vec3(x, y, z)).name)
  const land = () => {
    const x = Math.floor(bot.entity.position.x), z = Math.floor(bot.entity.position.z)
    for (let yy = Math.floor(bot.entity.position.y + 0.01); yy > 0; yy--) if (solidAt(x, yy, z)) { bot.entity.position.y = yy + 1; bot.entity.onGround = true; return }
  }
  bot.fallLagMs = 0                   // tests: how long the bot stays "airborne" after the block under it went (real falls take a moment)
  const fallIfUnsupported = () => {
    const p = bot.entity.position
    if (Math.abs(p.y - Math.round(p.y)) < 1e-6 && !solidAt(Math.floor(p.x), Math.round(p.y) - 1, Math.floor(p.z))) {
      land()
      if (bot.fallLagMs) { bot.entity.onGround = false; setTimeout(() => { bot.entity.onGround = true }, bot.fallLagMs) }
    }
  }
  bot.entity.onGround = true; bot.physics = true; bot.maxFeetY = 0
  bot.look = async () => {}
  const baseSetControl = bot.setControlState
  let jumping = false
  bot.setControlState = (k, v) => { baseSetControl(k, v); if (k === 'jump' && v && bot.physics) bot.jumpLoop() }
  bot.jumpLoop = async () => {
    if (jumping) return
    jumping = true
    while (bot.controlStates.jump) {
      if (bot.entity.onGround) { bot.entity.onGround = false; bot.entity.position.y += 1.25; await new Promise(r => setTimeout(r, 120)); land()   /* hangs at the top like a real jump (above +1.0 for ~6 ticks) */ }
      else await new Promise(r => setTimeout(r, 10))
    }
    jumping = false
  }
  bot.placeBlock = async (ref, face) => {
    bot.assertLos(ref, 'place on')
    const held = bot.heldItem; if (!held) throw new Error('nothing in hand')
    const t = new Vec3(ref.position.x + face.x, ref.position.y + face.y, ref.position.z + face.z), p = bot.entity.position
    if (Math.floor(p.x) === t.x && Math.floor(p.z) === t.z && p.y < t.y + 1 - 1e-6 && p.y + 1.8 > t.y) throw new Error('entity in the way')
    if (baseBlockAt(t).name !== 'air') throw new Error('target cell is not empty')
    bot.actions.push(['place', held.name, t.x, t.y, t.z]); bot.maxFeetY = Math.max(bot.maxFeetY, p.y)
    bot.setBlock(t.x, t.y, t.z, held.name); bot.take(held.name, 1)
    if (held.name === 'chest') bot.addChest(t.x, t.y, t.z, 27, {})          // a placed chest is a real container
  }
  bot.failDig = null                  // tests: (block) => true makes that dig throw (the block stays)
  bot.dig = async (b, force) => {
    bot.assertLos(b, 'dig')
    if (bot.entity.onGround === false) bot.digsWhileAirborne = (bot.digsWhileAirborne || 0) + 1
    if (bot.digDelayMs) await new Promise(r => setTimeout(r, bot.digDelayMs))
    if (bot.failDig && bot.failDig(b)) { bot.actions.push(['dig-failed', b.position.x, b.position.y, b.position.z]); throw new Error('Digging aborted') }
    const { x, y, z } = b.position
    bot.actions.push(['dig', b.name, x, y, z]); bot.digs++
    const name = DROPS[b.name] || b.name
    bot.setBlock(x, y, z, 'air')
    // the drop falls to the first solid block under it (items do not hang in the air), merges with a stack of the same item close by
    let fy = y; while (fy > 1 && !solidAt(x, fy - 1, z)) fy--
    const at = new Vec3(x + 0.5, fy + 0.25, z + 0.5)
    const near = Object.values(bot.entities).find(e => e.name === 'item' && e.itemName === name && e.position.distanceTo(at) < 1.5 && Math.abs(e.position.y - at.y) < 0.3)   // same support only: a stack still hovering over a dug-out block must fall on its own
    if (near) near.itemCount++; else bot.addItemEntity(at.x, at.y, at.z, name, 1)
    fallIfUnsupported()
    if (bot.onDig) bot.onDig(bot.digs, b)
    await tick()
  }
  const baseGoto = bot.tryGoto
  // a walk ends on the ground: if the spot is floating in open air (a drop lying high up, say) the bot falls to the next solid block
  const settleAfterGoto = () => {
    const p = bot.entity.position, x = Math.floor(p.x), z = Math.floor(p.z)
    let y = Math.floor(p.y + 0.01)
    if (solidAt(x, y, z)) return                                  // inside a solid block (the mock teleports onto chest cells): leave it
    let d = 0
    while (d < 8 && !solidAt(x, y - 1 - d, z)) d++
    if (d > 0 && d < 8) p.y = y - d                              // a short drop onto a block; in open nothing (sparse test worlds) the bot stays put
  }
  bot.enableLookAt = () => {          // pathfinder's GoalLookAtBlock: stands somewhere with a clear line to the block
    bot.goals.GoalLookAtBlock = class { constructor(pos, world, opts) { this.pos = pos; this.opts = opts } }
  }
  const spotWithSight = (block) => {
    for (let r = 1; r <= 3; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (const dy of [0, -1, 1]) {
      const feet = block.position.offset(dx, dy, dz)
      if (baseBlockAt(feet).name !== 'air' || baseBlockAt(feet.offset(0, 1, 0)).name !== 'air') continue
      if (bot.losFrom(feet.offset(0.5, 1.62, 0.5), block)) return feet.offset(0.5, 0, 0.5)
    }
    return null
  }
  bot.arriveAt = null                 // tests: (goal, label) => Vec3 | null, where the walk ends instead of the default spot next to the goal
  bot.tryGoto = async (goal, label = '', ms) => {
    if (bot.gotoFails && bot.gotoFails(goal, label)) { bot.actions.push(['goto-failed', label]); return { ok: false, err: 'no path' } }
    if (goal.pos && bot.goals.GoalLookAtBlock && goal instanceof bot.goals.GoalLookAtBlock) {
      bot.actions.push(['goto', label, goal.pos.x, goal.pos.y, goal.pos.z, 'lookat'])
      const spot = spotWithSight(bot.blockAt(goal.pos))
      if (!spot) return { ok: false, err: 'no spot with a clear line' }
      bot.entity.position = spot; settleAfterGoto(); bot.pickup(); await tick(); return { ok: true }
    }
    const arrive = bot.arriveAt && bot.arriveAt(goal, label)
    if (arrive) { bot.actions.push(['goto', label, goal.x, goal.y, goal.z]); bot.entity.position = arrive; settleAfterGoto(); bot.pickup(); await tick(); return { ok: true } }
    const r = await baseGoto(goal, label, ms); settleAfterGoto(); bot.pickup(); await tick(); return r
  }
  bot.findBlock = ({ matching, maxDistance }) => { const p = bot.findBlocks({ matching, maxDistance, count: 1 })[0]; return p ? bot.blockAt(p) : null }
  bot.recipesFor = (id) => [{ result: id }]
  bot.craft = async (rec, n) => {
    const name = mcData.items[rec.result].name
    for (let i = 0; i < n; i++) {
      if (name === 'stick') { bot.take(bot.inventory.items().find(s => s.name.endsWith('_planks')).name, 2); bot.give('stick', 4) }
      else if (name === 'stone_pickaxe') { bot.take('cobblestone', 3); bot.take('stick', 2); bot.give('stone_pickaxe', 1) }
      else throw new Error('unexpected craft ' + name)
    }
  }
  bot.dugAt = () => bot.actions.filter(a => a[0] === 'dig').map(a => `${a[2]},${a[3]},${a[4]}`)
  return bot
}

// Rock around a carved room: stone y135..150 everywhere near the box, open y136-137 inside it, stone-brick hall at y151-153.
function buildRoom(bot, box = SMALL, { hall = true } = {}) {
  const pad = 3
  for (let x = box.x1 - pad; x <= box.x2 + pad; x++) for (let z = box.z1 - pad; z <= box.z2 + pad; z++) {
    for (let y = 135; y <= 150; y++) {
      const inside = x >= box.x1 && x <= box.x2 && z >= box.z1 && z <= box.z2
      if (inside && (y === 136 || y === 137)) continue
      bot.setBlock(x, y, z, 'stone')
    }
    if (hall) for (let y = 151; y <= 153; y++) bot.setBlock(x, y, z, 'stone_bricks')
  }
}

// A world that mirrors room-map.txt (y131..161): '#' = stone, '.'/'@' = air, '~' = water.
function buildFromMap(bot, mapFile) {
  const layers = {}; let cur = null
  for (const l of fs.readFileSync(mapFile, 'utf8').split(/\r?\n/)) {
    const m = /^--- y=(\d+) /.exec(l); if (m) { cur = +m[1]; layers[cur] = []; continue }
    if (cur !== null && !l.startsWith('Room scan') && !l.startsWith('Legend')) layers[cur].push(l)
  }
  for (const [y, rows] of Object.entries(layers)) for (let zi = 0; zi < rows.length; zi++) for (let xi = 0; xi < rows[zi].length; xi++) {
    const c = rows[zi][xi]
    if (c === '#') bot.setBlock(-1086 + xi, +y, 2298 + zi, 'stone')
    else if (c === '~') bot.setBlock(-1086 + xi, +y, 2298 + zi, 'water')
  }
}

const fromMapBox = (o) => (o && o.fromMap ? base.box : SMALL)
const fakeCtx = (over = {}) => ({ state: {}, resumed: false, aborted: false, checkpoint() {}, progress() {}, onAbort: () => () => {}, sleep: wait, ...over })

function rig({ box = fromMapBox(arguments[0]), config = {}, hall = true, pos, pickaxe = true, inputs = [], fromMap = null, now } = {}) {
  const bot = extend(mockBot({ pos: pos || [box.x1 + 2, 136, box.z1 + 2] }))
  if (fromMap) buildFromMap(bot, fromMap); else buildRoom(bot, box, { hall })
  if (pickaxe) bot.give('stone_pickaxe', 1)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exc-'))
  const file = path.join(dir, 'excavation-state.json'), legacyFile = path.join(dir, 'exc-state.json')
  const said = []
  const nav = { stops: 0 }
  const sh = safehand({ bot })
  const state = stateStore.load({ file, legacyFile })
  const save = () => stateStore.save(file, state)
  const cfg = { ...base, box, digTo: 141, ...config, limits: { ...base.limits, ...(config.limits || {}) }, pillar: { ...base.pillar, stepMs: 8, landMs: 50, ...(config.pillar || {}) } }
  const engine = createEngine({ bot, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, safehand: sh, stopNav: () => { nav.stops++ }, config: cfg, state, save, inputs, now: now || Date.now })
  const scheduler = new Scheduler({ graceMs: 300, idleAfterMs: 0 })
  const submit = (extra = {}) => scheduler.submit({ name: 'excavation', key: 'excavation', priority: PRIORITY.EXCAVATE, onUserStop: 'park', abort: (r) => engine.abort(r), run: (ctx) => engine.run(ctx), ...extra })
  return { bot, engine, state, said, dir, file, legacyFile, scheduler, submit, nav, cfg, sh, save }
}

async function waitFor(cond, ms = 4000) { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition'); await wait(5) } }
// the world as the live room is: these 3x3 sections (ids "gx,gz") are already carved out
function carve(bot, ids, y0 = 138, y1 = 141) {
  for (const id of ids) { const [gx, gz] = id.split(',').map(Number); for (let x = gx; x < gx + 3; x++) for (let z = gz; z < gz + 3; z++) for (let y = y0; y <= y1; y++) if (bot.blockAt(new Vec3(x, y, z)).name === 'stone') bot.setBlock(x, y, z, 'air') }
}
const cells = (box = SMALL, y0 = 138, y1 = 141) => { const out = []; for (let x = box.x1; x <= box.x2; x++) for (let z = box.z1; z <= box.z2; z++) for (let y = y0; y <= y1; y++) out.push(`${x},${y},${z}`); return out }

module.exports = { carve, rig, extend, buildRoom, buildFromMap, fakeCtx, waitFor, cells, wait, SMALL, base, PRIORITY, Scheduler }
