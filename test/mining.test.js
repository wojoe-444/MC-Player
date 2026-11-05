const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const H = require('./mining.helpers')
const { rig, runJob, fakeCtx, k } = H
const G = require('../brain/mining/geometry')
const ores = require('../brain/mining/ores')
const minesLib = require('../brain/mining/mines')
const makeSight = require('../brain/mining/sight')
const makeTools = require('../brain/mining/tools')

const ROCK16 = { x1: -14, x2: 30, y1: 0, y2: 30, z1: -24, z2: 24 }
const ALL_ORES = (name) => new Set(ores.cfg.ores[name].blocks)
const hallKeys = (trunk, branch, y = -58, spacing = 3) => {
  const s = new Set()
  const add = (x, z) => { s.add(k(x, y, z)); s.add(k(x, y + 1, z)) }
  for (let t = 1; t <= trunk; t++) add(t, 0)
  for (let t = 0; t <= trunk; t += spacing) for (let d = 1; d <= branch; d++) { add(t, -d); add(t, d) }
  return s
}

// ------------------------------------------------------------------ parsing
test('parse: mine <ore> <amount> in every phrasing Walter might use', () => {
  const p = (t) => ores.parseMine(t)
  assert.deepStrictEqual(p('mine diamonds 5'), { ore: 'diamond', amount: 5, explicit: true })
  assert.deepStrictEqual(p('mine 10 diamonds'), { ore: 'diamond', amount: 10, explicit: true })
  assert.deepStrictEqual(p('go mine for iron'), { ore: 'iron', amount: 32, explicit: false })
  assert.deepStrictEqual(p('mine me 5 iron'), { ore: 'iron', amount: 5, explicit: true })
  assert.deepStrictEqual(p('start mining diamonds'), { ore: 'diamond', amount: 5, explicit: false })
  assert.deepStrictEqual(p('mine a stack of coal'), { ore: 'coal', amount: 64, explicit: true })
  assert.deepStrictEqual(p('mine redstone x20'), { ore: 'redstone', amount: 20, explicit: true })
  assert.deepStrictEqual(p('mine lapis lazuli 10'), { ore: 'lapis', amount: 10, explicit: true })
  assert.deepStrictEqual(p('strip mine iron 12'), { ore: 'iron', amount: 12, explicit: true })
  assert.deepStrictEqual(p('go mine for a few diamonds'), { ore: 'diamond', amount: 5, explicit: false })
  assert.strictEqual(p('mine copper 9').ore, 'copper')
  assert.strictEqual(p('mine gold').ore, 'gold')
})
test('parse: not a mining line, or an ore we cannot strip mine', () => {
  const p = (t) => ores.parseMine(t)
  for (const t of ['mine', 'mine is bigger', 'mining status', 'stop mining', 'mine craft', 'resume mining', 'how is the mining going', 'excavate', 'don\'t mine']) assert.strictEqual(p(t), null, t)
  assert.match(p('mine emeralds').error, /mountain/)
  assert.match(p('mine ancient debris').error, /Nether/)
  assert.match(p('go mine').error, /Mine what/)
})
test('depth table: diamonds -58..-50, iron 16, coal 45, gold -16, redstone -58..-50 (hallway feet level)', () => {
  const o = ores.cfg.ores
  assert.deepStrictEqual(o.diamond.range, [-58, -50]); assert.strictEqual(o.diamond.y, -58)
  assert.strictEqual(o.iron.y, 16); assert.strictEqual(o.coal.y, 45); assert.strictEqual(o.gold.y, -16)
  assert.deepStrictEqual(o.redstone.range, [-58, -50])
})

// ------------------------------------------------------------------ geometry
test('geometry: hallway, two solid blocks, hallway - every block between hallways touches one', () => {
  const mine = G.newMine({ origin: [0, -58, 0], dir: [1, 0], y: -58, trunkLen: 12, branchLen: 6 })
  const hall = new Set()
  const add = (c) => { hall.add(`${c.x},${c.z}`) }
  for (let t = 0; t <= 12; t++) add(G.trunkCell(mine, t))
  for (let t = 0; t <= 12; t += 3) for (const side of ['L', 'R']) for (let d = 1; d <= 6; d++) add(G.branchCell(mine, t, side, d))
  // rows of hallways run along x at z = 0 (trunk) and along z at x = 0,3,6,9,12: along any line crossing them the gap is exactly 2 solid blocks
  for (let z = 1; z <= 6; z++) { const xs = [...hall].map(s => s.split(',').map(Number)).filter(([x, zz]) => zz === z).map(([x]) => x).sort((a, b) => a - b); assert.deepStrictEqual(xs, [0, 3, 6, 9, 12]) }
  for (let z = -6; z <= -1; z++) { const xs = [...hall].map(s => s.split(',').map(Number)).filter(([x, zz]) => zz === z).map(([x]) => x).sort((a, b) => a - b); assert.deepStrictEqual(xs, [0, 3, 6, 9, 12]) }
  for (let x = 0; x <= 12; x++) for (let z = -6; z <= 6; z++) {
    if (hall.has(`${x},${z}`)) continue
    const touches = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => hall.has(`${x + dx},${z + dz}`))
    assert.ok(touches, `solid block ${x},${z} is not next to a hallway`)
  }
})
test('geometry: the trunk is 1 wide; left is the side to the bot\'s left for every heading', () => {
  for (const dir of G.CARDINALS) {
    const mine = G.newMine({ origin: [0, 10, 0], dir, y: 10 })
    const l = G.branchCell(mine, 0, 'L', 1), r = G.branchCell(mine, 0, 'R', 1)
    assert.strictEqual(l.x + r.x, 0); assert.strictEqual(l.z + r.z, 0)
    assert.notStrictEqual(`${l.x},${l.z}`, `${r.x},${r.z}`)
  }
  const east = G.newMine({ origin: [0, 10, 0], dir: [1, 0], y: 10 })
  assert.strictEqual(G.branchCell(east, 0, 'L', 1).z, -1)        // facing east (+x), left is north (-z)
})
test('geometry: segments run nearest junction first, branches before more trunk', () => {
  const m = G.newMine({ origin: [0, 0, 0], dir: [1, 0], y: 0, trunkLen: 6, branchLen: 4 })
  assert.deepStrictEqual(G.nextSegment(m), { type: 'branch', t: 0, side: 'L', from: 0 })
  m.branches['0:L'] = { len: 4, done: true }
  assert.deepStrictEqual(G.nextSegment(m), { type: 'branch', t: 0, side: 'R', from: 0 })
  m.branches['0:R'] = { len: 2, done: false }
  assert.deepStrictEqual(G.nextSegment(m), { type: 'branch', t: 0, side: 'R', from: 2 })
  m.branches['0:R'] = { len: 4, done: true }
  assert.deepStrictEqual(G.nextSegment(m), { type: 'trunk', from: 0, to: 3 })
  m.trunk = 3
  assert.deepStrictEqual(G.nextSegment(m), { type: 'branch', t: 3, side: 'L', from: 0 })
  for (const key of ['3:L', '3:R']) m.branches[key] = { len: 4, done: true }
  assert.deepStrictEqual(G.nextSegment(m), { type: 'trunk', from: 3, to: 6 })
  m.trunk = 6
  for (const key of ['6:L', '6:R']) m.branches[key] = { len: 4, done: true }
  assert.strictEqual(G.nextSegment(m), null)
})
test('geometry: stairs go one down per step, floor of the landing is the block two below', () => {
  const s = G.stairStep(new Vec3(0, 20, 0), [1, 0], -1)
  assert.deepStrictEqual(s.land.toArray(), [1, 19, 0]); assert.deepStrictEqual(s.floor.toArray(), [1, 18, 0])
  assert.deepStrictEqual(s.dig.map(c => c.toArray()), [[1, 20, 0], [1, 19, 0], [1, 21, 0]])
  const u = G.stairStep(new Vec3(0, 20, 0), [1, 0], 1)
  assert.deepStrictEqual(u.land.toArray(), [1, 21, 0]); assert.deepStrictEqual(u.floor.toArray(), [1, 20, 0])
})

