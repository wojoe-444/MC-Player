// brain/telemetry: the pure detectors on synthetic ring data, and the module wired to a mock bot.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const D = require('../brain/telemetry/detectors')
const register = require('../brain/telemetry')
const { mockBot } = require('./mock-bot')

const T0 = 1_700_000_000_000
// seconds of samples at 4 Hz; f(i, tSec) -> partial sample
function ring(seconds, f) {
  const out = []
  for (let i = 0; i <= seconds * 4; i++) {
    const s = i / 4
    out.push({ t: T0 + s * 1000, x: 0, y: 64, z: 0, g: 1, vy: 0, yaw: 0, h: '', mv: 0, act: 0, dg: '', tk: '', hp: 20, ...f(i, s) })
  }
  return out
}
const now = (ss) => ss[ss.length - 1].t
const kinds = (flags) => flags.map(f => f.kind).sort()

test('a bot walking in a straight line gets no flags', () => {
  const ss = ring(130, (i, s) => ({ x: s * 0.2, mv: 1, h: 'stone_pickaxe', tk: 'autopilot' }))
  const ev = Array.from({ length: 6 }, (_, i) => ({ k: 'jump', t: T0 + i * 20000 }))
  assert.deepStrictEqual(D.analyze(ss, ev, now(ss)), [])
})

test('jumping on the spot is flagged high; bunny-hopping across the map only medium', () => {
  const ss = ring(70, () => ({}))
  const ev = Array.from({ length: 30 }, (_, i) => ({ k: 'jump', t: T0 + 10000 + i * 1500 }))
  let f = D.analyze(ss, ev, now(ss)).find(x => x.kind === 'jumping')
  assert.ok(f && f.sev === 'high', JSON.stringify(f))
  assert.match(f.msg, /30 jumps/)
  const walking = ring(70, (i, s) => ({ x: s * 0.3, mv: 1 }))
  const hop = Array.from({ length: 45 }, (_, i) => ({ k: 'jump', t: T0 + 10000 + i * 1200 }))
  f = D.analyze(walking, hop, now(walking)).find(x => x.kind === 'jumping')
  assert.strictEqual(f.sev, 'med')
  // ordinary terrain jumping while travelling: nothing
  assert.ok(!D.analyze(walking, hop.slice(0, 12), now(walking)).some(x => x.kind === 'jumping'))
})

test('pillar: jumps looking down with no height gained, or with a sword in hand, is pillar_failing; a working pillar is not', () => {
  // Smeo444 2026-11-10: sword in hand, jumping on the spot, never getting up
  const sword = ring(30, () => ({ h: 'stone_sword', pit: 1.4 }))
  const jumps = (n, from = 10000) => Array.from({ length: n }, (_, i) => ({ k: 'jump', t: T0 + from + i * 1200 }))
  let f = D.analyze(sword, jumps(10), now(sword)).find(x => x.kind === 'pillar_failing')
  assert.ok(f && f.sev === 'high'); assert.match(f.msg, /stone_sword.*not a placeable block/); assert.strictEqual(f.data.heightGained, 0)
  // holding dirt but the blocks do not land: no height
  const dirt = ring(30, () => ({ h: 'dirt', pit: 1.4 }))
  f = D.analyze(dirt, jumps(8), now(dirt)).find(x => x.kind === 'pillar_failing')
  assert.ok(f); assert.match(f.msg, /0 block\(s\) placed, height gained 0/)
  // working pillar: y rises 1 block per jump, a block lands under every jump
  const up = ring(30, (i, s) => ({ h: 'dirt', pit: 1.4, y: 64 + Math.floor(s / 1.2) }))
  const placed = jumps(10).map(e => ({ k: 'place', t: e.t + 100, block: 'dirt', x: 0, y: 64, z: 0, sky: true, tk: 'autopilot' }))
  const flags = D.analyze(up, [...jumps(10), ...placed], now(up))
  assert.ok(!flags.some(x => x.kind === 'pillar_failing' || x.kind === 'jumping'), JSON.stringify(flags.map(x => x.kind)))
  // jumping on the spot while not looking down is the plain jumping flag, not a pillar
  const level = ring(70, () => ({ h: 'stone_sword', pit: 0 }))
  const flags2 = D.analyze(level, jumps(30), now(level))
  assert.ok(flags2.some(x => x.kind === 'jumping') && !flags2.some(x => x.kind === 'pillar_failing'))
})

