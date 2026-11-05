// brain/nav: long-distance routes over the Xaero map (planRoute / travel) and dimension planning (planTravel).
const test = require('node:test')
const assert = require('node:assert')
const { rig, goals } = require('./nav.helpers')
const route = require('../brain/nav/route')

// ---- a synthetic Xaero-like map: at(x, z) -> { explored, height, rgb, biome } ----
const LAND = [75, 110, 70], WATER = [60, 90, 145], LAVA = [222, 100, 20], SNOW = [250, 250, 255]
function mapOf(fn, { explored = () => true } = {}) {
  return { at: (x, z) => { if (!explored(x, z)) return { explored: false }; const c = fn(Math.floor(x), Math.floor(z)); return { explored: true, height: c.h ?? 64, rgb: c.rgb || LAND, biome: c.biome || 'minecraft:plains' } } }
}
const inRect = (x, z, x0, z0, x1, z1) => x >= x0 && x <= x1 && z >= z0 && z <= z1
const straightness = (pts) => { let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); return len / Math.hypot(pts.at(-1).x - pts[0].x, pts.at(-1).z - pts[0].z) }

test('classify(): lava, water, ice, land, unknown from Xaero colours', () => {
  const c = route.classify
  assert.strictEqual(c({ explored: false }), 'unknown')
  assert.strictEqual(c({ explored: true, rgb: [63, 91, 145] }), 'water')
  assert.strictEqual(c({ explored: true, rgb: [46, 66, 120] }), 'water')
  assert.strictEqual(c({ explored: true, rgb: [222, 100, 20] }), 'lava')
  assert.strictEqual(c({ explored: true, rgb: [81, 119, 73] }), 'land')
  assert.strictEqual(c({ explored: true, rgb: [67, 70, 78] }), 'land')
  assert.strictEqual(c({ explored: true, rgb: [255, 255, 255] }), 'land', 'snow is walkable')
  assert.strictEqual(c({ explored: true, rgb: [117, 145, 214], biome: 'minecraft:frozen_ocean' }), 'ice', 'frozen ocean is walkable ice')
})

test('planRoute: straight line over plain land, and short hops need no planning', () => {
  const m = mapOf(() => ({}))
  const r = route.planRoute({ map: m, from: { x: 0, z: 0 }, to: { x: 800, z: 100 } })
  assert.ok(r.ok)
  assert.ok(straightness(r.points) < 1.02)
  assert.deepStrictEqual(route.planRoute({ map: m, from: { x: 0, z: 0 }, to: { x: 10, z: 10 } }).points.length, 2)
})

test('planRoute: goes around a lake and a lava field, not through them', () => {
  const m = mapOf((x, z) => inRect(x, z, 200, -150, 260, 150) ? { rgb: WATER } : inRect(x, z, 400, -60, 470, 400) ? { rgb: LAVA } : {})
  const r = route.planRoute({ map: m, from: { x: 0, z: 0 }, to: { x: 700, z: 0 } })
  assert.ok(r.ok)
  for (const p of r.points) {
    assert.ok(!inRect(p.x, p.z, 200, -150, 260, 150), `waypoint ${p.x},${p.z} is in the lake`)
    assert.ok(!inRect(p.x, p.z, 400, -60, 470, 400), `waypoint ${p.x},${p.z} is in the lava`)
  }
  // segments between the waypoints must not cut the lake/lava either
  for (let i = 1; i < r.points.length; i++) {
    const a = r.points[i - 1], b = r.points[i]
    for (let t = 0; t <= 1; t += 0.02) { const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t; assert.ok(!inRect(x, z, 205, -145, 255, 145) && !inRect(x, z, 405, -55, 465, 395), `segment passes ${x | 0},${z | 0}`) }
  }
})

