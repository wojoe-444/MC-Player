const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const { Vec3 } = require('vec3')
const h = require('./build.helpers')
const { rig, fakeCtx, wait, waitFor, PRIORITY, blueprint: bp, stateStore, nameAt, snapshot, diff, assertClean, assertBuilt } = h
const { findSite } = require('../brain/build/survey')

test('a crash in the middle: the restarted engine first takes the recorded pillar down, then continues; nothing is placed twice', async () => {
  const r = rig()
  let crashed = null
  r.bot.onPlaceAsync = async (n, rec) => {
    if (!crashed && rec.name === 'stone_bricks' && rec.y >= r.origin.oy + 6) { crashed = { n, y: rec.feetY }; await new Promise(() => {}) }   // the process "dies" here, up on the pillar
  }
  const first = r.engine.run(fakeCtx())                           // never settles
  first.catch(() => {})
  await waitFor(() => crashed)
  assert.ok(r.bot.entity.position.y >= r.origin.oy + 6, 'the bot is up on the pillar when the process dies')
  const onDisk = JSON.parse(fs.readFileSync(r.file, 'utf8'))
  assert.ok(onDisk.pillar && onDisk.pillar.cells.length >= 6, 'pillar cells were saved as they were placed')
  assert.ok(onDisk.placed.length > 40)
  // restart: new engine, state read back from disk, the same world
  r.bot.onPlaceAsync = null
  const state2 = stateStore.load({ file: r.file })
  const engine2 = r.make(state2, () => fs.writeFileSync(r.file, JSON.stringify(state2)))
  const placedAtCrash = r.bot.placements.length
  const res = await engine2.run(fakeCtx())
  assert.deepStrictEqual(res, { status: 'done' })
  const firstDig = r.bot.digLog[0]
  assert.strictEqual(firstDig.placedSoFar, placedAtCrash, 'the pillar comes down before anything new is placed')
  assert.ok(r.bot.digLog.slice(0, 6).every((d, i) => i === 0 || d.y < r.bot.digLog[i - 1].y), 'from the top down')
  r.state.finished = true
  assertClean(r); assertBuilt({ ...r, state: state2 })
  // not one block was placed twice (the pillar column is rebuilt, which is expected)
  assert.ok(r.bot.placements.length < r.steps().length + 10 + 10, 'a second pillar at most')
})

test('a pillar left behind with the bot on the ground next to it comes down from the side (what is in reach, in view)', async () => {
  const r = rig()
  const o = r.origin
  const cells = []
  for (let y = 0; y < 4; y++) { r.bot.setBlock(r.cx, o.oy + y, r.cz, 'cobblestone'); cells.push(`${r.cx},${o.oy + y},${r.cz}`) }
  r.state.pillar = { x: r.cx, z: r.cz, cells }; r.save()
  r.bot.entity.position = new Vec3(r.cx - 1 + 0.5, o.oy, r.cz + 0.5)
  const res = await r.engine.run(fakeCtx())
  assert.deepStrictEqual(res, { status: 'done' })
  assert.deepStrictEqual(r.bot.digLog.slice(0, 4).map(d => d.y - o.oy), [3, 2, 1, 0], 'highest first')
  assertClean(r); assertBuilt(r)
})