test('pacing back and forth is oscillation; a long walk is not', () => {
  const pace = ring(40, (i, s) => ({ x: Math.abs(((s * 1.2) % 4) - 2), mv: 1 }))     // 0..2 and back, 1.2 b/s
  const f = D.analyze(pace, [], now(pace)).find(x => x.kind === 'oscillating')
  assert.ok(f, 'oscillation expected'); assert.ok(f.data.extent <= 2.1)
  const walk = ring(40, (i, s) => ({ x: s * 1.2, mv: 1 }))
  assert.ok(!D.analyze(walk, [], now(walk)).some(x => x.kind === 'oscillating'))
})

test('stuck: pathfinder active but no progress; digging in place is not stuck', () => {
  const stuck = ring(30, () => ({ mv: 1, tk: 'nav' }))
  assert.ok(D.analyze(stuck, [], now(stuck)).some(x => x.kind === 'stuck'))
  const digging = ring(30, () => ({ mv: 1, act: 1, dg: 'oak_log' }))
  assert.ok(!D.analyze(digging, [], now(digging)).some(x => x.kind === 'stuck'))
})

test('idle: 2 minutes of nothing is medium, 5 minutes high; sleeping or digging resets it', () => {
  const two = ring(125, () => ({ tk: 'autopilot' }))
  let f = D.analyze(two, [], now(two)).find(x => x.kind === 'idle')
  assert.ok(f && f.sev === 'med')
  const five = ring(305, () => ({}))
  assert.strictEqual(D.analyze(five, [], now(five)).find(x => x.kind === 'idle').sev, 'high')
  const slept = ring(125, (i) => ({ act: i === 40 ? 1 : 0 }))
  assert.ok(!D.analyze(slept, [], now(slept)).some(x => x.kind === 'idle'))
  const dug = ring(125, () => ({}))
  assert.ok(!D.analyze(dug, [{ k: 'dig', t: T0 + 100000, block: 'dirt', x: 0, y: 63, z: 0 }], now(dug)).some(x => x.kind === 'idle'))
})

test('toolCheck: the whitelist comes from the block data (material, hardness, harvestTools)', () => {
  const log = { name: 'oak_log', material: 'mineable/axe', hardness: 2 }
  const sword = { name: 'stone_sword', type: 1 }
  let c = D.toolCheck(log, sword, ['stone_sword', 'stone_axe'])
  assert.deepStrictEqual([c.need, c.ok, c.have, c.harvestOk], ['axe', false, true, true])
  assert.strictEqual(D.toolCheck(log, { name: 'stone_axe', type: 2 }, ['stone_axe']).ok, true)
  assert.strictEqual(D.toolCheck(log, null, ['stone_axe']).ok, false)                       // bare hand on a tree
  const stone = { name: 'stone', material: 'mineable/pickaxe', hardness: 1.5, harvestTools: { 800: true } }
  c = D.toolCheck(stone, null, ['stone_pickaxe'])
  assert.deepStrictEqual([c.harvestOk, c.have, c.ok], [false, true, false])
  assert.strictEqual(D.toolCheck(stone, { name: 'stone_pickaxe', type: 800 }, []).harvestOk, true)
  assert.strictEqual(D.toolCheck({ name: 'dirt', material: 'mineable/shovel', hardness: 0.5 }, { name: 'stone_shovel', type: 9 }, []).ok, true)
  // leaves: hoe or shears; wool: shears; cobweb: sword or shears; instant-break blocks accept anything
  const leaves = { name: 'oak_leaves', material: 'leaves;mineable/hoe', hardness: 0.2 }
  assert.deepStrictEqual(D.toolCheck(leaves, { name: 'shears', type: 3 }, []).ok, true)
  assert.strictEqual(D.toolCheck(leaves, { name: 'stone_sword', type: 1 }, ['shears']).ok, false)
  assert.strictEqual(D.toolCheck({ name: 'white_wool', material: 'wool', hardness: 0.8 }, { name: 'shears', type: 3 }, []).ok, true)
  assert.strictEqual(D.toolCheck({ name: 'cobweb', material: 'coweb', hardness: 4 }, { name: 'stone_sword', type: 1 }, []).ok, true)
  assert.strictEqual(D.toolCheck({ name: 'oak_sapling', material: 'default', hardness: 0 }, sword, []).ok, true)
  assert.strictEqual(D.toolCheck({ name: 'torch', material: 'default', hardness: 0 }, null, []).need, null)
})

