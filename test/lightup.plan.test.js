// brain/lightup/plan.js: the pure half of the light-up task, on a synthetic grid (solid rock with carved caves).
const test = require('node:test')
const assert = require('node:assert/strict')
const P = require('../brain/lightup/plan')

// rock everywhere except the carved boxes; torches[] light the cave by the same flood the planner uses
function grid({ caves = [], torches = [], sky = () => false } = {}) {
  const air = new Set()
  const k = (x, y, z) => x + ',' + y + ',' + z
  for (const [x0, y0, z0, x1, y1, z1] of caves) for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) air.add(k(x, y, z))
  const lit = new Map()
  const w = {
    loaded: () => true,
    open: (x, y, z) => air.has(k(x, y, z)),
    floor: (x, y, z) => !air.has(k(x, y, z)),
    torchFloor: (x, y, z) => !air.has(k(x, y, z)),
    cost: (x, y, z) => (air.has(k(x, y, z)) ? 1 : 99),
    level: (x, y, z) => lit.get(k(x, y, z)) || 0,
    sky,
    air, lit, k,
  }
  w.addTorch = (t) => { air.add(k(...t)); const key = P.keyer(t); const f = P.flood({ ...w, cost: (x, y, z) => (air.has(k(x, y, z)) ? 1 : 99) }, t, key); for (const c of f.cells) lit.set(k(...c), Math.max(lit.get(k(...c)) || 0, f.lvl.get(key(...c)))) }
  for (const t of torches) w.addTorch(t)
  return w
}
const corridor = (len, y = 10) => [0, y, 0, len - 1, y + 1, 0]            // 2 high, 1 wide, along x

test('scan lists the dark spawn spots: open cell, open cell above, solid floor, light 0', async () => {
  const w = grid({ caves: [corridor(10)] })
  const r = await P.scan(w, [5, 10, 0], { r: 20, dy: 10 })
  assert.equal(r.cells.length, 10)
  assert.ok(r.cells.every(c => c[1] === 10 && c[2] === 0))
})

test('a lit cell is not a spawn spot; light spreads 13 cells and stops there', async () => {
  const w = grid({ caves: [corridor(40)], torches: [[0, 10, 0]] })
  const r = await P.scan(w, [20, 10, 0], { r: 40, dy: 5 })
  const xs = r.cells.map(c => c[0]).sort((a, b) => a - b)
  assert.equal(xs[0], 14, 'light 14 at x=0 reaches 1 at x=13')
  assert.equal(xs.length, 40 - 14)
})

test('exclude keeps the farm platform out of the scan; sky cells only when asked', async () => {
  const w = grid({ caves: [corridor(10)], sky: (x) => x >= 8 })
  const a = await P.scan(w, [5, 10, 0], { r: 20, dy: 10, exclude: (x) => x < 3 })
  assert.equal(a.excluded, 3)
  assert.equal(a.sky, 2)
  assert.equal(a.cells.length, 5)                     // 10 - 3 excluded - 2 under sky
  const b = await P.scan(w, [5, 10, 0], { r: 20, dy: 10, exclude: (x) => x < 3, sky: true })
  assert.equal(b.cells.length, 7)
})

test('plan lights everything with the fewest torches and keeps the 2-air spacing', async () => {
  const w = grid({ caves: [corridor(60)] })
  const { cells } = await P.scan(w, [30, 10, 0], { r: 40, dy: 5 })
  const pl = await P.plan(w, cells, { max: 20 })
  assert.equal(pl.leftover.length, 0)
  assert.ok(pl.torches.length <= 3, 'a 60 long corridor needs about 3 torches (each lights 27 cells), got ' + pl.torches.length)
  for (const t of pl.torches) w.addTorch(t.at)
  const after = await P.scan(w, [30, 10, 0], { r: 40, dy: 5 })
  assert.equal(after.cells.length, 0, 'nothing dark left after the chosen torches')
  for (const a of pl.torches) for (const b of pl.torches) if (a !== b) assert.ok(P.spaced(a.at, [b.at]), 'torches are at least 3 apart on some axis')
})

test('existing torches count: no torch closer than torch-air-air-torch, and what they light is not planned', async () => {
  const w = grid({ caves: [corridor(40)], torches: [[10, 10, 0]] })
  const { cells } = await P.scan(w, [20, 10, 0], { r: 40, dy: 5 })
  const pl = await P.plan(w, cells, { torches: [[10, 10, 0]], max: 20 })
  assert.equal(pl.leftover.length, 0)
  for (const t of pl.torches) assert.ok(Math.abs(t.at[0] - 10) >= 3)
  assert.ok(P.spaced([13, 10, 0], [[10, 10, 0]]), 'torch, air, air, torch is allowed')
  assert.ok(!P.spaced([12, 10, 0], [[10, 10, 0]]), 'one air between is not')
  assert.ok(!P.spaced([11, 11, 1], [[10, 10, 0]]))
})

test('keepDark: no torch whose light would reach the platform', async () => {
  // a platform room (x -10..-1) joined to a long corridor (x 0..59) by an opening: torches near the opening would flood the platform
  const w = grid({ caves: [[-10, 10, -2, -1, 11, 2], corridor(60)] })
  const platform = (x, y, z) => x < 0 && y >= 10 && y <= 12
  const { cells } = await P.scan(w, [30, 10, 0], { r: 50, dy: 5, exclude: platform })
  assert.equal(cells.length, 60)
  const pl = await P.plan(w, cells, { max: 20, keepDark: platform })
  assert.ok(pl.rejected.leak > 0, 'candidates near the opening were rejected')
  for (const t of pl.torches) {
    const f = P.flood(w, t.at, P.keyer(t.at))
    assert.ok(!f.cells.some(c => platform(...c)), 'the torch at ' + t.at + ' lights the platform')
  }
  assert.ok(pl.torches.every(t => t.at[0] >= 13), 'light 14 from x=13 reaches x=0 with 1 and stops at the room, 14+ is clear')
})