test('a hostile in view: the job pauses, comes down from the pillar and retries; it carries on when the coast is clear', async () => {
  const r = rig()
  const o = r.origin
  let injected = false
  r.bot.onPlace = (n, rec) => {
    if (!injected && rec.name === 'stone_bricks' && rec.y === o.oy + 2) { injected = true; r.bot.entities[1] = { id: 1, name: 'zombie', position: new Vec3(r.cx + 1.5, o.oy + 2, r.cz + 0.5), height: 1.95 } }
  }
  const res = await r.engine.run(fakeCtx())
  assert.strictEqual(res.status, 'retry'); assert.ok(res.afterMs > 0)
  assert.strictEqual(r.bot.entity.position.y, o.oy, 'down on the floor'); assert.strictEqual(r.state.pillar, null)
  assert.strictEqual(r.bot.digLog.length >= 2, true)
  assert.ok(r.said.some(t => /paused: a zombie is near/.test(t)))
  const n = r.bot.placements.length
  // still there: still paused, nothing new placed
  const again = await r.engine.run(fakeCtx({ resumed: true }))
  assert.strictEqual(again.status, 'retry'); assert.strictEqual(r.bot.placements.length, n)
  delete r.bot.entities[1]
  const done = await r.engine.run(fakeCtx({ resumed: true }))
  assert.deepStrictEqual(done, { status: 'done' })
  assertClean(r); assertBuilt(r)
})

test('hostile or low health: only what is in view and close counts; health below 8 pauses', () => {
  const r = rig()
  const o = r.origin
  r.bot.entity.position = new Vec3(r.cx + 0.5, o.oy, r.cz + 0.5)
  assert.strictEqual(r.engine.danger(), null)
  r.bot.entities[1] = { id: 1, name: 'zombie', position: new Vec3(r.cx + 4.5, o.oy, r.cz + 0.5), height: 1.95 }
  assert.match(r.engine.danger(), /a zombie is near/)
  for (let y = 0; y < 3; y++) r.bot.setBlock(r.cx + 2, o.oy + y, r.cz, 'stone_bricks')            // a wall in between: not in view
  for (let y = 0; y < 3; y++) { r.bot.setBlock(r.cx + 2, o.oy + y, r.cz + 1, 'stone_bricks'); r.bot.setBlock(r.cx + 2, o.oy + y, r.cz - 1, 'stone_bricks') }
  assert.strictEqual(r.engine.danger(), null, 'a zombie behind a wall is not "in view"')
  r.bot.entities[1].position = new Vec3(r.cx + 7.5, o.oy, r.cz + 0.5)
  assert.strictEqual(r.engine.danger(), null, 'too far')
  r.bot.entities[2] = { id: 2, name: 'cow', position: new Vec3(r.cx + 1.5, o.oy, r.cz + 0.5), height: 1.4 }
  assert.strictEqual(r.engine.danger(), null, 'a cow is no danger')
  r.bot.health = 7
  assert.match(r.engine.danger(), /health is 7/)
  r.bot.health = 8; assert.strictEqual(r.engine.danger(), null)
})

test('no line of sight, no placement: a pillar block, a wall block, a foreign block in the way', async () => {
  // nothing can be seen: the pillar does not even start, nothing is placed, no digs
  const blind = rig()
  const blindEngine = require('../brain/build/engine')({ bot: blind.bot, say: () => {}, goals: blind.bot.goals, tryGoto: blind.bot.tryGoto, safehand: blind.sh, config: blind.cfg, state: blind.state, save: blind.save, canSee: () => false, log: () => {} })
  const r0 = await blindEngine.run(fakeCtx())
  assert.strictEqual(r0.status, 'park'); assert.match(r0.reason, /could not place the block under my feet/)
  assert.strictEqual(blind.bot.placements.length, 0, 'not one block without a clear view'); assert.strictEqual(blind.bot.digLog.length, 0)
  // one reference block cannot be seen: its piece is skipped (never placed), everything else is built, the bot is down and the job parks
  const r = rig()
  const o = r.origin
  const hidden = `${o.ox + 4},${o.oy + 3},${o.oz + 2}`
  const engine = require('../brain/build/engine')({ bot: r.bot, say: (t) => r.said.push(t), goals: r.bot.goals, tryGoto: r.bot.tryGoto, safehand: r.sh, config: r.cfg, state: r.state, save: r.save,
    canSee: (t) => (t.position && `${t.position.x},${t.position.y},${t.position.z}` === hidden ? false : r.canSee(t)), log: () => {} })
  const res = await engine.run(fakeCtx())
  assert.strictEqual(res.status, 'park'); assert.match(res.reason, /1 block\(s\) are not placed yet \(\d+ no-view\)|not placed yet/)
  assert.strictEqual(nameAt(r, o.ox + 4, o.oy + 4, o.oz + 2), 'air', 'the piece on the hidden reference block was not placed')
  assert.strictEqual(r.state.pillar, null); assert.strictEqual(r.bot.entity.position.y <= o.oy + 1, true)
  assert.ok(r.bot.losViolations.length === 0)
})