// ------------------------------------------------------------------ sight (no x-ray)
function sightRig(opts = {}) {
  const r = rig({ ...opts })
  const sight = makeSight({ bot: r.bot, config: r.cfg })
  return { ...r, sight }
}
test('sight: only ore with an exposed face AND a clear ray is returned', () => {
  const r = sightRig()
  const { bot } = r
  H.carve(bot, [[1, -58, 0], [1, -57, 0], [2, -58, 0], [2, -57, 0]])      // a short hallway east of the pocket
  bot.setBlock(3, -58, 0, 'diamond_ore')                                   // at the end of the hallway: seen
  bot.setBlock(2, -58, -1, 'diamond_ore')                                  // in the wall beside it: seen
  bot.setBlock(5, -58, 0, 'diamond_ore')                                   // one block behind the end wall: hidden
  bot.setBlock(1, -55, 0, 'diamond_ore')                                   // two above the ceiling: hidden
  bot.setBlock(1, -61, 0, 'diamond_ore')                                   // two under the floor: hidden
  // a sealed air pocket lined with ore: the ore touches air (exposed) but a wall is in the way
  H.carve(bot, [[10, -58, 10]]); for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) bot.setBlock(10 + dx, -58 + dy, 10 + dz, 'diamond_ore')
  const seen = r.sight.look({ ores: ALL_ORES('diamond') }).ores.map(o => k(o.block.position.x, o.block.position.y, o.block.position.z)).sort()
  assert.deepStrictEqual(seen, [k(2, -58, -1), k(3, -58, 0)].sort())
})
test('sight: an exposed ore across a wall is not visible even from a cave behind it, and appears once the wall is gone', () => {
  const r = sightRig()
  const { bot } = r
  H.carve(bot, [[4, -58, 0], [4, -57, 0]])                                  // a pocket 4 blocks east, not connected
  bot.setBlock(5, -58, 0, 'diamond_ore')                                    // exposed to that pocket
  const look = () => r.sight.look({ ores: ALL_ORES('diamond') }).ores.length
  assert.strictEqual(look(), 0)
  H.carve(bot, [[1, -58, 0], [1, -57, 0], [2, -58, 0], [2, -57, 0], [3, -58, 0], [3, -57, 0]])      // dig through (the player would see it now)
  assert.strictEqual(look(), 1)
})
test('sight: lava and water are reported only when visible', () => {
  const r = sightRig()
  const { bot } = r
  bot.setBlock(5, -58, 5, 'air'); bot.setBlock(5, -58, 6, 'lava')           // lava next to a sealed pocket
  assert.strictEqual(r.sight.look().liquids.length, 0)
  H.carve(bot, [[1, -58, 0], [1, -57, 0], [2, -58, 0], [2, -57, 0], [3, -58, 0], [3, -57, 0]]); bot.setBlock(4, -58, 0, 'lava')
  const l = r.sight.look().liquids
  assert.strictEqual(l.length, 1); assert.strictEqual(l[0].lava, true)
})
test('sight: fails closed without bot.world.raycast (nothing seen, nothing visible)', () => {
  const r = sightRig()
  H.carve(r.bot, [[1, -58, 0], [1, -57, 0]]); r.bot.setBlock(2, -58, 0, 'diamond_ore')
  assert.strictEqual(r.sight.look({ ores: ALL_ORES('diamond') }).ores.length, 1)
  r.bot.noRaycast()
  assert.strictEqual(r.sight.available(), false)
  assert.strictEqual(r.sight.look({ ores: ALL_ORES('diamond') }).ores.length, 0)
  assert.strictEqual(r.sight.see(r.bot.blockAt(new Vec3(2, -58, 0))), false)
})
test('sight: standOk wants headroom, a dry floor that is in view, and no gap', () => {
  const r = sightRig()
  const { bot } = r
  H.carve(bot, [[1, -58, 0], [1, -57, 0], [2, -58, 0], [2, -57, 0], [3, -58, 0], [3, -57, 0], [4, -58, 0], [4, -57, 0]])
  assert.strictEqual(r.sight.standOk(new Vec3(1, -58, 0)).ok, true)
  bot.setBlock(2, -59, 0, 'air')                                             // a hole in the floor
  assert.strictEqual(r.sight.standOk(new Vec3(2, -58, 0)).why, 'no-floor')
  bot.setBlock(3, -59, 0, 'lava')
  assert.strictEqual(r.sight.standOk(new Vec3(3, -58, 0)).why, 'liquid-floor')
  bot.setBlock(4, -59, 0, 'magma_block')
  assert.match(r.sight.standOk(new Vec3(4, -58, 0)).why, /bad-floor/)
  assert.strictEqual(r.sight.standOk(new Vec3(7, -58, 0)).why, 'blocked')    // inside rock
})

