// Walter's furnace stations in the REAL geometry (blocks read from his save, test/fixtures/furnace-station*.json), real pathfinder + physics.
// Regression for: "furnace station 1's input chest at -1043,132,2273 is unreachable: Took to long to decide path to goal!"
//
// Root cause: the chests sit on a wall of a tall hall, 4-5 blocks above the floor. GoalNear(chest, 3) needs a standable cell inside a sphere
// of radius 3 around the chest, and there is none (the floor is 4+ blocks below), so the search can never finish: it exhausts everything
// reachable (the whole base through the ladder shaft) and times out. The chest itself is within arm's reach from the floor.
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { rig, goals, Vec3 } = require('./nav.helpers')
const losLib = require('../brain/los')
const util = require('../brain/util')
const config = require('../brain/furnace-config.json')

const FIX = (n) => path.join(__dirname, 'fixtures', n + '.json')
const S1 = { file: 'furnace-station1', start: [-1047.5, 128, 2280.5], furnaceY: 130 }
const S2 = { file: 'furnace-station2', start: [-1054.5, 151, 2330.5], furnaceY: 153 }
const unitsOf = (st) => config.stations.find(s => s.units.some(u => u.furnace[1] === st.furnaceY)).units

// distance from the eye to the nearest point of the block's cube: what the server's reach rule measures
const reachOf = (bot, pos) => {
  const p = bot.entity.position, ex = p.x, ey = p.y + 1.62, ez = p.z
  const cl = (v, lo) => Math.max(lo, Math.min(lo + 1, v))
  return Math.hypot(ex - cl(ex, pos.x), ey - cl(ey, pos.y), ez - cl(ez, pos.z))
}

test('the fixtures are the real stations: chests, hoppers and the furnace where furnace-config.json says', async () => {
  for (const st of [S1, S2]) {
    const r = await rig({ pos: st.start }, s => s.loadSnapshot(FIX(st.file)))
    for (const u of unitsOf(st)) {
      assert.strictEqual(r.sim.blockName(...u.furnace), 'furnace')
      for (const k of ['fuel', 'input', 'output']) assert.strictEqual(r.sim.blockName(...u[k]), 'chest', `${k} ${u[k]}`)
    }
    r.close()
  }
})

test('root cause 1: nothing standable within 3 blocks of the input chest, so GoalNear(chest, 3) can never be satisfied', async () => {
  const r = await rig({ pos: S1.start }, s => s.loadSnapshot(FIX(S1.file)))
  const g = new goals.GoalNear(-1043, 132, 2273, 3)
  const cells = []
  for (let x = -1047; x <= -1039; x++) for (let y = 126; y <= 136; y++) for (let z = 2269; z <= 2277; z++) {
    const f = r.bot.blockAt(new Vec3(x, y - 1, z)), a = r.bot.blockAt(new Vec3(x, y, z)), b = r.bot.blockAt(new Vec3(x, y + 1, z))
    if (f && a && b && f.boundingBox === 'block' && a.boundingBox === 'empty' && b.boundingBox === 'empty' && g.isEnd(new Vec3(x, y, z))) cells.push([x, y, z])
  }
  assert.deepStrictEqual(cells, [], 'no cell the bot could stand on satisfies the goal')
  // the hall floor is 4+ blocks below the chest
  const floorY = 128
  assert.ok(132 - floorY >= 4)
  r.bot.pathfinder.setGoal(g)
  let status = null
  r.bot.on('path_update', (p) => { status = p.status })
  const res = await r.sim.run(() => r.sim.reached, 300)
  assert.strictEqual(res.ok, false, 'goal is never reached')
  assert.ok(status === 'noPath' || status === 'timeout' || status === 'partial', 'the search ends without success: ' + status)
  r.close()
})

