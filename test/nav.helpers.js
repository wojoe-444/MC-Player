// Offline simulation for brain/nav tests: a voxel world made of REAL prismarine-block blocks, the REAL mineflayer-pathfinder
// planner and executor, and the REAL prismarine-physics engine, driven tick by tick in virtual time (no server, no sockets).
//
//   const sim = makeSim({ pos: [0.5, 64, 0.5] })
//   sim.floor(-10, -10, 20, 20, 63)                       // stone floor
//   sim.door(5, 64, 5, { facing: 'east' })                // two-block door
//   const r = await sim.goto(new goals.GoalNear(10, 64, 5, 1), { maxTicks: 600 })
//
// Physics ticks are 50 ms of game time each; pathfinder's wall-clock stuck timer is bridged to virtual time.
const EventEmitter = require('events')
const { Vec3 } = require('vec3')
const perfHooks = require('perf_hooks')
const mcData = require('minecraft-data')('1.21.6')
const Block = require('prismarine-block')(mcData)
const { Physics, PlayerState } = require('prismarine-physics')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const strProps = (props) => Object.fromEntries(Object.entries(props || {}).map(([k, v]) => [k, String(v)]))
const isOpenable = (n) => (/_(door|trapdoor|fence_gate)$/.test(n)) && !n.startsWith('iron_')

