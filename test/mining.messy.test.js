// Walter: "mines are not neat locations ... it needs to mine the next time it goes down there". The bottom of the shaft is whatever it is: gravel, sand, dirt walls, holes in the floor,
// caves, chests. The job digs what can be dug, bridges holes, walks open ground, and only safety (lava/water) or unbreakable/protected things stop it.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const H = require('./mining.helpers')
const { rig, runJob } = H
const cfgOres = require('../brain/mining/config.json').ores

const ROCK = { x1: -14, x2: 30, y1: -5, y2: 40, z1: -24, z2: 24 }
// the shaft ends at y27 in the iron band; the base box is far above (y100+), like the real one
const BAND = { ores: { ...cfgOres, iron: { ...cfgOres.iron, y: 16, range: [-8, 40] } }, protect: { boxes: [{ min: [-20, 100, -10], max: [3, 140, 10], label: 'the base' }], pad: 0 }, shaft: { enabled: true, top: [0, 36, 0], useWithin: 400, askAbovePlanks: 24, batch: 48, maxAsks: 2 } }

// shaft column x=0,z=0 with ladders on the north wall? no: ladders hang on the +x wall and face west (like the tests before); bottom ladder at y27, top at y36
function shaftBottom(fill = 'stone', opts = {}) {
  const r = rig({ y: 36, pos: [-4.5, 36, 0.5], rock: ROCK, world: false, torches: true, pickaxe: 'stone_pickaxe', ladders: 0, ...opts, config: { ...BAND, ...(opts.config || {}) } })
  H.fillRock(r.bot, ROCK, fill)
  for (let x = -8; x <= -1; x++) H.carve(r.bot, H.hall(x, 36, 0))
  r.bot.setBlock(0, 37, 0, 'air')
  for (let y = 36; y >= 27; y--) r.bot.setBlock(0, y, 0, 'ladder', { facing: 'west' })
  r.bot.setBlock(1, 27, 0, 'stone'); for (let y = 27; y <= 36; y++) r.bot.setBlock(1, y, 0, 'stone')            // the wall the ladders hang on
  r.bot.entity.position = new Vec3(-4.5, 36, 0.5)
  return r
}