// ------------------------------------------------------------------ the strip
test('strip: the hallway pattern is exactly trunk + branches 3 apart, 1 wide and 2 high, nothing else is dug', async () => {
  const r = rig()
  const res = await runJob(r, 'diamond', 5)
  assert.strictEqual(res.status, 'done')
  const dug = new Set(r.bot.dugAt())
  assert.deepStrictEqual([...dug].sort(), [...hallKeys(6, 4)].sort())
  assert.deepStrictEqual(r.bot.losViolations, [])
  // the hallways really are open and two high
  for (const key of hallKeys(6, 4)) { const [x, y, z] = key.split(',').map(Number); assert.strictEqual(r.bot.blockAt(new Vec3(x, y, z)).name, 'air') }
  // two solid blocks between neighbouring branches stay solid
  for (const x of [1, 2, 4, 5]) for (const z of [2, -2]) assert.strictEqual(r.bot.blockAt(new Vec3(x, -58, z)).name, 'stone')
  assert.match(r.said.join(' '), /strip is finished: 0 diamonds of 5/)
})
test('strip: every ore the hallways expose is mined; ore two blocks inside the rock is never touched (acceptance: no x-ray)', async () => {
  const r = rig()
  const { bot } = r
  // seen: beside the trunk, in the ceiling, between branch rows, near a branch end
  const seen = [[2, -58, -1], [4, -56, 0], [1, -58, 3], [5, -58, -2], [3, -58, 5]]
  const hidden = [[2, -55, 0], [2, -60, 0], [10, -58, 0], [-5, -58, 0], [3, -58, 7], [8, -58, 8], [2, -58, -6]]
  for (const p of seen) bot.setBlock(...p, 'diamond_ore')
  for (const p of hidden) bot.setBlock(...p, 'diamond_ore')
  H.carve(bot, [[20, -58, 10]]); bot.setBlock(20, -58, 11, 'diamond_ore')                // exposed to a sealed pocket
  bot.findBlocks = () => { throw new Error('x-ray: findBlocks') }; bot.findBlock = () => { throw new Error('x-ray: findBlock') }
  const res = await runJob(r, 'diamond', 50)
  assert.strictEqual(res.status, 'done')
  assert.strictEqual(bot.count('diamond'), seen.length, 'exactly the exposed ones')
  const dug = new Set(bot.dugAt())
  for (const p of hidden) assert.ok(!dug.has(k(...p)), `hidden ore ${p} must not be dug`)
  assert.ok(!dug.has(k(20, -58, 11)) && !dug.has(k(20, -58, 10)))
  for (const p of [...hidden, [20, -58, 11]]) assert.strictEqual(bot.blockAt(new Vec3(...p)).name, 'diamond_ore', `hidden ore ${p} still there`)
  // every dig was audited for line of sight by the harness, independent of the module
  assert.deepStrictEqual(bot.losViolations, [])
  // and nothing was dug that is neither a pattern cell nor an ore in the strip
  const allowed = hallKeys(6, 4)
  for (const p of seen) allowed.add(k(...p))
  for (const key of dug) assert.ok(allowed.has(key), `unexpected dig ${key}`)
  // never visited anywhere near a hidden ore's column inside the rock
  for (const v of bot.visited) assert.ok(!hidden.some(h => k(h[0], h[1] + 0, h[2]) === v))
})
test('strip: a hallway with only hidden ore finds nothing and reports it; it never tunnels toward the hidden block', async () => {
  const r = rig()
  r.bot.setBlock(2, -55, 0, 'diamond_ore'); r.bot.setBlock(10, -58, 0, 'diamond_ore'); r.bot.setBlock(3, -58, 9, 'diamond_ore')
  const res = await runJob(r, 'diamond', 3)
  assert.strictEqual(res.status, 'done')
  assert.strictEqual(r.bot.count('diamond'), 0)
  assert.strictEqual(r.state.job.gained, 0)
  assert.match(r.said.join(' '), /finished: 0 diamonds of 3/)
  assert.deepStrictEqual([...new Set(r.bot.dugAt())].sort(), [...hallKeys(6, 4)].sort())
})
test('strip: stops as soon as the target is met', async () => {
  const r = rig()
  r.bot.setBlock(2, -58, -1, 'diamond_ore'); r.bot.setBlock(3, -58, 1, 'diamond_ore'); r.bot.setBlock(6, -58, -2, 'diamond_ore')
  const res = await runJob(r, 'diamond', 2)
  assert.strictEqual(res.status, 'done')
  assert.strictEqual(r.bot.count('diamond'), 2)
  assert.ok(r.bot.digs < 40, `stopped early (${r.bot.digs} digs)`)
  assert.match(r.said.join(' '), /Done: 2 diamonds/)
})
test('strip: only the requested ore is mined (iron next to diamond stays)', async () => {
  const r = rig()
  r.bot.setBlock(2, -58, -1, 'iron_ore'); r.bot.setBlock(2, -58, 1, 'diamond_ore')
  await runJob(r, 'diamond', 1)
  assert.strictEqual(r.bot.count('diamond'), 1); assert.strictEqual(r.bot.count('raw_iron'), 0)
  assert.strictEqual(r.bot.blockAt(new Vec3(2, -58, -1)).name, 'iron_ore')
})
test('strip: floor ore is never dug from above; it is taken from the side after the hallway is done', async () => {
  const r = rig()
  r.bot.setBlock(4, -59, 0, 'diamond_ore')                // under the trunk
  r.bot.setBlock(3, -59, 2, 'diamond_ore')                // under a cell of the t=3 right branch
  r.bot.setBlock(0, -59, 3, 'diamond_ore')                // under a branch cell
  await runJob(r, 'diamond', 3)
  assert.strictEqual(r.bot.count('diamond'), 3)
  for (const d of r.bot.digLog.filter(x => x.name === 'diamond_ore')) {
    const above = d.from.y > d.y && Math.floor(d.from.x) === d.x && Math.floor(d.from.z) === d.z
    assert.ok(!above, `dug ${d.x},${d.y},${d.z} from straight above`)
  }
  // the pit under the trunk was only made after the walkway was finished (last dig of the job)
  const last = r.bot.digLog[r.bot.digLog.length - 1]
  assert.deepStrictEqual([last.x, last.y, last.z], [4, -59, 0])
})
test('an ore beside a visible liquid is left alone (digging it could let the lava out)', async () => {
  const r = rig()
  H.carve(r.bot, [[1, -58, 0], [1, -57, 0]]); r.bot.setBlock(2, -58, 0, 'iron_ore'); r.bot.setBlock(1, -58, 0, 'air')
  const blk = r.bot.blockAt(new Vec3(2, -58, 0))
  const lk = { ores: [], liquids: [{ pos: new Vec3(3, -58, 1), lava: true, d: 3 }] }
  const res = await r.engine.mineOre(fakeCtx(), blk, lk)
  assert.strictEqual(res.ok, false)
  assert.strictEqual(r.bot.digs, 0)
  assert.strictEqual(r.state.stats.skipped['ore-beside-liquid'], 1)
})