test('toolCheck against the real minecraft-data 1.21.6 blocks', () => {
  const data = require('minecraft-data')('1.21.6'), B = (n) => data.blocksByName[n]
  const sword = { name: 'diamond_sword', type: data.itemsByName.diamond_sword.id }
  for (const n of ['oak_log', 'birch_planks', 'stone', 'deepslate_iron_ore', 'dirt', 'sand', 'gravel', 'oak_leaves', 'white_wool', 'glow_lichen', 'obsidian'])
    assert.strictEqual(D.toolCheck(B(n), sword, []).ok, false, n + ' with a sword must not be whitelisted')
  assert.strictEqual(D.toolCheck(B('oak_sapling'), sword, []).ok, true)
  assert.strictEqual(D.toolCheck(B('cobweb'), sword, []).ok, true)
  assert.strictEqual(D.toolCheck(B('stone'), { name: 'stone_pickaxe', type: data.itemsByName.stone_pickaxe.id }, []).harvestOk, true)
  assert.strictEqual(D.toolCheck(B('stone'), null, ['wooden_pickaxe']).harvestOk, false)
  assert.strictEqual(D.toolCheck(B('diamond_ore'), { name: 'stone_pickaxe', type: data.itemsByName.stone_pickaxe.id }, []).harvestOk, false)    // needs iron tier
  assert.strictEqual(D.toolCheck(B('sand'), { name: 'stone_shovel', type: data.itemsByName.stone_shovel.id }, []).ok, true)
})

test('wrong_tool needs 2 wrong digs in 5 min; cannot_harvest is high at once', () => {
  const ss = ring(60, () => ({}))
  const dig = (i, over) => ({ k: 'dig', t: T0 + i * 5000, block: 'oak_log', x: i, y: 64, z: 0, held: 'stone_sword', need: 'axe', have: true, ok: false, harvestOk: true, ...over })
  assert.ok(!D.analyze(ss, [dig(1)], now(ss)).some(f => f.kind === 'wrong_tool'))
  const f = D.analyze(ss, [dig(1), dig(2), dig(3), dig(4, { ok: true })], now(ss)).find(x => x.kind === 'wrong_tool')
  assert.ok(f); assert.match(f.msg, /3 of 4 digs/); assert.match(f.msg, /oak_log with stone_sword x3/)
  const h = D.analyze(ss, [dig(1, { block: 'stone', need: 'pickaxe', held: '', harvestOk: false })], now(ss)).find(x => x.kind === 'cannot_harvest')
  assert.ok(h && h.sev === 'high')
})

test('staircase: successive levels dug one step sideways; a straight shaft is not one', () => {
  const ss = ring(60, () => ({}))
  const stairs = [0, 1, 2, 3, 4].map(i => ({ k: 'dig', t: T0 + i * 4000, block: 'dirt', x: 10 + i, y: 70 - i, z: 5 }))
  const f = D.analyze(ss, stairs, now(ss)).find(x => x.kind === 'staircase')
  assert.ok(f, 'staircase expected'); assert.strictEqual(f.data.levels, 5)
  const shaft = [0, 1, 2, 3, 4].map(i => ({ k: 'dig', t: T0 + i * 4000, block: 'dirt', x: 10, y: 70 - i, z: 5 }))
  assert.ok(!D.analyze(ss, shaft, now(ss)).some(x => x.kind === 'staircase'))
})

test('surface_blocks: filler placed in open air, but not under a roof or torches', () => {
  const ss = ring(30, () => ({}))
  const pl = (i, over) => ({ k: 'place', t: T0 + i * 1000, block: 'cobblestone', x: i, y: 70, z: 0, sky: true, tk: 'autopilot', ...over })
  assert.ok(!D.analyze(ss, [0, 1, 2].map(i => pl(i)), now(ss)).some(f => f.kind === 'surface_blocks'))
  assert.ok(D.analyze(ss, [0, 1, 2, 3].map(i => pl(i)), now(ss)).some(f => f.kind === 'surface_blocks'))
  assert.ok(!D.analyze(ss, [0, 1, 2, 3].map(i => pl(i, { sky: false })), now(ss)).some(f => f.kind === 'surface_blocks'))
  assert.ok(!D.analyze(ss, [0, 1, 2, 3].map(i => pl(i, { block: 'torch' })), now(ss)).some(f => f.kind === 'surface_blocks'))
})