test('messy bottom: gravel on every side, sand above: it digs it all, waits for the falls, and mines', async () => {
  const r = shaftBottom('gravel')
  for (let x = -4; x <= -1; x++) for (let z = -1; z <= 1; z++) for (let y = 29; y <= 30; y++) r.bot.setBlock(x, y, z, 'sand')      // sand over the hallway too
  r.bot.setBlock(-2, 27, -1, 'iron_ore')
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  assert.strictEqual(r.bot.count('raw_iron'), 1)
  const m = r.state.mines[0]
  assert.strictEqual(m.y, 27); assert.strictEqual(m.shaft, true); assert.ok(m.trunk >= 2, 'trunk ' + m.trunk)
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.deepStrictEqual(r.parks, [])
})
test('messy bottom: dirt, a mineshaft\'s planks and a cobweb are all just things to dig', async () => {
  const r = shaftBottom('dirt')
  r.bot.setBlock(-1, 27, 0, 'oak_planks'); r.bot.setBlock(-1, 28, 0, 'cobweb'); r.bot.setBlock(-2, 27, 0, 'rail')
  r.bot.setBlock(-3, 27, -1, 'iron_ore')
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  assert.strictEqual(r.bot.count('raw_iron'), 1)
  assert.ok(r.state.mines[0].trunk >= 3, 'trunk ' + r.state.mines[0].trunk)
  assert.strictEqual(r.bot.blockAt(new Vec3(-1, 27, 0)).name, 'air', 'the planks were dug')
})
test('messy bottom: a chest or bricks where the trunk would go -> it picks another side instead of parking', async () => {
  const r = shaftBottom('stone')
  r.bot.setBlock(-1, 27, 0, 'chest'); r.bot.setBlock(-1, 28, 0, 'stone_bricks')          // the side the ladder faces is blocked by things that must stay
  r.bot.setBlock(0, 27, 2, 'iron_ore')
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  assert.strictEqual(r.bot.blockAt(new Vec3(-1, 27, 0)).name, 'chest')
  const m = r.state.mines[0]
  assert.notDeepStrictEqual(m.dir, [-1, 0])
  assert.ok(r.state.job.gained === 1 || m.trunk >= 3)
})
test('messy bottom: a hole in the floor is bridged with cobblestone and the hallway goes on', async () => {
  const r = shaftBottom('stone')
  H.carve(r.bot, [[-1, 26, 0], [-1, 25, 0]])                                              // no floor under the first trunk cell
  r.bot.give('cobblestone', 10)
  r.bot.setBlock(-3, 27, -1, 'iron_ore')
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  assert.strictEqual(r.bot.count('raw_iron'), 1)
  assert.ok(r.bot.placed.some(p => p[3] === 'cobblestone' && p[0] === -1 && p[1] === 26), JSON.stringify(r.bot.placed))
  assert.deepStrictEqual(r.bot.losViolations, [])
})
test('messy bottom: a cave around the ladder is walked, not refused', async () => {
  const r = shaftBottom('stone')
  H.carve(r.bot, [[-1, 27, 0], [-1, 28, 0], [-2, 27, 0], [-2, 28, 0], [-3, 27, 0], [-3, 28, 0]])             // open ground in front of the ladder
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  assert.ok(r.state.mines[0] && r.state.mines[0].trunk >= 1, 'a hallway was started')
  assert.deepStrictEqual(r.parks, [])
})
test('messy bottom: only lava ends it (safety); the park is announced as an event with the reason and the position', async () => {
  const r = shaftBottom('stone')
  for (const [x, z] of [[-1, 0], [1, 0], [0, 1], [0, -1]]) { r.bot.setBlock(x, 27, z, 'lava'); r.bot.setBlock(x, 28, z, 'lava') }
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'park')
  assert.strictEqual(r.parks.length, 1)
  assert.strictEqual(r.parks[0].module, 'mining'); assert.ok(r.parks[0].reason.length > 10); assert.ok(r.parks[0].pos && typeof r.parks[0].pos.y === 'number')
  // a danger pause (health) is not a "please resolve me" event
  const r2 = shaftBottom('stone')
  r2.bot.health = 5
  await runJob(r2, 'iron', 1)
  assert.deepStrictEqual(r2.parks, [])
})
test('messy bottom: every side blocked by things that must stay and the pilot gets one park event; nothing is broken', async () => {
  const r = shaftBottom('stone', { config: { shaft: { ...BAND.shaft, maxRungs: 2 } } })
  for (let y = 27; y <= 35; y++) for (const [x, z] of [[-1, 0], [0, 1], [0, -1], [1, 0]]) r.bot.setBlock(x, y, z, 'chest')      // the rungs above are walled in too
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'park')
  assert.match(res.reason, /could not start a hallway on any side/)
  assert.strictEqual(r.parks.length, 1)
  for (const [x, z] of [[-1, 0], [0, 1], [0, -1], [1, 0]]) assert.strictEqual(r.bot.blockAt(new Vec3(x, 27, z)).name, 'chest')
})
test('messy bottom: nothing works at y27 but the rung above is fine -> it mines one level up instead of parking', async () => {
  const r = shaftBottom('stone')
  for (const [x, z] of [[-1, 0], [0, 1], [0, -1], [1, 0]]) { r.bot.setBlock(x, 27, z, 'chest'); r.bot.setBlock(x, 28, z, 'chest') }
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  assert.ok(r.state.mines[0].y >= 29 && r.state.mines[0].y <= 30, 'mined one or two rungs up: y' + r.state.mines[0].y)
  assert.deepStrictEqual(r.parks, [])
})