function makeSim(opts = {}) {
  const bot = new EventEmitter()
  const sim = { bot, locked: new Set(), ticks: 0, events: [], lookCalls: 0, interactions: [], maxStep: 0, bounds: opts.bounds || { x0: -40, x1: 80, y0: 0, y1: 120, z0: -40, z1: 80 } }
  bot.setMaxListeners(100)
  bot.registry = mcData
  bot.version = '1.21.6'
  bot.supportFeature = () => false
  bot.game = { dimension: 'minecraft:overworld', minY: -64, height: 384, gameMode: 'survival' }
  bot.username = 'OzoGo444'
  bot.health = 20
  bot.food = 20
  bot.entities = {}
  bot.players = {}
  bot.heldItem = null
  bot.isSleeping = false
  bot.time = { timeOfDay: 1000 }
  bot.jumpTicks = 0
  bot.jumpQueued = false
  const invItems = []
  bot.inventory = { slots: [], items: () => invItems.slice() }
  sim.give = (name, count = 1) => { const it = { name, count, type: (mcData.itemsByName[name] || {}).id }; invItems.push(it); return it }
  bot.entity = {
    id: 1, type: 'player', username: bot.username, position: new Vec3(...(opts.pos || [0.5, 64, 0.5])), velocity: new Vec3(0, 0, 0),
    onGround: false, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
    elytraFlying: false, yaw: opts.yaw || 0, pitch: 0, height: 1.8, width: 0.6, effects: {}, attributes: {}
  }
  bot.controlState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  bot.setControlState = (k, v) => { if (!(k in bot.controlState)) throw new Error('invalid control ' + k); if (bot.controlState[k] === v) return; bot.controlState[k] = v; if (k === 'jump' && v) bot.jumpQueued = true }
  bot.getControlState = (k) => bot.controlState[k]
  bot.clearControlStates = () => { for (const k of Object.keys(bot.controlState)) bot.setControlState(k, false) }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.lookAt = async (p) => {
    sim.lookCalls++
    const d = p.minus(bot.entity.position.offset(0, 1.62, 0))
    bot.entity.yaw = Math.atan2(-d.x, -d.z); bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
  }
  bot.stopDigging = () => {}
  bot.dig = async () => { throw new Error('digging is off in nav tests') }
  bot.placeBlock = async () => { throw new Error('placing is off in nav tests') }
  bot.equip = async (item) => { bot.heldItem = typeof item === 'string' ? invItems.find(i => i.name === item) : item; bot.emit('heldItemChanged', bot.heldItem) }
  bot.unequip = async () => { bot.heldItem = null; bot.emit('heldItemChanged', null) }

  // ---------- world ----------
  const blocks = new Map(), cache = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  const inBounds = (x, y, z) => x >= sim.bounds.x0 && x <= sim.bounds.x1 && y >= sim.bounds.y0 && y <= sim.bounds.y1 && z >= sim.bounds.z0 && z <= sim.bounds.z1
  sim.set = (x, y, z, name, props = {}) => {
    const old = bot.blockAt(new Vec3(x, y, z))
    blocks.set(key(x, y, z), { name, props: strProps(props) }); cache.delete(key(x, y, z))
    return old
  }
  sim.clear = (x, y, z) => { blocks.delete(key(x, y, z)); cache.delete(key(x, y, z)) }
  sim.fill = (x0, y0, z0, x1, y1, z1, name, props) => {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) sim.set(x, y, z, name, props)
  }
  sim.floor = (x0, z0, x1, z1, y, name = 'stone') => sim.fill(x0, y, z0, x1, y, z1, name)
  sim.blockName = (x, y, z) => bot.blockAt(new Vec3(x, y, z)).name
  sim.blockProps = (x, y, z) => bot.blockAt(new Vec3(x, y, z)).getProperties()
  sim.viewRadius = opts.viewRadius || null     // blocks around the bot that count as loaded chunks (null = everything in bounds)
  let loadedCols = new Set()
  const inView = (x, z) => {
    if (!sim.viewRadius) return true
    const cx = Math.floor(bot.entity.position.x / 16) * 16, cz = Math.floor(bot.entity.position.z / 16) * 16
    return Math.abs(Math.floor(x / 16) * 16 - cx) <= sim.viewRadius && Math.abs(Math.floor(z / 16) * 16 - cz) <= sim.viewRadius
  }
  bot.blockAt = (pos) => {
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z)
    if (!inBounds(x, y, z) || !inView(x, z)) return null
    const k = key(x, y, z)
    // like prismarine-chunk: a fresh Block object per call (callers such as the pathfinder annotate the object they get)
    let sid = cache.get(k)
    if (sid === undefined) {
      const e = blocks.get(k)
      sid = (e ? Block.fromProperties(e.name, e.props, 0) : Block.fromProperties('air', {}, 0)).stateId
      cache.set(k, sid)
    }
    const b = Block.fromStateId(sid, 0)
    b.position = new Vec3(x, y, z)
    return b
  }
  // like prismarine-world raycast: first block whose collision SHAPE (not just its cell) the ray enters
  bot.world = {
    raycast(from, dir, range) {
      for (let d = 0; d <= range; d += 0.1) {
        const p = from.plus(dir.scaled(d)), b = bot.blockAt(p)
        if (!b || !b.shapes.length) continue
        const lx = p.x - b.position.x, ly = p.y - b.position.y, lz = p.z - b.position.z
        if (b.shapes.some(sh => lx >= sh[0] && lx <= sh[3] && ly >= sh[1] && ly <= sh[4] && lz >= sh[2] && lz <= sh[5])) return b
      }
      return null
    }
  }
  bot.findBlocks = ({ matching, maxDistance = 16, count = 1 }) => {
    const ids = new Set([].concat(matching)), out = []
    const c = bot.entity.position
    for (const [k, e] of blocks) {
      const id = mcData.blocksByName[e.name] && mcData.blocksByName[e.name].id
      if (!ids.has(id)) continue
      const [x, y, z] = k.split(',').map(Number)
      if (c.distanceTo(new Vec3(x + 0.5, y + 0.5, z + 0.5)) <= maxDistance) out.push(new Vec3(x, y, z))
    }
    out.sort((a, b) => a.distanceTo(c) - b.distanceTo(c))
    return out.slice(0, count)
  }
  // The "server": toggles doors/gates/trapdoors within reach, like vanilla (iron ones need redstone).
  bot.activateBlock = async (block) => {
    sim.interactions.push({ tick: sim.ticks, name: block.name, pos: block.position.clone() })
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5))
    const eye = bot.entity.position.offset(0, 1.62, 0)
    if (eye.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 4.5) return
    if (!isOpenable(block.name)) return
    const pr = block.getProperties()
    const lowY = pr.half === 'upper' ? block.position.y - 1 : block.position.y
    if (sim.locked && sim.locked.has(`${block.position.x},${lowY},${block.position.z}`)) return   // a door the "server" refuses to toggle
    const open = pr.open === true || pr.open === 'true'
    const flip = (x, y, z) => {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b || b.name !== block.name) return
      const props = { ...b.getProperties(), open: !open }
      const old = sim.set(x, y, z, b.name, props)
      bot.emit('blockUpdate', old, bot.blockAt(new Vec3(x, y, z)))
    }
    flip(block.position.x, block.position.y, block.position.z)
    if (/_door$/.test(block.name)) flip(block.position.x, block.position.y + (pr.half === 'upper' ? -1 : 1), block.position.z)
  }

  // Load a block snapshot made from the real world (test/fixtures/*.json): the box is stone, airRuns carve the air, groups add other blocks.
  sim.loadSnapshot = (file) => {
    const snap = typeof file === 'string' ? JSON.parse(require('fs').readFileSync(file, 'utf8')) : file
    const bx = snap.box
    sim.bounds = { x0: bx.x0, x1: bx.x1, y0: bx.y0, y1: bx.y1, z0: bx.z0, z1: bx.z1 }
    if (snap.fill) sim.fill(bx.x0, bx.y0, bx.z0, bx.x1, bx.y1, bx.z1, snap.fill)
    for (const [x, z, y0, y1] of snap.airRuns || []) for (let y = y0; y <= y1; y++) sim.clear(x, y, z)
    for (const g of snap.groups) for (const [x, y, z] of g.cells) sim.set(x, y, z, g.name, g.props || {})
    return snap
  }

  // ---------- helpers for building ----------
  sim.door = (x, y, z, { facing = 'east', open = false, hinge = 'left', name = 'oak_door' } = {}) => {
    sim.set(x, y, z, name, { facing, half: 'lower', hinge, open, powered: false })
    sim.set(x, y + 1, z, name, { facing, half: 'upper', hinge, open, powered: false })
  }
  sim.gate = (x, y, z, { facing = 'north', open = false, name = 'oak_fence_gate' } = {}) => sim.set(x, y, z, name, { facing, open, in_wall: false, powered: false })
  sim.ladder = (x, y0, y1, z, facing = 'north') => { for (let y = y0; y <= y1; y++) sim.set(x, y, z, 'ladder', { facing, waterlogged: false }) }
  // walls: a wall of stone with a 1x2 hole at (hx, y..y+1) along the plane z=wz
  sim.wallZ = (x0, x1, wz, y0, y1, name = 'stone_bricks') => sim.fill(x0, y0, wz, x1, y1, wz, name)
  sim.wallX = (z0, z1, wx, y0, y1, name = 'stone_bricks') => sim.fill(wx, y0, z0, wx, y1, z1, name)

  // A Xaero-like top-down map of the stored world: at(x, z) -> { explored, height, rgb, biome }. `explored(x, z)` limits what is "seen".
  sim.fakeMap = (explored = () => true) => {
    const top = new Map()
    for (const [k, e] of blocks) { const [x, y, z] = k.split(',').map(Number); const c = x + ',' + z; const t = top.get(c); if (!t || y > t.y) top.set(c, { y, name: e.name }) }
    const rgbOf = (n) => n === 'water' ? [60, 90, 145] : n === 'lava' ? [222, 100, 20] : n === 'sand' ? [220, 205, 150] : [75, 110, 70]
    return { at: (x, z) => { x = Math.floor(x); z = Math.floor(z); const t = top.get(x + ',' + z); if (!t || !explored(x, z)) return { explored: false }; return { explored: true, height: t.y, rgb: rgbOf(t.name), biome: 'minecraft:plains' } } }
  }

  // ---------- physics ----------
  // Physics sees `hidden` cells as solid stone while the planner (bot.blockAt) still sees what it saw before: a stale-world desync.
  sim.hidden = new Set()
  const stone = Block.fromProperties('stone', {}, 0)
  const world = { getBlock: (pos) => {
    if (sim.hidden.size) { const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z); if (sim.hidden.has(`${x},${y},${z}`)) { const b = Block.fromProperties('stone', {}, 0); b.position = new Vec3(x, y, z); return b } }
    return bot.blockAt(pos)
  } }
  sim.hide = (x, y, z) => sim.hidden.add(`${x},${y},${z}`)
  bot.physics = Physics(mcData, world)
  // Deterministic clock for the pathfinder (its search budgets and its "stuck for 3.5 s" timer read performance.now()): game time
  // (50 ms per tick) plus a tiny fixed cost per call, so a search costs the same virtual time on a loaded machine as on an idle one.
  let calls = 0
  const origNow = perfHooks.performance.now
  perfHooks.performance.now = () => sim.ticks * 50 + (++calls) * 0.01
  sim.dispose = () => { perfHooks.performance.now = origNow; bot.removeAllListeners() }
  sim.now = () => sim.ticks * 50          // virtual ms, use as api.now in modules
  sim.tick = () => {
    const before = bot.entity.position.clone()
    const state = new PlayerState(bot, bot.controlState)
    bot.physics.simulatePlayer(state, world).apply(bot)
    const step = bot.entity.position.distanceTo(before)
    if (step > sim.maxStep) sim.maxStep = step
    sim.ticks++
    calls = 0
    if (sim.viewRadius && sim.ticks % 5 === 0) {
      const cx = Math.floor(bot.entity.position.x / 16), cz = Math.floor(bot.entity.position.z / 16), R = Math.floor(sim.viewRadius / 16)
      const now = new Set()
      for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) now.add(`${cx + dx},${cz + dz}`)
      for (const c of now) if (!loadedCols.has(c)) { const [a, b] = c.split(',').map(Number); bot.emit('chunkColumnLoad', new Vec3(a * 16, 0, b * 16)) }
      loadedCols = now
    }
    bot.emit('physicsTick')
  }
  // Run until pred() is true or maxTicks pass. Yields to the event loop every tick so promises/timeouts settle.
  sim.run = async (pred, maxTicks = 600) => {
    for (let i = 0; i < maxTicks; i++) {
      sim.tick()
      await new Promise(r => setImmediate(r))
      if (pred && pred()) return { ok: true, ticks: i + 1 }
    }
    return { ok: false, ticks: maxTicks }
  }
  sim.settle = (n = 40) => sim.run(null, n)   // let the bot fall/land
  sim.at = () => bot.entity.position
  sim.cell = () => bot.entity.position.floored()

  // Real pathfinder with the same Movements configuration as join.js (the baseline the nav module improves on).
  pathfinder(bot)
  bot.pathfinder.thinkTimeout = 4000
  bot.on('path_update', (r) => sim.events.push({ ev: 'path_update', status: r.status, len: r.path.length, tick: sim.ticks }))
  bot.on('path_reset', (reason) => sim.events.push({ ev: 'path_reset', reason, tick: sim.ticks }))
  bot.on('goal_reached', () => { sim.reached = true; sim.events.push({ ev: 'goal_reached', tick: sim.ticks }) })
  sim.reached = false

  // Walk to a goal using the raw pathfinder and report whether it was reached within maxTicks.
  sim.goto = async (goal, { maxTicks = 800 } = {}) => {
    sim.reached = false
    bot.pathfinder.setGoal(goal)
    const r = await sim.run(() => sim.reached, maxTicks)
    return { ok: sim.reached, ticks: r.ticks, pos: bot.entity.position.clone() }
  }
  return sim
}