test('planRoute: a U shaped trap is walked around from the open side', () => {
  const m = mapOf((x, z) => (inRect(x, z, 300, -100, 330, 100) || inRect(x, z, 200, -100, 330, -80) || inRect(x, z, 200, 80, 330, 100)) ? { rgb: LAVA } : {})
  const r = route.planRoute({ map: m, from: { x: 250, z: 0 }, to: { x: 450, z: 0 } })
  assert.ok(r.ok)
  assert.ok(r.points.some(p => p.x < 200 || p.z < -100 || p.z > 100), 'leaves the U first')
})

test('planRoute: prefers explored ground over unexplored, uses unexplored when it must, reports partial when walled in', () => {
  const explored = (x, z) => z > -50 && z < 50 || x < 100
  const m = mapOf(() => ({}), { explored })
  const r = route.planRoute({ map: m, from: { x: 0, z: 0 }, to: { x: 600, z: 0 } })
  assert.ok(r.ok)
  const dev = Math.max(...r.points.map(p => Math.abs(p.z)))
  assert.ok(dev < 60, 'stays on the explored strip')
  const walled = mapOf((x, z) => inRect(x, z, 300, -2000, 330, 2000) ? { rgb: LAVA } : {})
  const w = route.planRoute({ map: walled, from: { x: 0, z: 0 }, to: { x: 600, z: 0 }, margin: 100, maxExpand: 20000 })
  assert.strictEqual(w.ok, false)
  assert.ok(w.partial && w.points.at(-1).x < 330, 'ends at the closest point instead of inventing a way')
})

test('planRoute: cliffs (steep height changes) cost extra and walls of rock are avoided', () => {
  const m = mapOf((x, z) => inRect(x, z, 200, -300, 230, 100) ? { h: 200 } : { h: 64 })    // a 136-block cliff band, open to the south
  const r = route.planRoute({ map: m, from: { x: 0, z: 0 }, to: { x: 500, z: 0 } })
  assert.ok(r.ok)
  assert.ok(r.points.some(p => p.z > 100), 'goes around the cliff band')
})

test('nextTarget(): walks along the polyline, never beyond its end', () => {
  const pts = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }]
  assert.deepStrictEqual(Math.round(route.nextTarget(pts, { x: 0, z: 0 }, 50).x), 50)
  const around = route.nextTarget(pts, { x: 90, z: 0 }, 50)
  assert.ok(Math.abs(around.x - 100) < 1 && Math.abs(around.z - 40) < 1)
  const end = route.nextTarget(pts, { x: 100, z: 80 }, 500)
  assert.deepStrictEqual([end.x, end.z, end.last], [100, 100, true])
})

// ---- walking it in the simulated world (chunks only exist around the bot) ----
const big = { x0: -40, x1: 420, y0: 0, y1: 120, z0: -120, z1: 120 }
const uTrap = (s) => {
  s.floor(-30, -100, 400, 100, 63, 'grass_block')
  s.fill(150, 63, -40, 160, 63, 40, 'lava'); s.fill(100, 63, -40, 160, 63, -35, 'lava'); s.fill(100, 63, 35, 160, 63, 40, 'lava')
}
async function travelRun(r, target, { map, maxTicks = 8000, opts = {} } = {}) {
  r.bot.pathfinder.thinkTimeout = 300                       // dead ends make the A* search run to its time limit; keep the tests quick
  let res = null
  route.travel({ nav: r.nav, bot: r.bot, goals, map, log: () => {}, isAborted: opts.isAborted }, target, { maxMs: 120000, ...opts }).then(x => { res = x })
  await r.sim.run(() => res, maxTicks)
  return res || { ok: false, err: 'no result' }
}

test('travel with a map: 300 blocks around a lava U-trap with only 64 blocks of "loaded chunks"', async () => {
  const r = await rig({ viewRadius: 64, bounds: big }, uTrap)
  const bad = r.track(() => r.bot.entity.isInLava)
  const res = await travelRun(r, { x: 300, z: 0 }, { map: r.sim.fakeMap() })
  assert.ok(res.ok, JSON.stringify(res))
  assert.ok(Math.hypot(r.sim.at().x - 300, r.sim.at().z) < 8)
  assert.ok(!bad.some(Boolean), 'went into lava')
  assert.ok(res.legs <= 12, `${res.legs} legs`)
  assert.ok(r.sim.maxStep < 0.7, 'no teleport-like step')
  r.close()
})