test('repeated_failure and lava_in_hand', () => {
  const ss = ring(30, (i, s) => ({ x: s * 1, h: 'lava_bucket', mv: 1 }))
  const fails = Array.from({ length: 6 }, (_, i) => ({ k: 'fail', t: T0 + i * 3000, what: 'noPath', note: 'nav' }))
  const flags = D.analyze(ss, fails, now(ss))
  assert.ok(flags.some(f => f.kind === 'repeated_failure' && f.sev === 'med'))
  assert.ok(flags.some(f => f.kind === 'lava_in_hand'))
})

test('counters summarize time by task and held item', () => {
  const ss = ring(60, (i, s) => ({ tk: s < 30 ? 'a' : 'b', h: 'stone_axe', x: s }))
  const c = D.counters(ss, [{ k: 'jump', t: T0 + 5000 }], now(ss), 120000)
  assert.ok(c.secondsByTask.a >= 29 && c.secondsByTask.b >= 29)
  assert.strictEqual(c.jumps, 1); assert.strictEqual(c.secondsByHeldItem.stone_axe > 59, true)
  assert.ok(c.blocksWalked >= 55)
})

// ---- the module on a mock bot ----
function rig() {
  const bot = mockBot({ pos: [0, 64, 0] })
  bot.entity.velocity = new Vec3(0, 0, 0)
  bot.inventory.items = () => [{ name: 'stone_sword' }, { name: 'stone_axe' }]
  bot.blockAt = () => null
  bot.targetDigBlock = null
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemetry-'))
  let clock = T0
  const events = new EventEmitter()
  const api = { bot, events, now: () => clock, log() {}, dir, statePath: (f) => path.join(dir, f) }
  const h = register(api)
  return { bot, dir, h, events, advance: (ms) => { clock += ms } }
}