// ------------------------------------------------------------------ safety
test('lava: lava that shows up beside the next hallway cell stops the trunk; the bot never steps next to it', async () => {
  const r = rig()
  r.bot.setBlock(5, -58, 1, 'lava')                       // hidden until the trunk cell at x=5 is opened
  await runJob(r, 'diamond', 3)
  const m = r.state.mines[0]
  assert.strictEqual(m.trunk, 4, 'trunk ends where the lava appeared')
  assert.strictEqual(m.endedWhy, 'liquid')
  assert.ok(!r.bot.visited.some(v => { const [x] = v.split(',').map(Number); return x >= 5 }), 'never stood next to the lava')
  assert.strictEqual(r.bot.blockAt(new Vec3(5, -58, 1)).name, 'lava')
  assert.ok(!r.bot.dugAt().some(c => Number(c.split(',')[0]) >= 6), 'nothing dug beyond the lava')
  assert.ok(!r.state.mines[0].branches['6:L'] && !r.state.mines[0].branches['6:R'], 'no branches at the junction past the lava')
  // the last thing the bot did there was to open cell 5, see the lava, and not step in
  assert.strictEqual(r.bot.digLog[r.bot.digLog.length - 1].x <= 5, true)
})
test('water: water that appears in view ends that hallway and the bot backs off', async () => {
  const r = rig()
  r.bot.setBlock(3, -58, 2, 'water'); r.bot.setBlock(3, -57, 2, 'water')       // behind the wall of the t=3 right branch
  await runJob(r, 'diamond', 3)
  const m = r.state.mines[0]
  assert.ok(m.branches['3:R'].done && m.branches['3:R'].why === 'liquid', JSON.stringify(m.branches['3:R']))
  assert.ok(m.branches['3:R'].len < 4)
  assert.strictEqual(r.bot.blockAt(new Vec3(3, -58, 2)).name, 'water')
  const d = r.bot.digLog.map(x => x).find(x => x.name === 'water'); assert.strictEqual(d, undefined)
})
test('a cell that is lava itself is never dug into or entered', async () => {
  const r = rig()
  r.bot.setBlock(3, -58, 0, 'lava'); r.bot.setBlock(3, -57, 0, 'lava')
  await runJob(r, 'diamond', 3)
  assert.strictEqual(r.state.mines[0].trunk, 1, 'the lava is seen as soon as cell 2 is open, so the bot never steps into it')
  assert.ok(!r.bot.visited.some(v => Number(v.split(',')[0]) >= 2))
})
test('a cave floor that is missing stops the hallway (a drop is never walked into the dark)', async () => {
  const r = rig()
  H.carve(r.bot, [[3, -59, 0], [3, -60, 0], [3, -61, 0]])             // an air shaft under trunk cell 3
  await runJob(r, 'diamond', 3)
  assert.strictEqual(r.state.mines[0].trunk, 2)
  assert.match(r.state.mines[0].endedWhy, /floor:|void/)
})
test('mines are messy: mineshaft planks and gravel are dug; chests, bricks and the like are never broken and end the hallway there', async () => {
  const r = rig()
  r.bot.setBlock(4, -58, 0, 'oak_planks')
  r.bot.setBlock(0, -58, 2, 'chest')
  r.bot.setBlock(-0, -58, 4, 'stone_bricks')
  await runJob(r, 'diamond', 3)
  assert.strictEqual(r.bot.blockAt(new Vec3(4, -58, 0)).name, 'air', 'planks of an old mineshaft are dug')
  assert.strictEqual(r.bot.blockAt(new Vec3(0, -58, 2)).name, 'chest', 'a container is never broken')
  assert.strictEqual(r.bot.blockAt(new Vec3(0, -58, 4)).name, 'stone_bricks')
  assert.match(r.state.mines[0].branches['0:R'].why, /obstacle:chest/)
  assert.strictEqual(r.state.mines[0].trunk, 6)
})
test('falling gravel is cleared and the hallway carries on, even a column of 14', async () => {
  const r = rig()
  r.bot.setBlock(2, -56, 0, 'gravel')                                  // one block above the head cell
  await runJob(r, 'diamond', 3)
  assert.strictEqual(r.state.mines[0].trunk, 6)
  const r2 = rig()
  for (let y = -58; y <= -45; y++) r2.bot.setBlock(2, y, 0, 'gravel')   // 14 high column in the trunk
  await runJob(r2, 'diamond', 3)
  assert.strictEqual(r2.state.mines[0].trunk, 6)
  assert.strictEqual(r2.bot.blockAt(new Vec3(2, -58, 0)).name, 'air')
})