// join.js setupMovement() as it was when this module was written (without the viewer/driver parts). Used as a baseline.
function legacyMovements(bot) {
  const mv = new Movements(bot)
  mv.canDig = false
  mv.allow1by1towers = false
  mv.allowParkour = false
  mv.scafoldingBlocks = []
  mv.maxDropDown = 3
  mv.canOpenDoors = false
  for (const n of ['cactus', 'sweet_berry_bush', 'magma_block', 'campfire', 'soul_campfire', 'soul_fire', 'powder_snow', 'wither_rose', 'pointed_dripstone', 'bamboo_sapling']) {
    const b = bot.registry.blocksByName[n]; if (b) mv.blocksToAvoid.add(b.id)
  }
  const isDoorName = (n) => (n.endsWith('_door') && n !== 'iron_door') || n.endsWith('_fence_gate')
  const floorHazards = new Set(['magma_block', 'campfire', 'soul_campfire', 'cactus'].map(n => bot.registry.blocksByName[n]?.id).filter(Boolean))
  const origGetBlock = mv.getBlock.bind(mv)
  mv.getBlock = (pos, dx, dy, dz) => {
    const b = origGetBlock(pos, dx, dy, dz)
    if (b && b.name && isDoorName(b.name)) { b.physical = false; b.safe = true }
    else if (b && floorHazards.has(b.type)) { b.physical = false; b.safe = false }
    return b
  }
  bot.pathfinder.setMovements(mv)
  bot.pathfinder.thinkTimeout = 4000
  return mv
}

