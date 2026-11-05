// Test rig for brain/mining: the shared mock bot plus a rock world, digging with drops, gravity, a real walkability search for
// tryGoto (the pathfinder never digs), a raycast that sees through air/liquid/torches only, and an independent line-of-sight audit
// of every dig (bot.losViolations) that the module under test cannot influence.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { mockBot, mcData } = require('./mock-bot')
const { Scheduler, PRIORITY } = require('../brain/scheduler')
const safehand = require('../brain/safehand')
const stateStore = require('../brain/mining/state')
const createEngine = require('../brain/mining/engine')
const base = require('../brain/mining/config.json')

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const tick = () => new Promise(r => setImmediate(r))
const TRANSPARENT = /^(air|cave_air|water|lava|torch)$/
const DROPS = { stone: 'cobblestone', deepslate: 'cobbled_deepslate', diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond', iron_ore: 'raw_iron', coal_ore: 'coal', gold_ore: 'raw_gold', redstone_ore: 'redstone', gravel: 'gravel', dirt: 'dirt', grass_block: 'dirt', sand: 'sand', andesite: 'andesite' }
const GRAV = new Set(['gravel', 'sand'])
const k = (x, y, z) => `${x},${y},${z}`

function extend(bot) {
  const baseBlockAt = bot.blockAt
  const nameAt = (x, y, z) => baseBlockAt(new Vec3(x, y, z)).name
  bot.unloaded = new Set()
  bot.blockAt = (p) => {
    if (bot.unloaded.has(k(p.x, p.y, p.z))) return null
    const b = baseBlockAt(p)
    if (/^(water|lava|torch)$/.test(b.name)) b.boundingBox = 'empty'
    if (bot.lightAt) b.light = bot.lightAt(p.x, p.y, p.z)
    b.diggable = b.name !== 'bedrock'
    b.digTime = () => 500
    return b
  }
  bot.digs = 0; bot.reach = 4.5; bot.noPickup = false; bot.nextId = 1; bot.visited = []; bot.digLog = []
  bot.canDigBlock = (b) => bot.entity.position.offset(0, 1.62, 0).distanceTo(b.position.offset(0.5, 0.5, 0.5)) <= bot.reach
  bot.stopDigging = () => bot.actions.push(['stopDigging'])
  bot.nearestEntity = (f = () => true) => Object.values(bot.entities).filter(f).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null
  bot.addItemEntity = (x, y, z, name, count = 1) => { const id = bot.nextId++; bot.entities[id] = { id, name: 'item', itemName: name, itemCount: count, position: new Vec3(x, y, z) }; return id }
  const canHold = (name) => bot.inventory.emptySlotCount() > 0 || bot.inventory.items().some(i => i.name === name && i.count < 64)
  bot.pickup = (radius = 1.5) => {
    if (bot.noPickup) return
    for (const [id, e] of Object.entries(bot.entities)) {
      if (e.name === 'item' && e.position.distanceTo(bot.entity.position.offset(0, 0.5, 0)) <= radius && canHold(e.itemName)) { bot.give(e.itemName, e.itemCount); delete bot.entities[id] }
    }
  }
  // raycast like prismarine-world: liquids and air have no shape, a ladder is a thin panel (3/16) on the wall it hangs on, everything else stops the ray.
  // With a matcher (WorldSync semantics) the first block the matcher accepts is the hit, whatever its shape.
  const PANEL = { west: ['x', 0.8125, 1], east: ['x', 0, 0.1875], north: ['z', 0.8125, 1], south: ['z', 0, 0.1875] }
  bot.world = {
    raycast(from, dir, range, matcher) {
      for (let t = 0; t <= range; t += 0.04) {
        const px = from.x + dir.x * t, py = from.y + dir.y * t, pz = from.z + dir.z * t
        const x = Math.floor(px), y = Math.floor(py), z = Math.floor(pz)
        const nm = nameAt(x, y, z)
        if (matcher) { if (nm !== 'air' && matcher(bot.blockAt(new Vec3(x, y, z)))) return { position: new Vec3(x, y, z), name: nm }; continue }
        if (nm === 'ladder') {
          const pr = PANEL[(baseBlockAt(new Vec3(x, y, z)).getProperties() || {}).facing]
          const fr = pr ? (pr[0] === 'x' ? px - x : pz - z) : 0
          if (pr && fr >= pr[1] && fr <= pr[2]) return { position: new Vec3(x, y, z), name: nm }
          continue
        }
        if (!TRANSPARENT.test(nm)) return { position: new Vec3(x, y, z), name: nm }
      }
      return null
    }
  }
  bot.noRaycast = () => { bot.world = {} }
  // an audit that does not use the module's own ray test: centre or an inset face centre must be reached first
  bot.losFrom = (from, block, opts = {}) => {
    const p = block.position
    const pts = [[0.5, 0.5, 0.5], [0.95, 0.5, 0.5], [0.05, 0.5, 0.5], [0.5, 0.95, 0.5], [0.5, 0.05, 0.5], [0.5, 0.5, 0.95], [0.5, 0.5, 0.05]]
    return pts.some(([a, b, c]) => {
      const to = new Vec3(p.x + a, p.y + b, p.z + c), d = to.minus(from), r = d.norm()
      const hit = opts.ignoreLadders ? bot.world.raycast(from, d.scaled(1 / r), r, (b) => b.boundingBox === 'block' && b.name !== 'ladder') : bot.world.raycast(from, d.scaled(1 / r), r)
      return !hit || hit.position.equals(p)
    })
  }
  bot.losViolations = []
  bot.assertLos = (block, what, opts = {}) => {
    if (!bot.losFrom(bot.entity.position.offset(0, 1.62, 0), block, opts)) {
      bot.losViolations.push(`${what} ${block.name} at ${block.position}`)
      throw new Error(`NO LINE OF SIGHT: ${what} ${block.name} at ${block.position}`)
    }
  }
  const baseOpen = bot.openContainer
  bot.openContainer = async (block) => { bot.assertLos(block, 'open'); return baseOpen(block) }
  // gravity: sand/gravel above a removed block falls until it rests on something
  const settle = (x, y, z) => {
    for (let yy = y + 1; yy < y + 12; yy++) {
      const nm = nameAt(x, yy, z)
      if (!GRAV.has(nm)) break
      let ty = yy
      while (ty - 1 >= -70 && /^(air|cave_air)$/.test(nameAt(x, ty - 1, z))) ty--
      if (ty !== yy) { bot.setBlock(x, yy, z, 'air'); bot.setBlock(x, ty, z, nm) }
    }
  }
  bot.dig = async (b) => {
    bot.assertLos(b, 'dig', { ignoreLadders: true })      // the thin ladder panels of a shaft are not a wall in the way
    if (!bot.canDigBlock(b)) throw new Error('block out of reach')
    const { x, y, z } = b.position
    bot.digs++
    bot.digLog.push({ x, y, z, name: b.name, from: bot.entity.position.clone() })
    bot.actions.push(['dig', b.name, x, y, z])
    const drop = DROPS[b.name] || b.name
    bot.setBlock(x, y, z, 'air')
    bot.addItemEntity(x + 0.5, y + 0.25, z + 0.5, drop, 1)
    settle(x, y, z)
    bot.pickup(2.6)
    await tick()
  }
  bot.dugAt = () => bot.digLog.map(d => k(d.x, d.y, d.z))
  bot.recipesFor = (id) => [{ result: id }]
  // physics stand-in for the exit tests: holding jump on a ladder climbs it; holding jump elsewhere hops one block and lands on whatever is solid below
  const baseSet = bot.setControlState
  let climbTimer = null, hopTimer = null
  const feetCell = () => ({ x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y + 0.01), z: Math.floor(bot.entity.position.z) })
  // on a ladder with no key pressed the bot slides down (jump climbs, sneak or forward hold it)
  const slide = setInterval(() => {
    const cs = bot.controlStates || {}
    if (cs.jump || cs.sneak || cs.forward || cs.back || cs.left || cs.right) return
    const p = bot.entity.position, c = feetCell()
    if (nameAt(c.x, c.y, c.z) !== 'ladder') return
    if (nameAt(c.x, Math.floor(p.y - 0.2), c.z) === 'ladder') p.y = Math.max(p.y - 0.15, Math.floor(p.y - 0.2))
  }, 20)
  if (slide.unref) slide.unref()
  bot.setControlState = (key, val) => {
    baseSet(key, val)
    if (key !== 'jump') return
    if (!val) { clearInterval(climbTimer); climbTimer = null; return }
    const c = feetCell()
    if (nameAt(c.x, c.y, c.z) === 'ladder') {
      clearInterval(climbTimer)
      climbTimer = setInterval(() => {
        const p = bot.entity.position, cc = feetCell()
        if (nameAt(cc.x, Math.floor(p.y + 0.3), cc.z) !== 'ladder') { p.y = Math.ceil(p.y); clearInterval(climbTimer); climbTimer = null; return }
        p.y += 0.2
      }, 10)
      if (climbTimer.unref) climbTimer.unref()
    } else {
      clearTimeout(hopTimer)
      bot.entity.position.y += 1.1
      hopTimer = setTimeout(() => {
        const p = bot.entity.position, cc = feetCell()
        let y = Math.floor(p.y + 0.01)
        while (y > -60 && /^(air|cave_air|torch|ladder)$/.test(nameAt(cc.x, y - 1, cc.z))) y--
        p.y = y
      }, 60)
      if (hopTimer.unref) hopTimer.unref()
    }
  }
  // torches are the only thing that may be placed: a line-of-sight audit on the block they stand on, the held item must be a torch, the cell must be air
  bot.placed = []; bot.lightAt = null
  bot.placeBlock = async (ref, face) => {
    const held = bot.heldItem && bot.heldItem.name
    bot.assertLos(ref, 'place on', { ignoreLadders: held === 'ladder' || held === 'cobblestone' })        // the thin ladder panels of the shaft are not a wall in the way
    const dest = ref.position.plus(face)
    if (held !== 'torch' && held !== 'chest' && held !== 'ladder' && held !== 'cobblestone') throw new Error('placeBlock: only torches, the work-site chest, shaft ladders and shaft support blocks may be placed (holding ' + held + ')')
    if (!/^(air|cave_air)$/.test(nameAt(dest.x, dest.y, dest.z))) throw new Error('placeBlock: cell not empty')
    if (held === 'ladder' && (face.y !== 0 || ref.boundingBox !== 'block')) throw new Error('placeBlock: a ladder needs a wall')
    if (bot.entity.position.offset(0, 1.62, 0).distanceTo(ref.position.offset(0.5, 1, 0.5)) > 5) throw new Error('placeBlock: too far')
    if (held === 'chest') bot.addChest(dest.x, dest.y, dest.z, 27)
    else if (held === 'ladder') bot.setBlock(dest.x, dest.y, dest.z, 'ladder', { facing: face.x < 0 ? 'west' : face.x > 0 ? 'east' : face.z < 0 ? 'north' : 'south' })
    else if (held === 'cobblestone') bot.setBlock(dest.x, dest.y, dest.z, 'cobblestone')
    else bot.setBlock(dest.x, dest.y, dest.z, 'torch')
    bot.take(held, 1)
    bot.placed.push([dest.x, dest.y, dest.z, held])
    await tick()
  }

  // ----- walkability (the pathfinder never digs or places) -----
  const open = (x, y, z) => /^(air|cave_air|torch|ladder)$/.test(nameAt(x, y, z))
  const solid = (x, y, z) => !/^(air|cave_air|water|lava|torch|ladder)$/.test(nameAt(x, y, z))
  const climb = (x, y, z) => nameAt(x, y, z) === 'ladder'
  const standable = (x, y, z) => open(x, y, z) && open(x, y + 1, z) && (solid(x, y - 1, z) || climb(x, y, z))
  bot.standable = standable
  function neighbours(c) {
    const out = []
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = c.x + dx, nz = c.z + dz
      for (const dy of [0, -1, -2, -3, 1]) {
        const ny = c.y + dy
        if (!standable(nx, ny, nz)) continue
        let ok = true
        if (dy <= 0) { for (let yy = ny; yy <= c.y + 1; yy++) if (!open(nx, yy, nz)) ok = false }
        else ok = open(nx, c.y + 2, c.z) && open(nx, ny, nz) && open(nx, ny + 1, nz)
        if (ok) { out.push({ x: nx, y: ny, z: nz }); break }
      }
    }
    for (const dy of [1, -1]) {                                      // up and down a ladder
      const ny = c.y + dy
      if (standable(c.x, ny, c.z) && (climb(c.x, c.y, c.z) || climb(c.x, ny, c.z))) out.push({ x: c.x, y: ny, z: c.z })
    }
    return out
  }
  function findPath(goal) {
    const me = bot.entity.position, start = { x: Math.floor(me.x), y: Math.floor(me.y + 0.01), z: Math.floor(me.z) }
    const isGoal = goal.r !== undefined && !(goal instanceof bot.goals.GoalBlock)
      ? (c) => Math.hypot(c.x + 0.5 - (goal.x + 0.5), c.y - goal.y, c.z + 0.5 - (goal.z + 0.5)) <= goal.r
      : (c) => c.x === goal.x && c.y === goal.y && c.z === goal.z
    const seen = new Set([k(start.x, start.y, start.z)]), q = [start]
    for (let i = 0; i < q.length && q.length < 40000; i++) {
      const c = q[i]
      if (isGoal(c) && standable(c.x, c.y, c.z)) return c
      for (const n of neighbours(c)) { const key = k(n.x, n.y, n.z); if (!seen.has(key)) { seen.add(key); q.push(n) } }
    }
    return null
  }
  bot.gotoFails = null
  bot.tryGoto = async (goal, label = '', ms) => {
    if (bot.gotoFails && bot.gotoFails(goal, label)) { bot.actions.push(['goto-failed', label]); return { ok: false, err: 'no path' } }
    if (bot.heldItem && bot.heldItem.name === 'lava_bucket') bot.lavaHeldWhileMoving.push(label)
    const dest = findPath(goal)
    if (!dest) { bot.actions.push(['goto-failed', label]); return { ok: false, err: 'no path' } }
    bot.actions.push(['goto', label, dest.x, dest.y, dest.z])
    bot.entity.position = new Vec3(dest.x + 0.5, dest.y, dest.z + 0.5)
    bot.visited.push(k(dest.x, dest.y, dest.z))
    bot.pickup()
    await tick()
    return { ok: true, secs: 0.1 }
  }
  return bot
}