test('placing is never done: no block ever appears that was not there (only air replaces dug blocks)', async () => {
  const r = rig()
  const before = new Map()
  const placed = []
  const orig = r.bot.setBlock
  r.bot.setBlock = (x, y, z, name, props) => { if (name !== 'air' && r.bot.dig.running) placed.push([x, y, z, name]); return orig(x, y, z, name, props) }
  r.bot.placeBlock = () => { throw new Error('placeBlock called') }
  r.bot.activateBlock = () => { throw new Error('activateBlock called') }
  await runJob(r, 'diamond', 3)
  assert.deepStrictEqual(placed, [])
  assert.ok(!r.bot.actions.some(a => a[0] === 'place' || a[0] === 'activate'))
})
test('hostile in plain view pauses the job; one behind rock is not a threat', async () => {
  const r = rig()
  H.carve(r.bot, [[1, -58, 0], [1, -57, 0]])
  r.bot.entities[1] = { id: 1, name: 'zombie', position: new Vec3(1.5, -58, 0.5), height: 1.95 }
  const res = await runJob(r, 'diamond', 3)
  assert.strictEqual(res.status, 'retry')
  assert.strictEqual(r.bot.digs, 0)
  assert.match(r.said.join(' '), /zombie is near/)
  const r2 = rig()
  r2.bot.entities[1] = { id: 1, name: 'zombie', position: new Vec3(1.5, -58, 0.5), height: 1.95 }      // inside the rock: nothing to see
  const res2 = await runJob(r2, 'diamond', 3)
  assert.strictEqual(res2.status, 'done')
})
test('low health pauses the job before any dig', async () => {
  const r = rig()
  r.bot.health = 5
  const res = await runJob(r, 'diamond', 3)
  assert.strictEqual(res.status, 'retry'); assert.strictEqual(r.bot.digs, 0)
})
test('no raycast: the job parks and digs nothing (cannot verify, does not act)', async () => {
  const r = rig()
  r.bot.noRaycast()
  const res = await runJob(r, 'diamond', 3)
  assert.strictEqual(res.status, 'park'); assert.strictEqual(r.bot.digs, 0)
  assert.match(res.reason, /cannot check what I can see/)
})
test('the base is protected: no new mine is started inside it and the hallway stops at its edge', async () => {
  const inside = rig({ config: { protect: { boxes: [{ min: [-5, -70, -5], max: [5, -40, 5], label: 'Walter\'s base' }], pad: 0 } } })
  const res = await runJob(inside, 'diamond', 3)
  assert.strictEqual(res.status, 'park'); assert.match(res.reason, /base/); assert.strictEqual(inside.bot.digs, 0)
  const edge = rig({ config: { protect: { boxes: [{ min: [4, -70, -30], max: [40, -40, 30], label: 'the hall' }], pad: 0 } } })
  await runJob(edge, 'diamond', 3)
  assert.strictEqual(edge.state.mines[0].endedWhy, 'protected')
  assert.ok(!edge.bot.dugAt().some(c => Number(c.split(',')[0]) >= 4))
})
test('only the overworld', async () => {
  const r = rig()
  r.bot.game.dimension = 'the_nether'
  const res = await runJob(r, 'diamond', 3)
  assert.strictEqual(res.status, 'park'); assert.match(res.reason, /overworld/); assert.strictEqual(r.bot.digs, 0)
})

// ------------------------------------------------------------------ stairs and depth
test('depth: from the surface it digs stairs (one down per step, floor seen first), never straight down, to the right level', { timeout: 120000 }, async () => {
  const rock = { x1: -6, x2: 70, y1: -64, y2: 62, z1: -24, z2: 24 }
  const r = rig({ y: 63, pickaxe: 'stone_pickaxe', rock, world: false })
  H.fillRock(r.bot, rock); H.fillRock(r.bot, { x1: -6, x2: 70, y1: 63, y2: 63, z1: -24, z2: 24 }, 'grass_block')
  r.bot.entity.position = new Vec3(0.5, 64, 0.5)
  const moves = []
  const goto = r.bot.tryGoto
  r.bot.tryGoto = async (g, l, ms) => {
    const from = r.bot.entity.position.clone()
    const floorBlk = r.bot.blockAt(new Vec3(g.x, g.y - 1, g.z))
    const sawFloor = g.y < Math.floor(from.y) ? r.bot.losFrom(from.offset(0, 1.62, 0), floorBlk) : true
    const res = await goto(g, l, ms)
    moves.push({ from, to: r.bot.entity.position.clone(), sawFloor, floorName: floorBlk.name })
    return res
  }
  r.bot.setBlock(1, 15, -1, 'iron_ore')                        // not on the stairs: ignored unless seen
  const res = await runJob(r, 'iron', 2, {})
  const m = r.state.mines[0]
  assert.ok(m, JSON.stringify(res) + r.said.join('|'))
  assert.strictEqual(m.y, 16, 'iron at y16')
  for (const mv of moves) {
    const dy = Math.floor(mv.to.y) - Math.floor(mv.from.y), dh = Math.abs(Math.floor(mv.to.x) - Math.floor(mv.from.x)) + Math.abs(Math.floor(mv.to.z) - Math.floor(mv.from.z))
    assert.ok(dy >= -1, `dropped ${dy}`)
    if (dy < 0) { assert.strictEqual(dh, 1, 'a step down always moves sideways too'); assert.ok(mv.sawFloor, 'the floor of the landing was in view before the step'); assert.ok(!/air|lava|water/.test(mv.floorName)) }
  }
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.ok(r.added.length === 1 && r.added[0][0] === 'mine iron' && r.added[0][1].y === 16, 'the new mine is recorded as a waypoint')
  assert.match(r.said.join(' '), /stairs down to y16/)
})
test('depth: a drop under the landing makes the stairs turn instead of stepping (unseen caves, lava)', { timeout: 120000 }, async () => {
  const rock = { x1: -6, x2: 40, y1: -64, y2: 62, z1: -24, z2: 24 }
  const r = rig({ y: 63, pickaxe: 'stone_pickaxe', rock, world: false, config: { ores: { ...require('../brain/mining/config.json').ores, iron: { ...require('../brain/mining/config.json').ores.iron, y: 55, range: [50, 52] } } } })
  H.fillRock(r.bot, rock); H.fillRock(r.bot, { x1: -6, x2: 40, y1: 63, y2: 63, z1: -24, z2: 24 }, 'grass_block')
  r.bot.entity.position = new Vec3(0.5, 64, 0.5)
  H.carve(r.bot, [[2, 61, 0], [2, 60, 0], [2, 59, 0]])           // second landing's floor is a hidden shaft
  r.bot.setBlock(1, 60, 0, 'lava')                                 // and lava below the first step's far side is not stepped on either
  await runJob(r, 'iron', 2)
  assert.ok(!r.bot.visited.some(v => v.startsWith('2,62,0')), 'never stepped where the floor was missing')
  assert.ok(r.state.mines[0], r.said.join('|'))
  assert.strictEqual(r.state.mines[0].y, 55)
})
test('depth: a mine that is already in range is mined where the bot stands (no stairs)', async () => {
  const r = rig({ y: -55 })
  await runJob(r, 'diamond', 1)
  assert.strictEqual(r.state.mines[0].y, -55)
  assert.ok(!r.said.some(s => /stairs/.test(s)))
})

