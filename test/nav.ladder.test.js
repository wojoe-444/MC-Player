// The iron-mine ladder shaft at -1042,27..128,2281 (real blocks read from Walter's save, test/fixtures/shaft-bottom.json).
// Live bug 2026-10-26: the bot stood at the bottom of the shaft and every goal failed ("No path" / stuck), even after Walter put a block
// under the ladder. Two causes, both in how the library handles ladders:
//   1. a path node in a ladder cell is lifted onto the top of the ladder block (y + 1) and aimed 0.2 blocks INTO the ladder plate. Beside the
//      block under the ladder (the bot has to jump onto it) the first node is then 2 blocks up and sits in the corner next to the plate, so the
//      jump is never made and the bot steers into the corner and stops
//   2. nav's own stuck monitor took a long climb for "dithering" (small area, no horizontal movement) and gave up at level 5
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { rig, makeSim, legacyMovements, goals, Vec3 } = require('./nav.helpers')

const FIX = path.join(__dirname, 'fixtures', 'shaft-bottom.json')
const TOP = new goals.GoalBlock(-1042, 33, 2281)              // seven rungs up, inside the ladder column
const STARTS = {
  'open face (south of the ladder, where the bot was reported)': [-1043.5, 25, 2282.5],
  'beside the block under the ladder, from the east': [-1038.5, 26, 2281.5],
  'the far cave (reported stuck at about -1025,26,2273)': [-1024.5, 26, 2273.5]
}

test('the library alone cannot mount the ladder from the side of the block under it (the live bug)', async () => {
  const sim = makeSim({ pos: STARTS['beside the block under the ladder, from the east'] })
  sim.loadSnapshot(FIX); await sim.settle(30)
  legacyMovements(sim.bot); sim.bot.pathfinder.thinkTimeout = 300
  const r = await sim.goto(TOP, { maxTicks: 300 })
  assert.strictEqual(r.ok, false)
  assert.ok(sim.at().y < 27, 'still on the cave floor: ' + sim.at())
  sim.dispose()
})

test('with nav the ladder is mounted and climbed from every start (jump onto the block, then up the rungs)', async () => {
  for (const [name, start] of Object.entries(STARTS)) {
    const r = await rig({ pos: start }, s => s.loadSnapshot(FIX))
    r.bot.pathfinder.thinkTimeout = 3000
    const res = await r.go(TOP, { maxTicks: 1200, after: 0 })
    assert.ok(res.ok, `${name}: ${JSON.stringify(res)}`)
    assert.ok(r.sim.at().y >= 32 && Math.abs(r.sim.at().x + 1041.5) < 0.6, `${name}: ${r.sim.at()}`)
    assert.strictEqual(r.nav.status().stuck.maxLevel, 0, `${name}: no stuck episodes`)
    r.close()
  }
})

test('path fix: ascending ladder nodes go back into their cells, the entry node is aimed at the cell centre, the rest keep the plate bias, descending nodes are untouched', async () => {
  const r = await rig({ pos: STARTS['beside the block under the ladder, from the east'] }, s => s.loadSnapshot(FIX))
  const P = (x, y, z) => { const v = new Vec3(x, y, z); v.toBreak = []; v.toPlace = []; return v }
  // what the library hands over for the shaft: east approach, then nodes lifted by +1 and aimed at z + 0.3
  const path = [P(-1039.5, 26, 2281.5), P(-1040.5, 26, 2281.5), P(-1041.5, 28, 2281.3), P(-1041.5, 29, 2281.3), P(-1041.5, 30, 2281.3)]
  const fixed = r.nav.doors.fixLadders(path)
  assert.strictEqual(fixed, 3)
  assert.deepStrictEqual(path.slice(2).map(n => n.y), [27, 28, 29])
  assert.deepStrictEqual([path[2].x, path[2].z], [-1041.5, 2281.5], 'entry node: centre of the cell')
  assert.strictEqual(path[3].z, 2281.3, 'later rungs keep the bias that presses the bot into the plate')
  const down = [P(-1041.5, 30, 2281.5), P(-1041.5, 29, 2281.5)]                     // centred by the library when descending
  assert.strictEqual(r.nav.doors.fixLadders(down), 0)
  r.close()
})