test('module: counts jumps from physics ticks, records the dig tool mismatch, writes summary and a flag excerpt', () => {
  const { bot, dir, h, events, advance } = rig()
  h.start()
  events.emit('task', { event: 'start', task: { name: 'autopilot' } })
  bot.heldItem = { name: 'stone_sword', type: 5 }
  const log = { name: 'oak_log', material: 'mineable/axe', position: new Vec3(3, 64, 3) }
  for (let n = 0; n < 4; n++) {
    log.position = new Vec3(3 + n, 64, 3); bot.targetDigBlock = log
    h._tick.sample(); advance(250)
    bot.targetDigBlock = null; h._tick.sample(); advance(250)
  }
  // 25 jumps in place
  for (let i = 0; i < 25; i++) {
    bot.entity.onGround = true; bot.emit('physicsTick')
    bot.entity.onGround = false; bot.entity.velocity = new Vec3(0, 0.42, 0); bot.emit('physicsTick')
    advance(500); h._tick.sample()
  }
  h._tick.analyze()
  const sum = JSON.parse(fs.readFileSync(path.join(dir, 'telemetry/summary.json'), 'utf8'))
  assert.strictEqual(sum.last1min.jumps, 25)
  assert.strictEqual(sum.last1min.digsWithWrongTool, 4)
  assert.ok(sum.flags.some(f => f.kind === 'jumping' && f.sev === 'high'))
  assert.ok(sum.flags.some(f => f.kind === 'wrong_tool'))
  assert.strictEqual(sum.now.task, 'autopilot')
  const lines = fs.readFileSync(path.join(dir, 'telemetry/flags.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(lines.some(l => l.kind === 'jumping' && l.excerpt.length > 3))
  // the same problem still going on is counted, not logged again
  const n = lines.length
  advance(1000); h._tick.analyze()
  assert.strictEqual(fs.readFileSync(path.join(dir, 'telemetry/flags.jsonl'), 'utf8').trim().split('\n').length, n)
  h.stop()
})

test('module: placements record open sky; path failures and failed tasks become fail events', () => {
  const { bot, dir, h, events, advance } = rig()
  h.start()
  bot.blockAt = () => null                         // nothing above: open sky
  for (let i = 0; i < 5; i++) bot.emit('blockPlaced', { name: 'air' }, { name: 'cobblestone', position: new Vec3(i, 70, 0) })
  bot.blockAt = () => ({ boundingBox: 'block' })   // roofed
  bot.emit('blockPlaced', { name: 'air' }, { name: 'cobblestone', position: new Vec3(9, 70, 0) })
  for (let i = 0; i < 5; i++) bot.emit('path_update', { status: 'noPath' })
  bot.emit('path_update', { status: 'success' })
  events.emit('task', { event: 'failed', task: { name: 'mining' } })
  advance(1000); h._tick.sample(); h._tick.analyze()
  const sum = JSON.parse(fs.readFileSync(path.join(dir, 'telemetry/summary.json'), 'utf8'))
  assert.strictEqual(sum.last1min.placed, 6); assert.strictEqual(sum.last1min.placedOpenAir, 5)
  assert.deepStrictEqual(sum.last1min.failures, { noPath: 5, taskFailed: 1 })
  assert.ok(sum.flags.some(f => f.kind === 'surface_blocks'))
  assert.ok(sum.flags.some(f => f.kind === 'repeated_failure'))
  h.stop()
})

test('module: active medium/high flags appear in REVIEW-ALERTS.md at once, with no model involved', () => {
  const { bot, dir, h, advance } = rig()
  h.start()
  bot.heldItem = { name: 'stone_sword', type: 5 }
  bot.entity.pitch = 1.4
  for (let i = 0; i < 30; i++) {
    bot.entity.onGround = true; bot.emit('physicsTick'); bot.entity.onGround = false; bot.entity.velocity = new Vec3(0, 0.42, 0); bot.emit('physicsTick')
    advance(500); h._tick.sample()
  }
  h._tick.analyze()
  const md = fs.readFileSync(path.join(dir, 'REVIEW-ALERTS.md'), 'utf8')
  assert.match(md, /\[HIGH\] pillar_failing/); assert.match(md, /stone_sword/); assert.match(md, /no model in the loop/)
  h.stop()
})

test('torchTooClose: torch-air-air-torch (3 apart on a line) is fine; closer on a line, or touching, is not', () => {
  const t = (x, y, z) => ({ x, y, z })
  assert.strictEqual(D.torchTooClose(t(0, 64, 0), t(3, 64, 0)), false)       // [torch air air torch]
  assert.strictEqual(D.torchTooClose(t(0, 64, 0), t(0, 64, -3)), false)
  assert.strictEqual(D.torchTooClose(t(0, 64, 0), t(2, 64, 0)), true)        // torch air torch
  assert.strictEqual(D.torchTooClose(t(0, 64, 0), t(0, 64, 1)), true)        // adjacent
  assert.strictEqual(D.torchTooClose(t(0, 64, 0), t(1, 64, 1)), true)        // diagonal neighbour
  assert.strictEqual(D.torchTooClose(t(0, 64, 0), t(2, 64, 2)), false)       // not on one axis line
  assert.strictEqual(D.torchTooClose(t(0, 64, 0), t(1, 65, 0)), false)       // different height
  assert.strictEqual(D.torchTooClose(t(0, 64, 0), t(0, 64, 0)), false)       // itself
})

test('module: a torch placed 2 blocks from another becomes a torch_spacing event and flag; a proper gap does not', () => {
  const { bot, dir, h, advance } = rig()
  const ids = { torch: 100, wall_torch: 101, soul_torch: 102, soul_wall_torch: 103 }
  bot.registry = { blocksByName: Object.fromEntries(Object.entries(ids).map(([n, id]) => [n, { id }])) }
  const world = [new Vec3(0, 64, 0), new Vec3(10, 64, 0)]
  bot.findBlocks = ({ point }) => world.filter(q => q.distanceTo(point) <= 4)
  h.start()
  bot.emit('blockPlaced', { name: 'air' }, { name: 'torch', position: new Vec3(3, 64, 0) })       // 3 from the first: fine
  advance(1000); h._tick.sample(); h._tick.analyze()
  assert.ok(!h._tick.summary().flags.some(f => f.kind === 'torch_spacing'))
  bot.emit('blockPlaced', { name: 'air' }, { name: 'torch', position: new Vec3(0, 64, 2) })       // 2 from the first on the z line: too close
  bot.emit('blockPlaced', { name: 'air' }, { name: 'cobblestone', position: new Vec3(1, 64, 0) }) // not a torch
  advance(1000); h._tick.sample(); h._tick.analyze()
  const f = h._tick.summary().flags.find(x => x.kind === 'torch_spacing')
  assert.ok(f && f.sev === 'med'); assert.match(f.msg, /0,64,2 is 2 block\(s\) from another at 0,64,0/); assert.match(f.msg, /still keeps the area lit/)
  assert.match(fs.readFileSync(path.join(dir, 'REVIEW-ALERTS.md'), 'utf8'), /torch_spacing/)
  h.stop()
})