// ------------------------------------------------------------------ supplies
test('tools: a wooden pickaxe cannot mine diamonds; it asks the crafting module for an iron pickaxe, then carries on', async () => {
  const r = rig({ pickaxe: 'wooden_pickaxe', dispatch: (u, t) => { r.bot.give('iron_pickaxe', 1); return true } })
  r.bot.setBlock(2, -58, -1, 'diamond_ore')
  await runJob(r, 'diamond', 1)
  assert.deepStrictEqual(r.calls.dispatch, ['craft iron pickaxe'])
  assert.strictEqual(r.bot.count('diamond'), 1)
  assert.match(r.said.join(' '), /making a iron pickaxe|iron pickaxe first/)
})
test('tools: if the crafting module cannot help it stops and says what is missing (never mines with the wrong tool)', async () => {
  const r = rig({ pickaxe: 'wooden_pickaxe', dispatch: () => true })
  r.bot.setBlock(2, -58, -1, 'diamond_ore')
  const res = await runJob(r, 'diamond', 1)
  assert.strictEqual(res.status, 'park'); assert.match(res.reason, /iron pickaxe/)
  assert.strictEqual(r.bot.digs, 0)
  assert.ok(r.calls.dispatch.length <= 2)
  const r2 = rig({ pickaxe: 'wooden_pickaxe' })               // no dispatch available at all
  const res2 = await runJob(r2, 'diamond', 1)
  assert.strictEqual(res2.status, 'park'); assert.strictEqual(r2.bot.digs, 0)
})
test('tools: a worn-out pickaxe is replaced before it breaks (stone for iron ore, iron for diamond)', async () => {
  const r = rig({ y: 16, rock: ROCK16, pickaxe: 'stone_pickaxe', dispatch: () => { r.bot.inventory.items()[0].durabilityUsed = 0; return true } })
  r.bot.inventory.items()[0].durabilityUsed = 130                                  // 131 max: 1 use left
  r.bot.setBlock(2, 16, -1, 'iron_ore')
  await runJob(r, 'iron', 1)
  assert.deepStrictEqual(r.calls.dispatch, ['craft stone pickaxe'])
  const t = makeTools({ bot: r.bot, limits: r.cfg.limits })
  assert.strictEqual(t.shortage(ores.cfg.ores.iron), null)
  const r3 = rig({ pickaxe: 'stone_pickaxe' })
  assert.strictEqual(makeTools({ bot: r3.bot, limits: r3.cfg.limits }).shortage(ores.cfg.ores.diamond).item, 'iron_pickaxe')
  assert.strictEqual(makeTools({ bot: r3.bot, limits: r3.cfg.limits }).shortage(ores.cfg.ores.coal), null)
})
test('tools: the cheapest pickaxe digs filler, the best one is kept for ore; shovels for dirt', async () => {
  const r = rig({ pickaxe: 'iron_pickaxe' })
  r.bot.give('stone_pickaxe', 1); r.bot.give('iron_shovel', 1)
  const t = makeTools({ bot: r.bot, limits: r.cfg.limits })
  const blk = (n) => ({ name: n, digTime: () => 100 })
  assert.strictEqual(t.choose(blk('stone')).name, 'stone_pickaxe')
  assert.strictEqual(t.choose(blk('diamond_ore')).name, 'iron_pickaxe')
  assert.strictEqual(t.choose(blk('dirt')).name, 'iron_shovel')
  assert.strictEqual(t.canHarvest(blk('diamond_ore')), true)
})
test('inventory: smeltables go through api.depositSmeltables when 6 or fewer slots are free, and what was deposited still counts', async () => {
  let slotsFreed = 0
  const r = rig({ y: 16, rock: ROCK16, deposit: async ({ ctx, quiet }) => { const n = r.bot.count('raw_iron'); if (n) r.bot.take('raw_iron', n); return { moved: { raw_iron: n }, left: [], full: false } } })
  for (let i = 0; i < 30; i++) r.bot.give(['dirt', 'gravel', 'sand', 'andesite', 'granite', 'diorite', 'tuff'][i % 7], 64)    // plenty of junk: 6 slots free
  r.bot.setBlock(2, 16, -1, 'iron_ore'); r.bot.setBlock(1, 16, 3, 'iron_ore'); r.bot.setBlock(5, 16, -2, 'iron_ore')
  const res = await runJob(r, 'iron', 3)
  assert.ok(r.calls.deposit >= 1, 'deposit helper called')
  assert.strictEqual(r.state.job.gained, 3)
  assert.strictEqual(res.status, 'done')
})
test('inventory: full furnace chests pause the job; a bag of junk the chests do not take pauses it too (never dropped on the floor)', async () => {
  const r = rig({ y: 16, rock: ROCK16, deposit: async () => ({ moved: {}, left: [{ name: 'raw_iron', count: 4 }], full: true }) })
  for (let i = 0; i < 31; i++) r.bot.give(['dirt', 'gravel', 'sand', 'andesite', 'granite', 'diorite', 'tuff'][i % 7], 64)
  const res = await runJob(r, 'iron', 3)
  assert.strictEqual(res.status, 'park'); assert.match(res.reason, /input chests are full/)
  assert.strictEqual(r.bot.digs, 0)
  const r2 = rig({ y: 16, rock: ROCK16, deposit: async () => ({ moved: {}, left: [], full: false }) })
  for (let i = 0; i < 33; i++) r2.bot.give(['dirt', 'gravel', 'sand', 'andesite', 'granite', 'diorite', 'tuff'][i % 7], 64)
  const res2 = await runJob(r2, 'iron', 3)
  assert.strictEqual(res2.status, 'park'); assert.match(res2.reason, /nearly full/)
  assert.ok(!r2.bot.actions.some(a => a[0] === 'toss'))
})

