// Mining off Walter's ladder shaft: ladders are extended down to the ore's depth (line of sight, one per block, back wall), then the strip starts there.
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('vec3')
const H = require('./mining.helpers')
const { rig, runJob, fakeCtx, k } = H
const cfgOres = require('../brain/mining/config.json').ores

// shaft column x=0,z=0 from the top cell y=20 down; existing ladders y=20..16 on the back wall (x=1, ladder faces west); a corridor leads to the top.
// iron is moved to y=8 for the test (range 6..10), so the shaft has to be extended from y=15 down to y=8 (8 ladders).
const ROCK = { x1: -14, x2: 30, y1: -5, y2: 30, z1: -24, z2: 24 }
const IRON8 = { ores: { ...cfgOres, iron: { ...cfgOres.iron, y: 8, range: [6, 10] } } }
const BASE = { protect: { boxes: [{ min: [-20, 15, -10], max: [3, 40, 10], label: "Walter's base" }], pad: 0 }, shaft: { enabled: true, top: [0, 20, 0], useWithin: 400, askAbovePlanks: 24, batch: 48, maxAsks: 2 } }

function shaft(opts = {}) {
  const { ladders = 20, config = {}, bag = {}, existing = 16 } = opts
  const r = rig({ y: 20, pos: [-4.5, 20, 0.5], rock: ROCK, world: false, torches: true, pickaxe: 'stone_pickaxe', config: { ...IRON8, ...BASE, ...config }, dispatch: opts.dispatch, waypointsList: opts.waypointsList || [], deposit: opts.deposit })
  H.fillRock(r.bot, ROCK)
  for (let x = -8; x <= -1; x++) H.carve(r.bot, H.hall(x, 20, 0))                      // corridor at the top of the shaft
  for (let y = 20; y >= existing; y--) { r.bot.setBlock(0, y, 0, 'ladder', { facing: 'west' }); r.bot.setBlock(0, y + 1, 0, y === 20 ? 'air' : 'ladder', { facing: 'west' }) }
  r.bot.setBlock(0, 21, 0, 'air')
  for (let y = 20; y >= existing; y--) r.bot.setBlock(0, y, 0, 'ladder', { facing: 'west' })
  r.bot.entity.position = new Vec3(-4.5, 20, 0.5)
  if (ladders) r.bot.give('ladder', ladders)
  for (const [n, c] of Object.entries(bag)) r.bot.give(n, c)
  return r
}
const ladderAt = (r, y) => r.bot.blockAt(new Vec3(0, y, 0))