test('connected drops sealed pockets (unreachable without digging)', async () => {
  const w = grid({ caves: [corridor(10), [20, 10, 0, 24, 11, 0]] })
  const reach = await P.connected(w, [0, 10, 0], [10, 10, 0], { r: 30, dy: 5 })
  const key = P.keyer([10, 10, 0])
  assert.ok(reach.has(key(9, 10, 0)))
  assert.ok(!reach.has(key(22, 10, 0)))
})

test('connected passes ladders and doors when the world says so (pass)', async () => {
  const w = grid({ caves: [corridor(5), [6, 10, 0, 9, 11, 0]] })
  w.open = ((o) => (x, y, z) => o(x, y, z))(w.open)
  w.pass = (x, y, z) => w.air.has(w.k(x, y, z)) || (x === 5 && y === 10 && z === 0)     // a door cell between the two rooms
  const reach = await P.connected(w, [0, 10, 0], [5, 10, 0], { r: 30, dy: 5 })
  assert.ok(reach.has(P.keyer([5, 10, 0])(8, 10, 0)))
})

test('route goes nearest first from where the bot stands', () => {
  const r = P.route([{ at: [30, 10, 0] }, { at: [2, 10, 0] }, { at: [15, 10, 0] }], [0, 10, 0])
  assert.deepEqual(r.map(t => t.at[0]), [2, 15, 30])
})

test('a pocket that no allowed candidate can cover is reported as leftover, not forced', async () => {
  // a dark cell two cells from an existing torch behind a wall: its own cell breaks the spacing rule, and the only other candidates are it alone
  const w = grid({ caves: [[0, 10, 0, 0, 11, 0], [0, 10, 2, 0, 11, 2]], torches: [[0, 10, 0]] })
  const { cells } = await P.scan(w, [0, 10, 1], { r: 10, dy: 5 })
  assert.equal(cells.length, 1)
  const pl = await P.plan(w, cells, { torches: [[0, 10, 0]], max: 5 })
  assert.equal(pl.torches.length, 0)
  assert.equal(pl.leftover.length, 1)
})

// ---- the engine's guards, with stub skills (the walking itself is exercised by tools/trial/lightup-lab.js against a vanilla server)
const os = require('os'), fs = require('fs'), path = require('path')
const { Vec3 } = require('vec3')
function rig({ items = {}, health = 20, farmCfg = null, night = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lu-'))
  if (farmCfg) fs.writeFileSync(path.join(dir, 'mobfarm.json'), JSON.stringify(farmCfg))
  const bot = { username: 'T', health, isSleeping: false, entity: { position: new Vec3(0.5, 30, 0.5) }, entities: {}, inventory: { items: () => Object.entries(items).map(([name, count]) => ({ name, count })) } }
  const S = {
    bot, goals: {}, v: (x, y, z) => new Vec3(x, y, z), flo: (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    count: (w) => { let n = 0; for (const [k, c] of Object.entries(items)) if (w instanceof RegExp ? w.test(k) : k === w) n += c; return n },
    planks: () => 0, logs: () => 0, isNight: () => night, underground: () => false, check() {}, wait: async () => {}, craft: async () => false,
    hostilesNear: () => [], dist: () => 0,
  }
  const notes = []
  const G = { state: {}, note: (m) => notes.push(m), save() {} }
  const step = require('../brain/autopilot/lightup')(G, S, {}, { statePath: (f) => path.join(dir, f) }, () => {})
  return { step, G, notes, bot }
}
const FARM = { builder: 'mobfarmbuild', platform: { y: 30, centre: [230, 29, 0], radius: 9 }, rest: [207, 30, 0], killSpot: [227, 8, 0], killBox: { x0: 230, x1: 230, y0: 8, y1: 9, z0: 0, z1: 0 } }

test('light-up refuses to start hurt, asleep, at night on the surface; says why', async () => {
  const hurt = rig({ items: { torch: 20 }, health: 8 })
  const r = await hurt.G.lightUp.run()
  assert.equal(r.ok, false); assert.match(r.why, /health 8/)
  const night = rig({ items: { torch: 20 }, night: true })
  assert.match((await night.G.lightUp.run()).why, /night on the surface/)
  const asleep = rig({ items: { torch: 20 } }); asleep.bot.isSleeping = true
  assert.equal((await asleep.G.lightUp.run()).why, 'asleep')
})

test('the fallback step needs a built farm, a healthy bot and torches (or coal); it rests between runs', () => {
  assert.equal(rig({ items: { torch: 20 } }).step.need(), false, 'no farm config')
  assert.equal(rig({ items: { torch: 20 }, farmCfg: FARM }).step.need(), true)
  assert.equal(rig({ items: {}, farmCfg: FARM }).step.need(), false, 'no torches and no coal')
  assert.equal(rig({ items: { coal: 3 }, farmCfg: FARM }).step.need(), true)
  assert.equal(rig({ items: { torch: 20 }, farmCfg: FARM, health: 9 }).step.need(), false)
  const r = rig({ items: { torch: 20 }, farmCfg: FARM }); r.G.state.lightUp = { nextAt: Date.now() + 60000 }
  assert.equal(r.step.need(), false, 'ran a moment ago')
  assert.equal(r.step.id, 'mob-farm-light')
})

test('an old-world mobfarm.json without a platform is not a farm for this task', () => {
  assert.equal(rig({ items: { torch: 20 }, farmCfg: { killSpot: [1, 2, 3], chests: [[1, 2, 3]] } }).step.need(), false)
})