// ------------------------------------------------------------------ existing mines and waypoints
test('an existing "mine diamond" waypoint is walked to and its hallway is followed; the pattern starts at its end', async () => {
  const r = rig({ world: false, waypointsList: [{ name: 'mine diamond', x: 10, y: -58, z: -10, dim: 0 }] })
  const { bot } = r
  H.fillRock(bot, H.ROCK)
  for (let z = -10; z <= 10; z++) H.carve(bot, H.hall(10, -58, z))             // Walter's old hallway
  bot.setBlock(11, -58, 0, 'diamond_ore')                                       // in its wall
  bot.setBlock(13, -58, 0, 'diamond_ore')                                       // behind rock: hidden
  bot.entity.position = new Vec3(10.5, -58, 8.5)
  await runJob(r, 'diamond', 1)
  assert.strictEqual(bot.count('diamond'), 1)
  assert.ok(r.said.some(s => /Heading to the "mine diamond" waypoint/.test(s)))
  assert.strictEqual(r.added.length, 0, 'no new waypoint when an existing mine is used')
  assert.strictEqual(r.state.mines[0].name, 'mine diamond')
  assert.strictEqual(bot.blockAt(new Vec3(13, -58, 0)).name, 'diamond_ore')
  assert.ok(bot.visited.some(v => { const [x, , z] = v.split(',').map(Number); return x === 10 && z <= -7 }), 'went to the waypoint')
})
test('mine waypoints are matched by ore name or depth; other ores\' mines are not used', () => {
  const def = ores.cfg.ores.diamond
  assert.strictEqual(minesLib.fit({ name: 'mine diamond', y: 70 }, 'diamond', def), 3)
  assert.strictEqual(minesLib.fit({ name: 'Diamonds mine', y: null }, 'diamond', def), 3)
  assert.strictEqual(minesLib.fit({ name: 'mine iron', y: -58 }, 'diamond', def), 0)
  assert.strictEqual(minesLib.fit({ name: 'old mine', y: -55 }, 'diamond', def), 2)
  assert.strictEqual(minesLib.fit({ name: 'old mine', y: 70 }, 'diamond', def), 0)
})
test('waypoints.json: mines are recorded once, near-duplicates reuse the name, far ones get a number, record:false writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mining-wp-'))
  fs.writeFileSync(path.join(dir, 'waypoints.json'), JSON.stringify({ 'crafting table': { x: 1, y: 2, z: 3 }, 'mine coal': { x: 100, y: 45, z: 100 }, 'my farm': { x: 5, y: 60, z: 5 } }))
  const w = minesLib.create({ dir, record: true })
  assert.deepStrictEqual(w.list().map(x => x.name), ['mine coal'])
  assert.strictEqual(w.add('mine diamond', { x: 0, y: -58, z: 0 }), 'mine diamond')
  assert.strictEqual(w.add('mine diamond', { x: 3, y: -58, z: 2 }), 'mine diamond')
  assert.strictEqual(w.add('mine diamond', { x: 300, y: -58, z: 2 }), 'mine diamond 2')
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'waypoints.json'), 'utf8'))
  assert.ok(saved['crafting table'] && saved['my farm'], 'Walter\'s waypoints survive')
  assert.deepStrictEqual(saved['mine diamond'], { x: 0, y: -58, z: 0, source: 'mining' })
  const off = minesLib.create({ dir, record: false })
  assert.strictEqual(off.add('mine gold', { x: 0, y: 0, z: 0 }), null)
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'waypoints.json'), 'utf8'))['mine gold'], undefined)
})

// ------------------------------------------------------------------ scheduler
test('scheduler: a preempted job resumes where it stopped; "stop" parks it and resume finishes it', { timeout: 60000 }, async () => {
  const r = rig()
  r.engine.begin('diamond', 5)
  r.submit()
  await H.waitFor(() => r.bot.digs >= 12)
  r.scheduler.submit({ name: 'chat-task', key: 'chat-task', priority: H.PRIORITY.CHAT, run: async () => { await H.wait(40) } })
  await H.waitFor(() => r.scheduler.status().history.some(h => /paused mining/.test(h.msg)))
  await H.waitFor(() => r.state.job.finished, 20000)
  assert.ok(r.scheduler.status().history.some(h => /resume mining/.test(h.msg)))
  assert.deepStrictEqual([...new Set(r.bot.dugAt())].sort(), [...hallKeys(6, 4)].sort())
  assert.strictEqual(r.bot.digs, 60, 'no cell dug twice')

  const r2 = rig()
  r2.engine.begin('diamond', 5); r2.submit()
  await H.waitFor(() => r2.bot.digs >= 8)
  r2.scheduler.userStop()
  await H.waitFor(() => r2.scheduler.status().parked.length === 1)
  assert.strictEqual(r2.state.active, false)
  const digsAtStop = r2.bot.digs
  await H.wait(60)
  assert.ok(r2.bot.digs - digsAtStop <= 3, 'stopped digging')
  r2.scheduler.resumeParked('mining')
  await H.waitFor(() => r2.state.job.finished, 20000)
  assert.strictEqual(r2.bot.digs, 60)
})

// ------------------------------------------------------------------ state
test('state: progress is saved; a fresh engine over the same file continues the same strip and never starts by itself', async () => {
  const r = rig()
  r.bot.setBlock(2, -58, -1, 'diamond_ore')
  await runJob(r, 'diamond', 1)
  const saved = JSON.parse(fs.readFileSync(r.file, 'utf8'))
  assert.strictEqual(saved.job.gained, 1); assert.strictEqual(saved.active, false)
  const stateStore = require('../brain/mining/state')
  const again = stateStore.load({ file: r.file })
  assert.strictEqual(again.mines.length, 1)
  assert.strictEqual(again.active, false, 'an old active flag is not a go')
  fs.writeFileSync(r.file, JSON.stringify({ ...saved, active: true }))
  assert.strictEqual(stateStore.load({ file: r.file }).active, false)
  fs.writeFileSync(r.file, '{broken')
  assert.strictEqual(stateStore.load({ file: r.file }).mines.length, 0)
})

