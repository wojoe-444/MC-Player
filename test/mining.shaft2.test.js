// Shaft follow-ups: the real raycast sees the ladder panel (ladders do not count as a wall in the way), cave fallback, backing / support blocks, and the way out of the mine.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const H = require('./mining.helpers')
const { rig, runJob, fakeCtx } = H
const cfgOres = require('../brain/mining/config.json').ores

const ROCK = { x1: -14, x2: 30, y1: -5, y2: 30, z1: -24, z2: 24 }
const IRON8 = { ores: { ...cfgOres, iron: { ...cfgOres.iron, y: 8, range: [6, 10] } } }
const BASE = { protect: { boxes: [{ min: [-20, 15, -10], max: [3, 40, 10], label: 'the base' }], pad: 0 }, shaft: { enabled: true, top: [0, 20, 0], useWithin: 400, askAbovePlanks: 24, batch: 48, maxAsks: 2 } }

// shaft column x=0,z=0, ladders from y=20 down to `existing` on the wall at x=1 (they face west), corridor at the top
function shaft(opts = {}) {
  const { ladders = 20, config = {}, existing = 16 } = opts
  const r = rig({ y: 20, pos: [-4.5, 20, 0.5], rock: ROCK, world: false, torches: true, pickaxe: 'stone_pickaxe', config: { ...IRON8, ...BASE, ...config }, dispatch: opts.dispatch })
  H.fillRock(r.bot, ROCK)
  for (let x = -8; x <= -1; x++) H.carve(r.bot, H.hall(x, 20, 0))
  r.bot.setBlock(0, 21, 0, 'air')
  for (let y = 20; y >= existing; y--) r.bot.setBlock(0, y, 0, 'ladder', { facing: 'west' })
  r.bot.entity.position = new Vec3(-4.5, 20, 0.5)
  if (ladders) r.bot.give('ladder', ladders)
  return r
}

