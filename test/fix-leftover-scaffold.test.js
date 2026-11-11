// Work order leftover-scaffold: scaffolding pillars left standing. The tidy step (brain/autopilot/plan.js, tidyList0 and the step's run) takes a
// leftover cluster down top first. A cell is put on the list when what is above it is passable or is itself on the list (topFirst in
// brain/leftovers/lib.js). The passable test in plan.js reads boundingBox 'block', and leaves are 'block', so a block with leaves directly above it
// never gets on the list: its own cover check (the overhead loop in tidyList0) already ignores leaves and logs, so the block is eligible and then
// dropped. In the 2026-11-11 world two single blocks stood under oak leaves for about two hours (listed at 16:43Z, still there at 18:34Z) while the blocks around them were taken down.
// The test drives the real tidy step (plan() on the real goals picker, with a made-up world) and fails on the top block only.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

const BB = (name) => (/^(air|cave_air|void_air)$/.test(name) ? 'empty' : 'block')

// a tiny world: 'x,y,z' -> block name; any other cell is air. The mine call digs at once (the reach and the path are not what is tested here).
function rig(blocks, clusters) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-leftover-scaffold-'))
  const world = new Map(Object.entries(blocks))
  const key = (x, y, z) => `${x},${y},${z}`
  const name = (x, y, z) => world.get(key(x, y, z)) || 'air'
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(30.5, 64, 30.5) }
  bot.time = { day: 3, timeOfDay: 6000 }
  bot.health = 20; bot.food = 20
  bot.registry = { blocksArray: [], blocksByName: {} }
  bot.findBlocks = () => []
  bot._leftovers = { scaffold: () => clusters, trees: () => [], scan() {}, last() {} }
  const block = (x, y, z) => { const n = name(x, y, z); return { name: n, boundingBox: BB(n), position: new Vec3(x, y, z) } }
  const base = {
    bot, goals: { GoalNear: function () {} }, v: (x, y, z) => new Vec3(x, y, z),
    block: (p) => block(p.x, p.y, p.z),
    flo: (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    isAir: (b) => !!b && /^(air|cave_air|void_air)$/.test(b.name),
    isLiquid: () => false, isNight: () => false, dist: () => 0, check() {}, wait: async () => {}, say() {},
    mined: [],
    mine: async (b) => { base.mined.push(key(b.position.x, b.position.y, b.position.z)); world.set(key(b.position.x, b.position.y, b.position.z), 'air'); return true },
  }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const api = { statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) } }
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  G.state.home = [12, 64, 12]
  require('../brain/autopilot/plan')(G, S, {}, api, () => {})
  const tidy = G.steps.find(s => s.id === 'tidy')
  return { G, tidy, name, mined: base.mined, dispose: () => { try { G.dispose && G.dispose() } catch {} } }
}

const bedAtHome = { '12,64,12': 'red_bed' }
const cluster = (cells) => ({ id: 'scaffold@test', what: 'scaffold', kind: 'pillar', n: cells.length, h: 3, w: 1, d: 1, cells })

test('control: a scaffold column with open air above it comes down top first in one visit', async () => {
  const cells = [[10, 64, 10], [10, 65, 10], [10, 66, 10]]
  const blocks = { ...bedAtHome }
  for (const [x, y, z] of cells) blocks[key3(x, y, z)] = 'cobblestone'
  const r = rig(blocks, [cluster(cells)])
  try {
    assert.ok(r.tidy, 'the tidy step exists')
    await r.tidy.run()
    for (const [x, y, z] of cells) assert.strictEqual(r.name(x, y, z), 'air', `${x},${y},${z} still stands`)
  } finally { r.dispose() }
})

test('a scaffold top with leaves directly above it comes down too: leaves do not hold a block up (the cover check already ignores them)', async () => {
  const cells = [[14, 64, 14], [14, 65, 14], [14, 66, 14]]
  const blocks = { ...bedAtHome }
  for (const [x, y, z] of cells) blocks[key3(x, y, z)] = 'cobblestone'
  blocks[key3(14, 67, 14)] = 'oak_leaves'; blocks[key3(14, 68, 14)] = 'oak_leaves'; blocks[key3(13, 67, 14)] = 'oak_leaves'
  const r = rig(blocks, [cluster(cells)])
  try {
    await r.tidy.run()
    assert.strictEqual(r.name(14, 65, 14), 'air', 'the block below the top was not taken down')
    assert.strictEqual(r.name(14, 66, 14), 'air', 'the top block under the leaves still stands after the visit (the blocks below it were taken, so it is left floating)')
  } finally { r.dispose() }
})

function key3(x, y, z) { return `${x},${y},${z}` }