test('root cause 2: when the search gives up, the old "close enough anyway" fallback measured feet to chest centre (4.6) and said "unreachable" although the chest is in reach', async () => {
  const stand = [-1044.5, 128, 2277.5]                                  // the bot is in the hall, on the floor in front of the output chest
  const r = await rig({ pos: stand }, s => s.loadSnapshot(FIX(S1.file)))
  const input = new Vec3(-1043, 132, 2273)
  // what join.js tryGoto() returned live for GoalNear(chest, 3): the search timed out, the bot did not move
  const tryGoto = async () => ({ ok: false, err: 'Took to long to decide path to goal!' })
  const old = await util.gotoNear({ bot: r.bot, goals, tryGoto, pos: input, radius: 3, label: 'input chest', ms: 60000 })
  assert.strictEqual(old, false, 'furnace.js would record "unreachable" for this chest')
  // ...although from exactly where it stands the input chest IS in arm's reach with a clear view
  assert.ok(reachOf(r.bot, input) <= 4.5, `eye-to-chest ${reachOf(r.bot, input)}`)
  assert.ok(losLib.canSee(r.bot, r.bot.blockAt(input)), 'clear line of sight')
  assert.ok(r.bot.entity.position.distanceTo(new Vec3(-1042.5, 132.5, 2273.5)) > 4.6, 'feet-to-centre distance is what failed the old check')
  // and the nav version says yes, after at most a short step along the floor
  let now; r.nav.gotoNear({ pos: input, radius: 3, label: 'input chest' }).then(x => { now = x })
  await r.sim.run(() => now !== undefined, 400)
  assert.strictEqual(now, true)
  assert.ok(r.bot.entity.position.distanceTo(new Vec3(...stand)) < 3, 'only a short step')
  r.close()
})

test('fix: nav.approachBlock() stands on the floor within reach and the chest can be used (every chest of both stations, real geometry)', async () => {
  for (const st of [S1, S2]) {
    const r = await rig({ pos: st.start }, s => s.loadSnapshot(FIX(st.file)))
    r.bot.pathfinder.thinkTimeout = 4000
    for (const u of unitsOf(st)) for (const role of ['output', 'fuel', 'input']) {
      const pos = new Vec3(...u[role])
      let out; r.nav.approachBlock(pos, { label: role + ' chest' }).then(x => { out = x })
      await r.sim.run(() => out, 900)
      assert.ok(out && out.ok, `${st.file} ${role} ${u[role]}: ${JSON.stringify(out)}`)
      assert.ok(reachOf(r.bot, pos) <= 4.5, `${role} ${u[role]} eye ${reachOf(r.bot, pos).toFixed(2)}`)
      assert.ok(losLib.canSee(r.bot, r.bot.blockAt(pos)), `${role} ${u[role]} has a clear view`)
      assert.ok(out.secs < 15, `${out.secs}s`)
      assert.ok(Math.abs(r.sim.at().y - st.start[1]) < 0.6, 'it stood on the hall floor, not somewhere odd')
    }
    assert.strictEqual(r.nav.status().hazards.escapes, 0)
    r.close()
  }
})

test('fix: nav.gotoNear() is a drop-in for util.gotoNear (same arguments, boolean result), including the input chest that failed live', async () => {
  const r = await rig({ pos: S1.start }, s => s.loadSnapshot(FIX(S1.file)))
  const input = new Vec3(-1043, 132, 2273)
  let ok; r.nav.gotoNear({ pos: input, radius: 3, label: 'input chest', ms: 60000 }).then(x => { ok = x })
  await r.sim.run(() => ok !== undefined, 900)
  assert.strictEqual(ok, true)
  assert.ok(reachOf(r.bot, input) <= 4.5)
  r.close()
})

test('a block with nowhere to stand within reach fails at once with a reason (not a 60 s search)', async () => {
  const r = await rig({ pos: S1.start }, s => s.loadSnapshot(FIX(S1.file)))
  const t0 = r.sim.ticks
  let out; r.nav.approachBlock(new Vec3(-1036, 130, 2276), { label: 'buried block' }).then(x => { out = x })
  await r.sim.run(() => out, 200)
  assert.strictEqual(out.ok, false)
  assert.match(out.err, /no spot within reach/)
  assert.ok(r.sim.ticks - t0 < 5)
  r.close()
})

test('the hall is not left in a worse state: doors none, no lava touched while approaching the chests next to the lava corridor', async () => {
  const r = await rig({ pos: S1.start }, s => s.loadSnapshot(FIX(S1.file)))
  const bad = r.track(() => r.bot.entity.isInLava)
  for (const k of ['output', 'fuel', 'input']) {
    let out; r.nav.approachBlock(new Vec3(...unitsOf(S1)[0][k])).then(x => { out = x })
    await r.sim.run(() => out, 900)
    assert.ok(out.ok)
  }
  assert.ok(!bad.some(Boolean))
  r.close()
})