test('shaft: water or lava in the shaft stops the extension before the bot steps in, and the bot stays put', async () => {
  const cases = [
    ['water in the cell below', (b) => b.setBlock(0, 12, 0, 'water'), /water/],
    ['lava showing up under the dug cell', (b) => b.setBlock(0, 11, 0, 'lava'), /Lava or water/],
    ['lava beside the next cell', (b) => b.setBlock(-1, 12, 0, 'lava'), /Lava or water|water/]
  ]
  for (const [name, mod, re] of cases) {
    const r = shaft()
    mod(r.bot)
    const res = await runJob(r, 'iron', 1)
    assert.strictEqual(res.status, 'park', `${name}: ${r.said.join(' | ')}`)
    assert.match(res.reason, re, name)
    const lowest = Math.min(...r.bot.visited.map(v => Number(v.split(',')[1])))
    assert.ok(lowest >= 13, `${name}: stepped down to y${lowest}`)
    assert.deepStrictEqual(r.bot.losViolations, [], name)
    assert.ok(r.bot.entity.position.y < 19, name + ': a park leaves the bot where it is (no automatic climb out); "come up" does that')
  }
})
test('shaft: a cave opening or void inside the ore band -> the strip starts right there instead of parking; outside the band -> stairs from there', async () => {
  const BAND = { ores: { ...cfgOres, iron: { ...cfgOres.iron, y: 8, range: [10, 14] } } }
  const r = shaft({ config: BAND })
  H.carve(r.bot, [[0, 12, 1], [0, 12, 2], [1, 12, 2]])                      // a cave beside the shaft cell at y12 (the bot is at y13 when it shows)
  r.bot.setBlock(-2, 13, -1, 'iron_ore')
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  const m = r.state.mines[0]
  assert.strictEqual(m.y, 13, 'strip at the depth where the shaft stopped'); assert.strictEqual(m.shaft, true)
  assert.ok(r.said.some(s => /opened into a cave here/.test(s)))
  assert.ok(!r.said.some(s => /Stairs from here/.test(s)))
  assert.strictEqual(r.bot.count('raw_iron'), 1)
  assert.deepStrictEqual(r.bot.losViolations, [])
  const r2 = shaft()
  H.carve(r2.bot, [[0, 11, 0], [0, 10, 0], [0, 9, 0]])
  const res2 = await runJob(r2, 'iron', 1)
  assert.strictEqual(res2.status, 'done', r2.said.join(' | '))
  assert.ok(r2.said.some(s => /Stairs from here down to y8/.test(s)))
  assert.strictEqual(r2.state.mines[0].y, 8)
})
test('shaft: a missing back wall is backed with a cobblestone block (placed with a clear ray), then the ladder hangs on it', async () => {
  const r = shaft()
  r.bot.setBlock(1, 12, 0, 'air')
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  assert.deepStrictEqual(r.bot.placed.filter(p => p[3] === 'cobblestone'), [[1, 12, 0, 'cobblestone']])
  assert.strictEqual(r.bot.blockAt(new Vec3(1, 12, 0)).name, 'cobblestone')
  for (let y = 8; y <= 15; y++) assert.strictEqual(r.bot.blockAt(new Vec3(0, y, 0)).name, 'ladder', `ladder at y${y}`)
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.ok(r.bot.placed.every(p => ['ladder', 'cobblestone', 'torch'].includes(p[3])))
  const r2 = shaft()
  H.carve(r2.bot, [[1, 12, 0], [1, 11, 0], [2, 12, 0], [1, 12, 1], [1, 12, -1]])
  const res2 = await runJob(r2, 'iron', 1)
  assert.strictEqual(r2.bot.placed.filter(p => p[3] === 'cobblestone').length, 0, 'nothing to back it with: no block placed')
  assert.ok(res2.status === 'done' || res2.status === 'park')
})
test('shaft: a gap under the lowest ladder gets a block (Walter allowed a block under the ladder)', async () => {
  const r = shaft()
  H.carve(r.bot, [[0, 7, 0], [0, 6, 0], [0, 5, 0]])
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  const cobbles = r.bot.placed.filter(p => p[3] === 'cobblestone')
  assert.ok(cobbles.length >= 1 && cobbles.every(p => p[0] === 0 && p[2] === 0), JSON.stringify(cobbles))
  assert.strictEqual(r.bot.blockAt(new Vec3(0, cobbles[0][1], 0)).name, 'cobblestone')
  assert.deepStrictEqual(r.bot.losViolations, [])
})
test('shaft: the thin ladder panel of the shaft itself does not block the view of the wall (it did, in the real raycast); a real wall still does', async () => {
  const r = shaft()
  const los = require('../brain/los')
  const torches = require('../brain/lighting/torches')({ bot: r.bot, canSee: (b) => los.canSee(r.bot, b), sleep: () => Promise.resolve() })
  r.bot.entity.position = new Vec3(0.5, 13, 0.5)
  for (let y = 13; y <= 20; y++) r.bot.setBlock(0, y, 0, 'ladder', { facing: 'west' })
  r.bot.setBlock(0, 12, 0, 'air')
  const wall = r.bot.blockAt(new Vec3(1, 12, 0))
  assert.strictEqual(los.canSee(r.bot, wall), false, 'the ordinary ray is stopped')
  assert.strictEqual(torches.seeThroughLadders(wall), true)
  r.bot.give('ladder', 1)
  assert.strictEqual((await torches.placeLadder(null, wall, new Vec3(-1, 0, 0))).ok, true)
  r.bot.setBlock(0, 12, 0, 'air'); r.bot.setBlock(0, 11, 0, 'air')
  const deep = r.bot.blockAt(new Vec3(1, 11, 0))
  r.bot.setBlock(0, 12, 0, 'stone')
  r.bot.give('ladder', 1)
  assert.strictEqual((await torches.placeLadder(null, deep, new Vec3(-1, 0, 0))).ok, false, 'a real block in the way still hides the wall')
})
test('exit: from the ladder the bot climbs back up by itself (jump held on the ladder, no pathfinder); a finished or parked shaft job leaves the mine', async () => {
  const r = shaft()
  await runJob(r, 'iron', 1)
  assert.ok(r.bot.entity.position.y >= 19.5, 'finished jobs leave the mine: ' + r.bot.entity.position.y)
  assert.ok(r.said.some(s => /Leaving the mine/.test(s)))
  const r2 = shaft()
  r2.bot.entity.position = new Vec3(0.5, 16, 0.5)
  const before = r2.bot.actions.filter(a => a[0] === 'goto').length
  const out = await r2.engine.exit.leaveMine(fakeCtx())
  assert.deepStrictEqual([out.ok, out.how], [true, 'climbed'])
  assert.ok(r2.bot.entity.position.y >= 19.8)
  assert.strictEqual(r2.bot.actions.filter(a => a[0] === 'goto').length, before, 'climbed directly, no pathfinding')
  assert.strictEqual((await r2.engine.exit.leaveMine(fakeCtx())).how, 'already at the top')
  const r3 = shaft({ ladders: 3 })
  const res = await runJob(r3, 'iron', 1)
  assert.strictEqual(res.status, 'park')
  assert.ok(r3.bot.entity.position.y >= 19.5, 'parked jobs leave the mine')
})
test('exit: cut off from the shaft (a pit with no way out) -> a hallway is cut to the shaft at the same level, then the ladder is climbed', async () => {
  const r = shaft({ existing: 8 })
  H.carve(r.bot, [[-6, 12, -3], [-6, 13, -3]])
  r.bot.entity.position = new Vec3(-5.5, 12, -2.5)
  const out = await r.engine.exit.leaveMine(fakeCtx())
  assert.deepStrictEqual([out.ok, out.how], [true, 'climbed'], JSON.stringify(out) + r.said.join(' | '))
  assert.ok(r.bot.entity.position.y >= 19.8)
  const dug = r.bot.dugAt()
  assert.ok(dug.length >= 8 && dug.every(c => Number(c.split(',')[1]) >= 12 && Number(c.split(',')[1]) <= 13), 'a 1x2 hallway at y12-13: ' + dug.length)
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.strictEqual(r.bot.placed.length, 0)
})
test('exit: pillar up with cobblestone steps when nothing else works (every step placed with a clear ray)', async () => {
  const r = shaft({ existing: 12 })
  H.carve(r.bot, [[-3, 6, 0], [-3, 7, 0]])
  r.bot.entity.position = new Vec3(-2.5, 6, 0.5)
  r.bot.give('cobblestone', 20)
  const pil = await r.engine.exit.pillarUp(fakeCtx(), 9)
  assert.strictEqual(pil, true)
  assert.ok(Math.floor(r.bot.entity.position.y) >= 9)
  assert.strictEqual(r.bot.placed.filter(p => p[3] === 'cobblestone').length, 3)
  assert.deepStrictEqual(r.bot.losViolations, [])
})
test('exit: the chat phrase', () => {
  const P = require('../brain/mining').phrases
  for (const t of ['come up', 'leave the mine', 'get out of the mine', 'climb out of the shaft', 'go to the surface']) assert.ok(P.LEAVE.test(t), t)
  for (const t of ['come here', 'come up here', 'mine iron', 'stop mining', 'go up the stairs']) assert.ok(!P.LEAVE.test(t), t)
})