test('shaft: iron below the base -> the ladder is extended one block at a time on the back wall, then the strip starts where it reaches iron depth', async () => {
  const r = shaft()
  r.bot.setBlock(-2, 8, -1, 'iron_ore')
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  for (let y = 8; y <= 20; y++) { const b = ladderAt(r, y); assert.strictEqual(b.name, 'ladder', `y${y}`); assert.strictEqual(b.getProperties().facing, 'west', 'on the back wall') }
  assert.strictEqual(r.bot.placed.filter(p => p[3] === 'ladder').length, 8)
  assert.ok(r.bot.placed.every(p => p[3] === 'ladder' || p[3] === 'torch'), 'only ladders (and torches)')
  assert.strictEqual(r.bot.count('ladder'), 12)
  const m = r.state.mines[0]
  assert.deepStrictEqual(m.origin, [0, 8, 0]); assert.deepStrictEqual(m.dir, [-1, 0]); assert.strictEqual(m.shaft, true)
  assert.ok(r.added.some(a => a[0] === 'mine iron' && a[1].y === 8))
  assert.strictEqual(r.bot.count('raw_iron'), 1)
  assert.deepStrictEqual(r.bot.losViolations, [])
  // inside the base only the shaft column was dug
  for (const d of r.bot.digLog.filter(d => d.y >= 15)) assert.ok(d.x === 0 && d.z === 0, `dug ${d.x},${d.y},${d.z} inside the base`)
  assert.ok(r.said.some(s => /Extending the ladder from y16 down to y8 \(8 ladders\)/.test(s)))
  // the branches at the shaft never touch the wall the ladder hangs on (x=1)
  assert.strictEqual(r.bot.blockAt(new Vec3(1, 8, 0)).name, 'stone')
})
test('shaft: every ladder is placed with a clear ray to the wall block and the placing is audited; the shaft stays 1x1', async () => {
  const r = shaft()
  await runJob(r, 'iron', 1)
  assert.deepStrictEqual(r.bot.losViolations, [])
  for (let y = 10; y <= 15; y++) for (const [dx, dz] of [[-1, 0], [0, 1], [0, -1], [1, 0]]) assert.notStrictEqual(r.bot.blockAt(new Vec3(dx, y, dz)).name, 'air', `side of y${y}`)
  const placedAfterDig = r.bot.actions.filter(a => a[0] === 'dig' && a[2] === 0 && a[4] === 0).length
  assert.ok(placedAfterDig >= 8)
})
test('shaft: ladders are crafted through the crafting module before the descent; a lot of wood is asked about first', async () => {
  // a few ladders to make: no question, one craft call
  const small = shaft({ ladders: 0, dispatch: (u, t) => { if (/^craft \d+ ladder$/.test(t)) small.bot.give('ladder', 9); return true } })
  await runJob(small, 'iron', 1)
  assert.deepStrictEqual(small.calls.dispatch.filter(t => /ladder/.test(t)), ['craft 8 ladder'])
  assert.strictEqual(small.bot.placed.filter(p => p[3] === 'ladder').length, 8)
  // far more than askAbovePlanks: parks with the question, nothing crafted, nothing dug
  const big = shaft({ ladders: 0, config: { shaft: { ...BASE.shaft, askAbovePlanks: 2 } }, dispatch: () => true })
  const res = await runJob(big, 'iron', 1)
  assert.strictEqual(res.status, 'park')
  assert.match(res.reason, /OK to use that wood\? Say "yes, use the wood" or "stair mine instead"/)
  assert.match(res.reason, /about 8 ladders/)
  assert.deepStrictEqual(big.calls.dispatch.filter(t => /ladder/.test(t)), [])
  assert.strictEqual(big.bot.digs, 0)
  assert.strictEqual(big.state.ladder.asking, true)
  // approved -> it crafts and carries on
  big.state.ladder.approval = 'wood'; big.state.ladder.asking = false
  big.engine.begin('iron', 1)
  big.calls.dispatch.length = 0
  const again = shaft({ ladders: 0, config: { shaft: { ...BASE.shaft, askAbovePlanks: 2 } }, dispatch: (u, t) => { again.bot.give('ladder', 9); return true } })
  again.engine = again.engine
  again.state.ladder = { approval: 'wood', asking: false }
  const done = await runJob(again, 'iron', 1)
  assert.strictEqual(done.status, 'done'); assert.strictEqual(again.bot.placed.filter(p => p[3] === 'ladder').length, 8)
})
test('shaft: if the crafting module cannot make the ladders the job stops and says the wood is short', async () => {
  const r = shaft({ ladders: 0, dispatch: () => true })
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'park'); assert.match(res.reason, /wood is short/)
  assert.ok(r.calls.dispatch.length <= 4)
  assert.strictEqual(r.bot.digs, 0)
})
test('shaft: "stair mine instead" -> down the existing ladders, then stairs from the shaft bottom (protection lifted below it only); no ladders placed', async () => {
  const r = shaft({ ladders: 0 })
  r.state.ladder = { approval: 'stairs', asking: false }
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  assert.strictEqual(r.bot.placed.filter(p => p[3] === 'ladder').length, 0)
  assert.strictEqual(r.state.mines[0].y, 8)
  assert.ok(r.state.ladder.stairsFrom === 16)
  assert.ok(!r.bot.digLog.some(d => d.y > 18), 'nothing dug above the bottom of the shaft (+2)')
  assert.ok(r.said.some(s => /Stair mine from the bottom of the shaft/.test(s)))
  assert.deepStrictEqual(r.bot.losViolations, [])
})
test('shaft: running out of ladders on the way parks instead of dropping; no ray -> nothing happens', async () => {
  const r = shaft({ ladders: 3 })
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'park'); assert.match(res.reason, /Out of ladders|more ladders/)
  const r2 = shaft({ ladders: 20 })
  r2.bot.noRaycast()
  const res2 = await runJob(r2, 'iron', 1)
  assert.strictEqual(res2.status, 'park'); assert.strictEqual(r2.bot.digs, 0)
})
test('shaft: the mine is remembered; the next iron job walks down the ladder to it and mines on without placing anything', async () => {
  const wps = []
  const r = shaft({ waypointsList: wps })
  r.bot.setBlock(-2, 8, -1, 'iron_ore')
  await runJob(r, 'iron', 1)
  const placedFirst = r.bot.placed.length, waypointsFirst = r.added.length
  assert.ok(r.added.some(a => a[0] === 'mine iron'))
  // a new session: the strip record is gone, only Walter's waypoint is left; the bot is back at the top of the shaft
  wps.push({ name: 'mine iron', x: 0, y: 8, z: 0, dim: 0 })
  r.state.mines = []; r.state.mineId = null
  r.bot.entity.position = new Vec3(-4.5, 20, 0.5); r.bot.visited.length = 0
  r.bot.setBlock(-1, 8, 3, 'iron_ore')                         // in the wall of the old hallway that was dug first
  const res = await runJob(r, 'iron', 1)
  assert.strictEqual(res.status, 'done', r.said.join(' | '))
  assert.strictEqual(r.bot.placed.length, placedFirst, 'nothing placed on the second trip')
  assert.strictEqual(r.added.length, waypointsFirst, 'no second waypoint')
  assert.ok(r.bot.visited.some(v => v.startsWith('0,8,0') || v.startsWith('0,9,0') || v.startsWith('0,10,0')), 'went down the ladder')
  assert.strictEqual(r.state.mines[0].name, 'mine iron')
  assert.strictEqual(r.state.job.gained, 1)
  assert.deepStrictEqual(r.bot.losViolations, [])
})
test('shaft: when the ore lies above the shaft top (or the shaft is switched off) the ordinary stairs are used', async () => {
  const off = shaft({ config: { shaft: { ...BASE.shaft, enabled: false } } })
  const res = await runJob(off, 'iron', 1)
  assert.strictEqual(res.status, 'park')                       // inside the base box: no stairs, as before
  assert.match(res.reason, /Walter's base|protected/)
  assert.strictEqual(off.bot.placed.filter(p => p[3] === 'ladder').length, 0)
})

test('shaft: Walter\'s answer about the wood works as a bare yes/no while the question is open, and as explicit phrases any time', () => {
  const fs = require('fs'), os = require('os'), path = require('path')
  const { Scheduler, PRIORITY } = require('../brain/scheduler')
  const safehand = require('../brain/safehand')
  const register = require('../brain/mining')
  const r = rig({})
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mining-chat-'))
  const said = [], cmds = []
  let clock = 1e12
  const api = {
    bot: r.bot, scheduler: new Scheduler({ graceMs: 300, idleAfterMs: 0 }), PRIORITY, say: (t) => said.push(t), goals: r.bot.goals, tryGoto: r.bot.tryGoto, stopNav() {}, safehand: safehand({ bot: r.bot }),
    canSee: () => false, ownerName: 'OGWO', dir, statePath: (f) => path.join(dir, f), log() {}, now: () => clock,
    commands: { add: (c) => cmds.push(c), dispatch: () => false }
  }
  const h = register(api)
  const ask = () => { h.state.job = { ore: 'iron', amount: 5, drop: 'raw_iron', gained: 0, lastHave: 0, finished: true }; h.state.ladder = { approval: null, asking: true, askedAt: clock } }
  assert.strictEqual(h.onChat('OGWO', 'yes'), false, 'nothing asked -> not claimed')
  ask()
  assert.strictEqual(h.onChat('someone else', 'yes'), false, 'only the owner answers')
  assert.strictEqual(h.onChat('OGWO', 'Yes!'), true); assert.strictEqual(h.state.ladder.approval, 'wood'); assert.strictEqual(h.state.ladder.asking, false)
  ask(); assert.strictEqual(h.onChat('OGWO', 'yes, use the wood'), true); assert.strictEqual(h.state.ladder.approval, 'wood')
  ask(); assert.strictEqual(h.onChat('OGWO', 'no'), true); assert.strictEqual(h.state.ladder.approval, 'stairs')
  ask(); assert.strictEqual(h.onChat('OGWO', 'stair mine instead'), true); assert.strictEqual(h.state.ladder.approval, 'stairs')
  ask(); assert.strictEqual(h.onChat('OGWO', 'what are you doing'), false); assert.strictEqual(h.state.ladder.asking, true)
  clock += 13 * 3600000; assert.strictEqual(h.onChat('OGWO', 'yes'), false, 'the question expires after 12 hours')
  const wood = cmds.find(c => c.name === 'mining-ladders-wood'), stairs = cmds.find(c => c.name === 'mining-ladders-stairs')
  for (const t of ['use the wood for the ladders', 'ladders are ok', 'use the sticks for ladders']) assert.ok(wood.match.test(t), t)
  for (const t of ['use the wood to build a house', 'craft ladder', 'mine iron']) assert.ok(!wood.match.test(t), t)
  for (const t of ['stair mine instead', 'stairs instead of ladders', 'no ladders', "don't use the wood"]) assert.ok(stairs.match.test(t), t)
  for (const t of ['mine iron', 'stairs are fun', 'climb the ladder']) assert.ok(!stairs.match.test(t), t)
  h.stop()
})