// the live case (04:58): the ladder (facing south, hanging on an andesite wall to the north) ends in a cave: air on the east, west and south with no floor, even under the ladder
function caveBottom(opts = {}) {
  const r = rig({ y: 36, pos: [-4.5, 36, 0.5], rock: ROCK, world: false, torches: true, pickaxe: 'stone_pickaxe', config: BAND, ladders: 0, ...opts })
  H.fillRock(r.bot, ROCK, 'stone')
  for (let x = -8; x <= -1; x++) H.carve(r.bot, H.hall(x, 36, 0))
  r.bot.setBlock(0, 37, 0, 'air')
  for (let y = 27; y <= 36; y++) { r.bot.setBlock(0, y, 0, 'ladder', { facing: 'south' }); r.bot.setBlock(0, y, -1, 'andesite') }
  for (let x = -1; x <= 1; x++) for (let z = 0; z <= 2; z++) for (let y = 22; y <= 28; y++) if (!(x === 0 && z === 0 && y >= 27)) r.bot.setBlock(x, y, z, 'air')
  r.bot.entity.position = new Vec3(-4.5, 36, 0.5)
  r.bot.give('cobblestone', 30)
  return r
}
test('live case + Walter\'s screenshot: the ladder ends in a cave -> the wall the ladders hang on is NEVER dug (the ladders stay), the cave sides are sealed, the mine starts a rung or more up', async () => {
  const r = caveBottom()
  r.bot.setBlock(1, 29, -3, 'iron_ore')
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  for (let y = 27; y <= 36; y++) { assert.strictEqual(r.bot.blockAt(new Vec3(0, y, 0)).name, 'ladder', `ladder at y${y} is still there`); assert.strictEqual(r.bot.blockAt(new Vec3(0, y, -1)).name, 'andesite', `wall behind the ladder at y${y} is intact`) }
  assert.ok(r.state.mines[0].y >= 28, 'mine at y' + r.state.mines[0].y)
  assert.ok(!r.bot.dugAt().some(c => c.startsWith('0,') && c.endsWith(',-1')), 'nothing dug in the column behind the ladders')
  assert.deepStrictEqual(r.parks, [])
})
test('the wall a ladder hangs on and the ladder cells are never dug, whatever the strip does (support check + ladder column)', async () => {
  const r = shaftBottom('stone')
  for (const [x, z] of [[-1, 0], [0, 1], [0, -1]]) for (let y = 27; y <= 35; y++) r.bot.setBlock(x, y, z, 'chest')
  r.bot.setBlock(1, 27, 0, 'stone')
  const res = await runJob(r, 'iron', 1)
  for (let y = 27; y <= 36; y++) { assert.strictEqual(r.bot.blockAt(new Vec3(0, y, 0)).name, 'ladder'); assert.strictEqual(r.bot.blockAt(new Vec3(1, y, 0)).name, 'stone', 'the wall behind the ladder y' + y) }
  assert.ok(res.status === 'done' || res.status === 'park')
})
test('live case: the stone wall side cannot be used -> the cave sides get a floor of cobblestone (a block under the ladder first), the trunk goes on from there', async () => {
  const r = caveBottom()
  r.bot.setBlock(0, 27, -1, 'chest'); r.bot.setBlock(0, 28, -1, 'chest')
  r.bot.setBlock(3, 27, 1, 'iron_ore')
  r.bot.setBlock(3, 27, 0, 'stone')
  const res = await runJob(r, 'iron', 1)
  assert.ok(res.status === 'done' || res.status === 'park', r.said.join(' | '))
  const cobbles = r.bot.placed.filter(p => p[3] === 'cobblestone')
  assert.ok(cobbles.some(p => p[0] === 0 && p[1] === 26 && p[2] === 0), 'a block under the ladder: ' + JSON.stringify(cobbles))
  assert.ok(cobbles.length >= 2, 'then a bridge: ' + JSON.stringify(cobbles))
  assert.deepStrictEqual(r.bot.losViolations, [])
  assert.strictEqual(r.bot.blockAt(new Vec3(0, 27, -1)).name, 'chest')
})
test('park at the shaft bottom: the bot stays where it is (no climb out) so someone can fix it there', async () => {
  const r = shaftBottom('stone', { config: { shaft: { ...BAND.shaft, maxRungs: 2 } } })
  for (let y = 27; y <= 35; y++) for (const [x, z] of [[-1, 0], [0, 1], [0, -1], [1, 0]]) r.bot.setBlock(x, y, z, 'chest')
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'park')
  assert.ok(r.bot.entity.position.y <= 33, 'still down at the bottom: y' + r.bot.entity.position.y)
  assert.ok(!r.said.some(s => /Leaving the mine/.test(s)))
})