// ---- world builders ----
function fillRock(bot, { x1, x2, y1, y2, z1, z2 }, name = 'stone') {
  for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) bot.setBlock(x, y, z, name)
}
function carve(bot, cells) { for (const [x, y, z] of cells) bot.setBlock(x, y, z, 'air') }
const hall = (x, y, z) => [[x, y, z], [x, y + 1, z]]

// A rock mass around a one-cell pocket at (0, y, 0) (floor solid), bot standing in it.
const ROCK = { x1: -14, x2: 30, y1: -64, y2: -40, z1: -24, z2: 24 }
function underground(bot, { y = -58, rock = ROCK, name = 'stone' } = {}) {
  fillRock(bot, rock, name)
  carve(bot, hall(0, y, 0))
  bot.entity.position = new Vec3(0.5, y, 0.5)
}

const fakeCtx = (over = {}) => ({ state: {}, resumed: false, aborted: false, checkpoint() {}, progress() {}, onAbort: () => () => {}, sleep: wait, ...over })

const SMALL = { pattern: { spacing: 3, trunkLength: 6, branchLength: 4 } }

function rig({ torches = false, torchCount = 0, y = -58, pos = null, pickaxe = 'iron_pickaxe', world = true, config = {}, deposit = null, dispatch = null, waypointsList = [], recordWaypoint = true, rock, hostile = null } = {}) {
  const bot = extend(mockBot({ pos: pos || [0.5, y, 0.5] }))
  bot.lavaHeldWhileMoving = bot.lavaHeldWhileMoving || []
  bot.goals = { ...bot.goals }
  bot.goals.GoalNear = class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } }
  bot.goals.GoalBlock = class { constructor(x, y, z) { Object.assign(this, { x, y, z }) } }
  bot.heldItem = null
  if (world) underground(bot, { y, rock })
  if (pickaxe) bot.give(pickaxe, 1)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mining-'))
  const file = path.join(dir, 'mining-state.json')
  const said = []
  const nav = { stops: 0 }
  const sh = safehand({ bot })
  const state = stateStore.load({ file })
  const save = () => stateStore.save(file, state)
  const cfg = { ...base, ...SMALL, ...config, limits: { ...base.limits, ...(config.limits || {}) }, sight: { ...base.sight, ...(config.sight || {}) }, protect: config.protect || base.protect }
  const added = [], removed = []
  const waypoints = { list: () => waypointsList, add: (name, p) => { added.push([name, p]); return recordWaypoint ? name : null }, remove: (name) => { removed.push(name); return true } }
  const events = new (require('events'))()
  const parks = []
  events.on('park', (e) => parks.push(e))
  const logs = []
  const calls = { dispatch: [], deposit: 0 }
  if (torchCount) bot.give('torch', torchCount)
  const torchHelper = torches ? require('../brain/lighting/torches')({ bot, canSee: (b) => require('../brain/los').canSee(bot, b), sleep: () => Promise.resolve() }) : null
  const scheduler = new Scheduler({ graceMs: 300, idleAfterMs: 0 })
  const engine = createEngine({
    bot, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, safehand: sh, stopNav: () => { nav.stops++ }, config: cfg, state, save,
    deposit: deposit ? async (o) => { calls.deposit++; return deposit(o) } : null,
    dispatch: dispatch ? (u, t) => { calls.dispatch.push(t); return dispatch(u, t) } : null,
    scheduler, owner: 'OGWO', waypoints, torches: torchHelper, events, now: Date.now, log: (m) => logs.push(m)
  })
  const submit = (extra = {}) => scheduler.submit({ name: 'mining', key: 'mining', priority: PRIORITY.EXCAVATE, onUserStop: 'park', abort: (r) => engine.abort(r), run: (ctx) => engine.run(ctx), ...extra })
  return { bot, engine, state, said, dir, file, scheduler, submit, nav, cfg, sh, save, added, removed, calls, events, parks, logs }
}

// run the job to its end (done or parked) without the scheduler
async function runJob(r, ore, amount, ctxOver = {}) {
  r.engine.begin(ore, amount)
  return r.engine.run(fakeCtx(ctxOver))
}
async function waitFor(cond, ms = 6000) { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition'); await wait(5) } }

module.exports = { rig, extend, underground, fillRock, carve, hall, runJob, fakeCtx, waitFor, wait, tick, k, ROCK, SMALL, PRIORITY, Scheduler, base, mcData, Vec3 }