test('travel without a map: walking into the trap does not kill the bot (it gives up or finds a way, never lava)', async () => {
  const r = await rig({ viewRadius: 64, bounds: big }, uTrap)
  const bad = r.track(() => r.bot.entity.isInLava)
  const res = await travelRun(r, { x: 300, z: 0 }, { map: null, maxTicks: 3000, opts: { maxMs: 20000, maxFailures: 3, maxLegs: 8 } })
  assert.ok(!bad.some(Boolean), 'went into lava')
  assert.ok(typeof res.ok === 'boolean')
  r.close()
})

test('travel without a map across open ground just walks leg by leg', async () => {
  const r = await rig({ viewRadius: 64, bounds: big }, s => s.floor(-30, -100, 400, 100, 63, 'grass_block'))
  const res = await travelRun(r, { x: 260, z: 20 }, { map: null })
  assert.ok(res.ok, JSON.stringify(res))
  assert.ok(Math.hypot(r.sim.at().x - 260, r.sim.at().z - 20) < 8)
  r.close()
})

test('travel: an outdated map (lava the map does not show) is recovered from by re-planning around the trouble', async () => {
  const r = await rig({ viewRadius: 64, bounds: big }, s => { s.floor(-30, -100, 400, 100, 63, 'grass_block'); s.fill(120, 63, -15, 130, 63, 15, 'lava') })
  const stale = mapOf(() => ({}))                                  // the map knows nothing of the lava band
  const bad = r.track(() => r.bot.entity.isInLava)
  const res = await travelRun(r, { x: 300, z: 0 }, { map: stale, maxTicks: 9000 })
  assert.ok(res.ok, JSON.stringify(res))
  assert.ok(!bad.some(Boolean))
  r.close()
})

test('travel: can be aborted between legs', async () => {
  const r = await rig({ viewRadius: 64, bounds: big }, s => s.floor(-30, -100, 400, 100, 63, 'grass_block'))
  let stop = false
  setTimeout(() => {}, 0)
  r.bot.on('physicsTick', () => { if (r.sim.ticks > 150) stop = true })
  const res = await travelRun(r, { x: 350, z: 0 }, { map: null, opts: { isAborted: () => stop } })
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.err, 'aborted')
  assert.ok(r.sim.at().x < 300)
  r.close()
})

test('Nether-like terrain without any map: a winding netherrack corridor with lava beside it, 200+ blocks, loaded chunks only around the bot', async () => {
  const big2 = { x0: -40, x1: 300, y0: 0, y1: 120, z0: -120, z1: 120 }
  const r = await rig({ viewRadius: 48, bounds: big2, pos: [0.5, 64, 0.5] }, s => {
    // a 3-wide corridor: east 90, south 70, east 90, north 70, east 40 ; lava floods everything else at floor level; roof at y=68
    const seg = (x0, z0, x1, z1) => { for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) { s.set(x, 63, z, 'netherrack') } }
    s.fill(-30, 63, -100, 280, 63, 100, 'lava')
    seg(-5, -1, 90, 1); seg(88, -1, 90, 70); seg(88, 68, 180, 70); seg(178, 0, 180, 70); seg(178, -1, 240, 1)
    s.fill(-30, 68, -100, 280, 68, 100, 'netherrack')
    // carve headroom above the corridor
    for (const [x0, z0, x1, z1] of [[-5, -1, 90, 1], [88, -1, 90, 70], [88, 68, 180, 70], [178, 0, 180, 70], [178, -1, 240, 1]]) s.fill(x0, 64, z0, x1, 67, z1, 'air')
  })
  r.bot.entity.position.y = 64
  const bad = r.track(() => r.bot.entity.isInLava)
  const res = await travelRun(r, { x: 238, z: 0 }, { map: null, maxTicks: 14000, opts: { legLen: 40 } })
  assert.ok(!bad.some(Boolean), 'fell in lava')
  assert.ok(res.ok, JSON.stringify(res))
  r.close()
})