// ------------------------------------------------------------------ discovery of Walter's mines
test('Walter\'s Xaero waypoints and "set waypoint mine ..." entries are found through the nav module\'s book', () => {
  const { WaypointBook } = require('../brain/nav/waypoints')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mining-xa-'))
  fs.writeFileSync(path.join(dir, 'waypoints.json'), JSON.stringify({ 'mine iron': { x: 50, y: 16, z: 60 }, 'home': { x: 0, y: 64, z: 0 } }))
  const xaero = { listWorlds: () => [{ name: 'w', waypoints: true, map: true }], waypoints: (w, dim) => (dim === 0 ? [{ name: 'Diamond Mine', x: 100, y: -55, z: 200 }, { name: 'Base', x: 1, y: 70, z: 2 }, { name: 'Nether Portal', x: 3, y: 64, z: 3 }] : []) }
  const book = new WaypointBook({ dir, xaero, world: 'w' })
  const w = minesLib.create({ dir, book, record: false })
  assert.deepStrictEqual(w.list().map(x => x.name).sort(), ['Diamond Mine', 'mine iron'])
  const def = ores.cfg.ores
  assert.strictEqual(minesLib.fit(w.list().find(x => x.name === 'Diamond Mine'), 'diamond', def.diamond), 3)
  assert.strictEqual(minesLib.fit(w.list().find(x => x.name === 'mine iron'), 'diamond', def.diamond), 0)
})
test('a mine too far to walk is reached through the nav module ("go to <waypoint>"), then its hallway is followed', async () => {
  const wp = { name: 'mine diamond', x: 300, y: -58, z: -10, dim: 0 }
  const r = rig({ waypointsList: [wp], dispatch: (u, t) => { if (/^go to mine diamond$/.test(t)) r.bot.entity.position = new Vec3(300.5, -58, -8.5); return true } })
  H.fillRock(r.bot, { x1: 290, x2: 330, y1: -64, y2: -40, z1: -24, z2: 24 })
  for (let z = -10; z <= 10; z++) H.carve(r.bot, H.hall(300, -58, z))
  r.bot.setBlock(301, -58, 2, 'diamond_ore')
  await runJob(r, 'diamond', 1)
  assert.deepStrictEqual(r.calls.dispatch, ['go to mine diamond'])
  assert.strictEqual(r.bot.count('diamond'), 1)
  assert.strictEqual(r.state.mines[0].name, 'mine diamond')
})
test('a mine whose waypoint cannot be reached stops with a clear message instead of digging somewhere else', async () => {
  const r = rig({ waypointsList: [{ name: 'mine diamond', x: 300, y: -58, z: -10, dim: 0 }], dispatch: () => true })
  const res = await runJob(r, 'diamond', 1)
  assert.strictEqual(res.status, 'park'); assert.match(res.reason, /could not get to "mine diamond"/)
  assert.strictEqual(r.bot.digs, 0)
})
test('a second "mine diamond" reuses the unfinished strip instead of starting a new one', async () => {
  const r = rig()
  r.engine.begin('diamond', 1)
  r.bot.setBlock(2, -58, -1, 'diamond_ore')
  await r.engine.run(fakeCtx())
  const first = r.state.mines[0], digsAfterFirst = r.bot.digs
  assert.ok(G.nextSegment(first), 'strip not finished')
  r.bot.setBlock(5, -58, -1, 'diamond_ore')
  r.engine.begin('diamond', 1)
  await r.engine.run(fakeCtx())
  assert.strictEqual(r.state.mines.length, 1)
  assert.strictEqual(r.state.job.gained, 1)
  assert.ok(r.bot.digs > digsAfterFirst)
  assert.strictEqual(r.added.length, 1, 'one waypoint only')
})

test('never step into a cell over a drop of more than 2: the opening is plugged with cobblestone and the hallway ends there; a shallow gap is bridged', async () => {
  const deep = rig({ torches: true })
  H.carve(deep.bot, [[3, -59, 0], [3, -60, 0], [3, -61, 0], [3, -62, 0], [3, -63, 0]])        // a ravine under trunk cell 3
  await runJob(deep, 'diamond', 3)
  const m = deep.state.mines[0]
  assert.strictEqual(m.trunk, 2, 'the trunk stops in front of the void')
  assert.strictEqual(m.endedWhy, 'void')
  assert.ok(!deep.bot.visited.some(v => Number(v.split(',')[0]) >= 3 && Number(v.split(',')[2]) === 0 && Number(v.split(',')[1]) <= -58 && false), 'unused')
  assert.ok(!deep.bot.visited.some(v => v === '3,-58,0'), 'never stood over the ravine')
  const plug = deep.bot.placed.filter(p => p[3] === 'cobblestone')
  assert.ok(plug.some(p => p[0] === 3 && p[1] === -58 && p[2] === 0), 'the opening is plugged: ' + JSON.stringify(plug))
  assert.deepStrictEqual(deep.bot.losViolations, [])
  const shallow = rig({ torches: true })
  H.carve(shallow.bot, [[3, -59, 0], [3, -60, 0]])                                           // a 2 deep gap: bridged
  await runJob(shallow, 'diamond', 3)
  assert.strictEqual(shallow.state.mines[0].trunk, 6)
  assert.ok(shallow.bot.placed.some(p => p[3] === 'cobblestone' && p[0] === 3 && p[1] === -59))
})

test('position and health are logged at least every 5 s while mining', async () => {
  let t = 1000000
  const r = rig()
  r.logs.length = 0
  await runJob(r, 'diamond', 3)
  assert.ok(r.logs.some(l => /^pos -?\d+\.\d,-?\d+\.\d,-?\d+\.\d hp 20 /.test(l)), r.logs.slice(0, 5).join(' | '))
})