test("somebody else's block in a ring cell is never touched", async () => {
  const r = rig()
  const o = r.origin
  r.bot.setBlock(o.ox + 3, o.oy + 2, o.oz, 'dirt')
  const res = await r.engine.run(fakeCtx())
  assert.strictEqual(res.status, 'park'); assert.match(res.reason, /not placed yet \(1 blocked\)/)
  assert.strictEqual(nameAt(r, o.ox + 3, o.oy + 2, o.oz), 'dirt')
  assert.strictEqual(r.state.pillar, null)
  assertClean(r)
})

test('a lava bucket in the hand is stowed before any walk and never used for placing', async () => {
  const r = rig()
  r.bot.give('lava_bucket', 1)
  await r.bot.equip('lava_bucket')
  const res = await r.engine.run(fakeCtx())
  assert.deepStrictEqual(res, { status: 'done' })
  assert.deepStrictEqual(r.bot.lavaHeldWhileMoving, [])
  assert.ok(r.bot.placements.every(p => p.name !== 'lava_bucket'))
  assertClean(r); assertBuilt(r)
})

// ---------------------------------------------------------------- scheduler behaviour

test('scheduler: Walter stops it up on the pillar -> down first, parked; resume finishes without redoing anything', async () => {
  const r = rig()
  r.bot.onPlace = (n, rec) => { if (rec.name === 'stone_bricks' && rec.y === r.origin.oy + 5 && !r.stopped) { r.stopped = true; r.scheduler.userStop() } }
  r.submit()
  await waitFor(() => r.scheduler.status().parked.length === 1)
  assert.strictEqual(r.bot.entity.position.y, r.origin.oy, 'down from the pillar'); assert.strictEqual(r.state.pillar, null)
  assert.strictEqual(r.state.active, false); assert.strictEqual(r.state.pauseReason, 'stopped by Walter.')
  const n = r.bot.placements.length
  await wait(40); assert.strictEqual(r.bot.placements.length, n, 'parked means parked')
  assert.ok(r.bot.digLog.length >= 5)
  r.scheduler.resumeParked('build')
  await waitFor(() => r.state.finished)
  assertClean(r); assertBuilt(r)
})

test('scheduler: a higher priority task preempts it mid-pillar; the pillar is down before the other task runs, the build resumes after', async () => {
  const r = rig()
  const seen = {}
  r.bot.onPlace = (n, rec) => {
    if (!seen.sent && rec.name === 'stone_bricks' && rec.y === r.origin.oy + 4) {
      seen.sent = true
      r.scheduler.submit({ name: 'safety', priority: PRIORITY.SAFETY, async run(ctx) { seen.y = r.bot.entity.position.y; seen.pillar = r.state.pillar; await ctx.sleep(20) } })
    }
  }
  r.submit()
  await waitFor(() => r.state.finished)
  assert.strictEqual(seen.y, r.origin.oy); assert.strictEqual(seen.pillar, null)
  assertClean(r); assertBuilt(r)
})

test('scheduler: priority is OUTING (45), stop parks it, the task is the singleton "build"', async () => {
  const r = rig()
  const t = r.submit(); const again = r.submit()
  assert.strictEqual(t, again); assert.strictEqual(t.priority, 45); assert.strictEqual(t.onUserStop, 'park')
  await waitFor(() => r.state.finished)
})