test('probeStandable(): never aims into a wall, water or lava', async () => {
  const r = await rig({}, s => { s.floor(-5, -5, 30, 20, 63); s.fill(10, 64, -5, 10, 70, 20, 'stone'); s.fill(14, 63, 0, 16, 63, 3, 'lava') })
  const into = route.probeStandable(r.bot, 10.5, 2.5, 64, 4)
  assert.ok(into && (into.x < 10 || into.x > 11), `got ${JSON.stringify(into)}`)
  const lava = route.probeStandable(r.bot, 15.5, 1.5, 64, 1)
  assert.strictEqual(lava, null, 'nothing standable within 1 block of the lava pool centre')
  r.close()
})

// ---- dimensions ----
const portals = [
  { ow: { name: 'Valley Portal', x: -1042, z: 2281 }, nether: { name: 'Portal', x: -130, z: 284 } },
  { ow: { name: 'Portal A', x: -4369, z: 2291 }, nether: { name: 'Portal N', x: -548, z: 288 } },
  { ow: { name: 'Portal B', x: -147, z: 2663 }, nether: { name: 'Portal M', x: -18, z: 332 } }
]
test('planTravel: same dimension, near: just walk', () => {
  const p = route.planTravel({ from: { x: 0, z: 0, dim: 0 }, to: { x: 300, z: 0, dim: 0 }, portals })
  assert.strictEqual(p.kind, 'walk'); assert.strictEqual(p.steps.length, 1)
})
test('planTravel: a 4000 block overworld trip with portals at both ends goes through the Nether', () => {
  const p = route.planTravel({ from: { x: -1042, z: 2281, dim: 0 }, to: { x: -4369, z: 2291, dim: 0 }, portals })
  assert.strictEqual(p.kind, 'nether-shortcut')
  assert.deepStrictEqual(p.steps.map(s => s.type + ':' + (s.dim ?? s.to)), ['walk:0', 'portal:the_nether', 'walk:-1', 'portal:overworld', 'walk:0'])
  assert.ok(p.estimate < p.direct)
})
test('planTravel: not worth it when the portals are no closer than the destination', () => {
  const p = route.planTravel({ from: { x: 0, z: 0, dim: 0 }, to: { x: 1000, z: 0, dim: 0 }, portals })
  assert.strictEqual(p.kind, 'walk')
})
test('planTravel: to a Nether waypoint and back', () => {
  const to = route.planTravel({ from: { x: -1000, z: 2300, dim: 0 }, to: { x: -84, z: 281, dim: -1 }, portals })
  assert.strictEqual(to.kind, 'to-nether')
  assert.strictEqual(to.steps[0].to.name || to.steps[0].label, to.steps[0].label)
  assert.deepStrictEqual(to.steps.map(s => s.type), ['walk', 'portal', 'walk'])
  assert.strictEqual(to.steps[0].to.x, -1042, 'nearest overworld portal to the Nether destination')
  const back = route.planTravel({ from: { x: -84, z: 281, dim: -1 }, to: { x: -1000, z: 2300, dim: 0 }, portals })
  assert.deepStrictEqual(back.steps.map(s => s.type), ['walk', 'portal', 'walk'])
  assert.strictEqual(back.steps[1].to, 'overworld')
})
test('planTravel: no portals known -> an explicit reason, not a guess', () => {
  const p = route.planTravel({ from: { x: 0, z: 0, dim: 0 }, to: { x: 5, z: 5, dim: -1 }, portals: [] })
  assert.strictEqual(p.steps.length, 0)
  assert.match(p.err, /no known portals/)
})