test('resume: already on the shaft ladders, mining carries on down from where it is (never back up to the top), and descends with no key pressed', async () => {
  const r = shaft({ existing: 12 })
  r.bot.entity.position = new Vec3(0.5, 16, 0.5)                          // deep in the shaft, far below the top
  r.bot.setBlock(-2, 8, -1, 'iron_ore')
  const keys = []
  const setKey = r.bot.setControlState
  r.bot.setControlState = (k, v) => { keys.push([k, v]); return setKey(k, v) }
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  assert.ok(r.bot.visited.every(v => Number(v.split(',')[1]) <= 17), 'never walked back to the top: ' + r.bot.visited.slice(0, 5))
  assert.strictEqual(r.state.mines[0].y, 8)
  // going down existing ladders presses nothing; sneak is only used to hold still on the lowest ladder and is released again before any move
  const before = keys.findIndex(k => k[0] === 'jump' && k[1] === true)           // the final climb out
  const downKeys = keys.slice(0, before < 0 ? keys.length : before).filter(k => k[1] === true)
  assert.ok(downKeys.every(k => k[0] === 'sneak'), 'only sneak while descending: ' + JSON.stringify(downKeys.slice(0, 6)))
  const last = {}; for (const [k, v] of keys) last[k] = v
  assert.ok(!last.sneak && !last.forward && !last.jump, 'every key released at the end')
})