// A simulated world with a Navigator attached on top of the join.js-style Movements.
//   const r = await rig({ pos: [0.5, 64, 0.5] }, sim => sim.floor(-5, -5, 30, 20, 63))
//   const res = await r.go(new goals.GoalBlock(10, 64, 0))      // { label, ok, secs, err }; runs `after` extra ticks (doors closing)
//   r.close()
async function rig(simOpts = {}, build = () => {}, navOpts = {}) {
  const { Navigator } = require('../brain/nav/navigator')
  const sim = makeSim(simOpts)
  build(sim)
  legacyMovements(sim.bot)
  await sim.settle(10)
  const logs = []
  const losLib = require('../brain/los')
  // Walter's line-of-sight rule, as brain/index.js wires it into api.canSee / api.ensureLineOfSight
  const los = navOpts.los === null ? null : {
    canSee: (b) => losLib.canSee(sim.bot, b),
    ensure: (o) => losLib.ensureLineOfSight({ bot: sim.bot, goals, tryGoto: (g, label, ms) => nav.goto(g, { label, ms }), ...o })
  }
  // these tests are about the plain navigator layer (no digging); test/nav.reach.test.js turns escalation on with config.escalate = true
  const nav = new Navigator({ bot: sim.bot, goals, log: (m) => logs.push(`${sim.ticks} ${m}`), los, ...navOpts, config: { escalate: false, ...(navOpts.config || {}) } })
  nav.attach()
  const r = {
    sim, nav, logs, bot: sim.bot,
    // sample something every tick, e.g. r.track(() => sim.blockName(...))
    track(fn) { const out = []; sim.bot.on('physicsTick', () => out.push(fn())); return out },
    async go(goal, { maxTicks = 700, after = 60, label = 'test', ms } = {}) {
      let res = null
      nav.goto(goal, { label, ms: ms || maxTicks * 50 }).then(x => { res = x })
      await sim.run(() => res, maxTicks + 40)
      if (after) await sim.run(null, after)
      return res || { ok: false, err: 'no result' }
    },
    close() { nav.detach(); sim.dispose() }
  }
  return r
}

module.exports = { makeSim, legacyMovements, rig, mcData, Vec3, goals, Movements, Block }