test('a long climb is not "dithering": 90 rungs up a one-block shaft, no stuck episode, arrives on top', async () => {
  const r = await rig({ pos: [3.5, 64, 0.5], bounds: { x0: -10, x1: 20, y0: 0, y1: 200, z0: -10, z1: 10 } }, s => {
    s.floor(-8, -8, 18, 8, 63); s.fill(5, 64, -1, 5, 154, -1, 'stone'); s.ladder(5, 64, 154, 0, 'south'); s.fill(6, 154, -1, 9, 154, 1, 'stone')
  })
  const res = await r.go(new goals.GoalBlock(7, 155, 0), { maxTicks: 3500, after: 0 })
  assert.ok(res.ok, JSON.stringify(res) + r.logs.join('\n'))
  assert.strictEqual(r.nav.status().stuck.episodes, 0)
  r.close()
})

// ---------------------------------------------------------------- descending: on a ladder you go down by doing nothing
test('descent: no control state is held while sliding down the rungs (no forward, no sprint, never sneak), at the same speed as doing nothing', async () => {
  for (const facing of ['south', 'north', 'east', 'west']) {
    const wall = { south: [5, -1], north: [5, 1], east: [4, 0], west: [6, 0] }[facing]
    const r = await rig({ pos: [5.5, 100, 0.5], bounds: { x0: -10, x1: 20, y0: 0, y1: 200, z0: -10, z1: 10 } }, s => {
      s.floor(-8, -8, 18, 8, 63); s.fill(wall[0], 64, wall[1], wall[0], 100, wall[1], 'stone'); s.ladder(5, 64, 100, 0, facing)
    })
    r.sim.bot.entity.position = new Vec3(5.5, 100, 0.5); r.sim.bot.entity.velocity = new Vec3(0, 0, 0)
    const held = [], sneaked = [], vys = []
    r.bot.on('physicsTick', () => {
      const y = r.bot.entity.position.y
      if (r.bot.controlState.sneak) sneaked.push(y)
      if (y < 98 && y > 70) { held.push(Object.entries(r.bot.controlState).filter(([k, v]) => v).map(([k]) => k).join('+')); vys.push(r.bot.entity.velocity.y) }
    })
    const t0 = r.sim.ticks
    const res = await r.go(new goals.GoalBlock(5, 64, 0), { maxTicks: 600, after: 0 })
    assert.ok(res.ok, `${facing}: ${JSON.stringify(res)}`)
    assert.ok(held.length > 100, `${facing}: the slide was observed`)
    assert.deepStrictEqual([...new Set(held)], [''], `${facing}: controls held on the rungs: ${[...new Set(held)]}`)
    assert.deepStrictEqual(sneaked, [], `${facing}: never sneaks`)
    assert.ok(Math.min(...vys) > -0.3, `${facing}: a slide (${Math.min(...vys)}), not a fall`)
    assert.ok(r.sim.ticks - t0 < 270, `${facing}: ${r.sim.ticks - t0} ticks`)
    assert.ok(r.nav.status().ladderDescentTicks > 150)
    r.close()
  }
})

test('descent in the real shaft: from inside the ladder column down to the cave floor, no keys held on the way', async () => {
  const r = await rig({ pos: [-1041.5, 34, 2281.5] }, s => s.loadSnapshot(FIX))
  r.sim.bot.entity.position = new Vec3(-1041.5, 34, 2281.49); r.sim.bot.entity.velocity = new Vec3(0, 0, 0)
  const held = []
  r.bot.on('physicsTick', () => { const y = r.bot.entity.position.y; if (y < 33 && y > 29.5 && Math.abs(r.bot.entity.position.x + 1041.5) < 0.6) held.push(Object.entries(r.bot.controlState).filter(([k, v]) => v).map(([k]) => k).join('+')) })
  const res = await r.go(new goals.GoalBlock(-1043, 25, 2282), { maxTicks: 800, after: 0 })
  assert.ok(res.ok, JSON.stringify(res))
  assert.deepStrictEqual([...new Set(held)], [''], 'nothing held while sliding: ' + [...new Set(held)])
  assert.ok(r.sim.at().y < 27)
  r.close()
})

test('the assist does not touch climbing up, or walking next to a ladder', async () => {
  const r = await rig({ pos: [3.5, 64, 0.5], bounds: { x0: -10, x1: 20, y0: 0, y1: 200, z0: -10, z1: 10 } }, s => {
    s.floor(-8, -8, 18, 8, 63); s.fill(5, 64, -1, 5, 90, -1, 'stone'); s.ladder(5, 64, 90, 0, 'south'); s.fill(6, 90, -1, 9, 90, 1, 'stone')
  })
  const up = await r.go(new goals.GoalBlock(7, 91, 0), { maxTicks: 800, after: 0 })
  assert.ok(up.ok, JSON.stringify(up))
  assert.strictEqual(r.nav.status().ladderDescentTicks, 0, 'not a single tick of "do nothing" on the way up')
  r.close()
})