test('existing ladder bottom inside the ore band (Walter: set up the iron mine at the ladder\'s current terminating point): no extension, no ladders, the strip starts off the lowest rung', async () => {
  const BAND = { ores: { ...cfgOres, iron: { ...cfgOres.iron, y: 8, range: [10, 20] } }, protect: { boxes: [{ min: [-20, 30, -10], max: [3, 40, 10], label: 'the base' }], pad: 0 } }      // the real base is y100+; the mine at y16 is outside it
  const r = shaft({ config: BAND, ladders: 0 })                      // no ladders in the bag: nothing to make, nothing to ask
  r.bot.setBlock(-2, 16, -1, 'iron_ore')
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  assert.deepStrictEqual(r.calls.dispatch.filter(t => /ladder/.test(t)), [])
  assert.strictEqual(r.bot.placed.filter(p => p[3] === 'ladder').length, 0)
  const m = r.state.mines[0]
  assert.deepStrictEqual(m.origin, [0, 16, 0]); assert.strictEqual(m.shaft, true); assert.deepStrictEqual(m.dir, [-1, 0])
  assert.strictEqual(r.bot.count('raw_iron'), 1)
  assert.ok(r.said.some(s => /ladder already reaches y16/.test(s)), r.said.join(' | '))
  assert.ok(r.added.some(a => a[0] === 'mine iron' && a[1].y === 16))
  assert.deepStrictEqual(r.bot.losViolations, [])
})
test('shaft mine: coming back later slides down the shaft (no pathfinder search down the ladders) and mines on', async () => {
  const BAND = { ores: { ...cfgOres, iron: { ...cfgOres.iron, y: 8, range: [10, 20] } }, protect: { boxes: [{ min: [-20, 30, -10], max: [3, 40, 10], label: 'the base' }], pad: 0 } }      // the real base is y100+; the mine at y16 is outside it
  const r = shaft({ config: BAND, ladders: 0 })
  r.bot.setBlock(-2, 16, -1, 'iron_ore')
  await runJob(r, 'iron', 1)
  assert.ok(G_nextSegment(r.state.mines[0]), 'strip not finished')
  r.bot.entity.position = new Vec3(-4.5, 20, 0.5); r.bot.visited.length = 0
  r.bot.setBlock(-5, 16, -1, 'iron_ore'); r.bot.setBlock(-1, 16, 3, 'iron_ore')
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  assert.ok(!r.bot.visited.some(v => v.startsWith('0,') && v.split(',')[2] === '0' && Number(v.split(',')[1]) < 20 && Number(v.split(',')[1]) > 16), 'no pathfinding down the ladder cells: ' + r.bot.visited.slice(0, 6))
  assert.strictEqual(r.state.mines.length, 1)
})
const G_nextSegment = (m) => require('../brain/mining/geometry').nextSegment(m)
