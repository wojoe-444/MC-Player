// brain/inspect: the bot looking at what it built. The fixture is the REAL mob farm of 2026-11-10 (blocks read from the LAN world's save), which logged
// zero kills; the synthetic cases build a perfect farm from the design in all four directions and break it one way at a time.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const G = require('../brain/inspect/grid')
const LIGHT = require('../brain/inspect/light')
const M = require('../brain/inspect/mobfarm')
const R = require('../brain/inspect/render')
const MF = require('../brain/mobfarm/geometry')
const fixture = require('./fixtures/mobfarm-live-2026-11-10.json')

const liveL = () => MF.layout({ ox: -6018, oz: -2355, d: [-1, 0], yPlatform: 59 })
const ids = (r) => r.findings.map(f => f.id)
const find = (r, id) => r.findings.find(f => f.id === id)

test('the real farm of 2026-11-10: the inspection finds what a human sees in a second, from the blocks alone', () => {
  const grid = G.fromFixture(fixture), L = liveL()
  const r = M.check(L, grid)
  assert.strictEqual(r.ok, false)
  // 1. a torch inside the spawning room, and what it does: 83% of the pads lit
  const t = find(r, 'stray-light'); assert.ok(t); assert.strictEqual(t.sev, 'fault'); assert.deepStrictEqual(t.cells, ['-6027,59,-2359']); assert.deepStrictEqual(t.fix.kind, 'break')
  const lit = find(r, 'platform-lit'); assert.ok(lit); assert.strictEqual(lit.sev, 'fault')
  assert.ok(r.stats.darkFrac < 0.25, 'dark fraction ' + r.stats.darkFrac); assert.strictEqual(lit.litBy[0].name, 'torch'); assert.deepStrictEqual(lit.litBy[0].at, [-6027, 59, -2359])
  // 2. the slit is two high (rock over it is air), so a landed zombie walks out
  const slit = find(r, 'slit-wide'); assert.ok(slit); assert.deepStrictEqual(slit.cells, ['-6029,39,-2355'])
  // 3. an open cell in the wall beside the kill spot
  assert.deepStrictEqual(find(r, 'killspot-exposed').cells, ['-6027,37,-2356'])
  // 4. the drop column crosses old tunnels
  assert.ok(find(r, 'column-open').count >= 8)
  // 5. two of the three corridor torches never went in
  assert.strictEqual(find(r, 'torch-missing').count, 2)
  // the platform corridor is plugged and then some: a note, not a fault
  assert.strictEqual(find(r, 'corridor-filled').sev, 'note')
  // and what the farm got right is not reported: water settled as designed, hopper faces down into the chest, the bot can see the landing cell
  for (const id of ['water-missing', 'water-still', 'water-levels', 'column-wet', 'piece-missing', 'piece-wrong', 'no-sight', 'platform-leak', 'blocked']) assert.ok(!ids(r).includes(id), id)
  assert.strictEqual(r.stats.sightToLanding, true)
  assert.ok(r.headline.length >= 3 && r.faults >= 4)
})

test('light: one torch lights a 13 block radius through open cells and rock stops it', () => {
  const mk = () => { const g = G.makeGrid(); for (let x = -20; x <= 20; x++) for (let z = -3; z <= 3; z++) for (let y = 0; y <= 3; y++) g.set(x, y, z, (y === 0 || y === 3 || z === -3 || z === 3) ? 'stone' : 'air'); g.set(0, 1, 0, 'torch'); return g }
  let l = LIGHT.blockLight(mk())
  assert.strictEqual(l.get('0,1,0'), 14); assert.strictEqual(l.get('3,1,0'), 11); assert.strictEqual(l.get('13,1,0'), 1); assert.strictEqual(l.get('14,1,0'), undefined)
  assert.strictEqual(l.get('0,0,0'), undefined, 'rock is not lit')
  const g = mk(); for (let z = -2; z <= 2; z++) for (const y of [1, 2]) g.set(5, y, z, 'stone')
  l = LIGHT.blockLight(g)
  assert.strictEqual(l.get('4,1,0'), 10); assert.strictEqual(l.get('6,1,0'), undefined, 'a wall across the aisle stops it')
})

// ---- a perfect farm from the design, in a rock mass, for all four directions
function perfect(d, Yp = 60, ox = 100, oz = -40) {
  const L = MF.layout({ ox, oz, d, yPlatform: Yp })
  const b = L.box, g = G.makeGrid()
  for (let x = b.x0 - 6; x <= b.x1 + 6; x++) for (let z = b.z0 - 6; z <= b.z1 + 6; z++) for (let y = b.y0 - 4; y <= b.y1 + 8; y++) g.set(x, y, z, 'stone')
  for (const c of L.dig) g.set(c[0], c[1], c[2], 'air')
  const lv = MF.waterLevels(L)
  for (const c of L.platform.trench) { const w = lv.get(MF.key(c)); g.set(c[0], c[1], c[2], 'water', { level: String(w === 8 ? 0 : 8 - w) }) }
  g.set(L.chamber.chest[0], L.chamber.chest[1], L.chamber.chest[2], 'chest', { facing: 'north' })
  g.set(L.chamber.hopper[0], L.chamber.hopper[1], L.chamber.hopper[2], 'hopper', { facing: 'down' })
  for (const c of L.chamber.torches) g.set(c[0], c[1], c[2], 'torch')
  for (const c of L.platform.plug) g.set(c[0], c[1], c[2], 'cobblestone')
  for (const c of L.platform.corridor) if (!L.platform.plug.some(p => MF.key(p) === MF.key(c))) g.set(c[0], c[1], c[2], 'air')
  g.set(ox, L.Yp, oz, 'ladder')
  return { L, g }
}
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

test('a farm built exactly to the design passes in all four directions, fully dark', () => {
  for (const d of DIRS) {
    const { L, g } = perfect(d), r = M.check(L, g)
    assert.deepStrictEqual(r.findings.filter(f => f.sev !== 'note').map(f => f.id + ' ' + f.msg), [], 'direction ' + d)
    assert.strictEqual(r.ok, true); assert.strictEqual(r.stats.darkFrac, 1); assert.ok(r.stats.spawnable > 140)
  }
})

test('each way of getting it wrong is caught, in all four directions', () => {
  for (const d of DIRS) {
    const mutate = (fn) => { const { L, g } = perfect(d); fn(L, g); return { L, r: M.check(L, g) } }
    const P = (L) => L.platform
    let x = mutate((L, g) => g.set(...P(L).pads[40].map((v, i) => (i === 1 ? v + 1 : v)), 'torch'))
    assert.ok(ids(x.r).includes('stray-light') && ids(x.r).includes('platform-lit'), 'torch ' + d)
    x = mutate((L, g) => { const c = L.chamber.wallAboveSlit; g.set(c[0], c[1], c[2], 'air') })
    assert.ok(ids(x.r).includes('slit-wide'), 'slit wide ' + d)
    x = mutate((L, g) => { const c = L.chamber.slit; g.set(c[0], c[1], c[2], 'stone') })
    assert.ok(ids(x.r).includes('no-sight') && ids(x.r).includes('blocked'), 'slit closed ' + d)
    x = mutate((L, g) => { const c = P(L).trench[3]; g.set(c[0], c[1], c[2], 'air') })
    assert.ok(ids(x.r).includes('water-missing'), 'dry trench ' + d)
    x = mutate((L, g) => { const c = P(L).trench[5]; g.set(c[0], c[1], c[2], 'water', { level: '0' }) })
    assert.ok(ids(x.r).includes('water-still'), 'source in the middle ' + d)
    x = mutate((L, g) => { const c = L.column[6]; g.set(c[0], c[1], c[2], 'water', { level: '0' }) })
    assert.ok(ids(x.r).includes('column-wet'), 'water in the column ' + d)
    x = mutate((L, g) => { const c = L.chamber.hopper; g.set(c[0], c[1], c[2], 'hopper', { facing: 'north' }) })
    assert.ok(ids(x.r).includes('piece-wrong'), 'hopper facing ' + d)
    x = mutate((L, g) => { const c = L.chamber.hopper; g.set(c[0], c[1], c[2], 'air') })
    assert.ok(ids(x.r).includes('piece-missing'), 'no hopper ' + d)
    x = mutate((L, g) => { const c = P(L).air[100]; g.set(c[0], c[1] + 2, c[2], 'air'); const e = [c[0], c[1] + 2, c[2]]; g.set(e[0], e[1] + 1, e[2], 'air') })
    assert.ok(ids(x.r).includes('platform-leak'), 'hole in the ceiling ' + d)
    x = mutate((L, g) => { const c = L.column[10]; const q = [c[0] + (L.d[1] ? 1 : 0), c[1], c[2] + (L.d[0] ? 1 : 0)]; g.set(q[0], q[1], q[2], 'air') })
    assert.strictEqual(find(x.r, 'column-open').sev, 'warn', 'column crossing a tunnel is a warning ' + d)
    x = mutate((L, g) => { for (const c of P(L).plug) g.set(c[0], c[1], c[2], 'air') })
    assert.ok(ids(x.r).includes('plug-open'), 'plug missing ' + d)
    x = mutate((L, g) => { const c = L.chamber.corridor[Math.floor(L.chamber.corridor.length / 2)]; g.set(c[0], c[1], c[2], 'stone') })
    assert.ok(ids(x.r).includes('blocked'), 'corridor cell filled ' + d)
  }
})

test('an unloaded part of the box is "cannot say", never "air": no false faults from a half-loaded world', () => {
  const { L, g } = perfect([-1, 0])
  const half = G.makeGrid(); for (const [k, c] of g.cells) { if (Number(k.split(',')[0]) > L.at(8, 0, 0)[0]) continue; half.cells.set(k, c) }   // only part of the farm is there
  const r = M.check(L, half)
  assert.ok(r.stats.unknownCells > 0)
  assert.ok(!ids(r).includes('blocked'))
})

test('the registry record is enough to rebuild the design in the right direction', () => {
  for (const d of DIRS) {
    const L = MF.layout({ ox: 100, oz: -40, d, yPlatform: 60 })
    const room = { id: 'mobfarm-x', type: 'mobfarm', box: L.box, platformY: 60 }
    // the shaft's ladder wall is the side the farm does not leave by: the opposite of d0 = -wall
    const shaft = { entry: [100, 70, -40], wall: [-d[0], -d[1]] }
    const got = M.layoutOfRoom(room, shaft); assert.ok(got); assert.deepStrictEqual(got.d, d)
  }
  assert.strictEqual(M.layoutOfRoom({ box: {}, platformY: 60 }, { entry: [0, 0, 0] }), null)
  // the real record of 2026-11-10
  const real = M.layoutOfRoom({ box: { x0: -6039, x1: -6019, y0: 35, y1: 60, z0: -2364, z1: -2346 }, platformY: 59 }, { entry: [-6018, 65, -2355], wall: [0, 1] })
  assert.ok(real); assert.deepStrictEqual(real.d, [-1, 0])
})

test('the picture: a light map of the room and two cutaways, flagged cells marked, and the torch shows as a bright spot in a room that should be dots', () => {
  const grid = G.fromFixture(fixture), L = liveL(), r = M.check(L, grid)
  const pics = R.renderMobFarm(L, grid, LIGHT.blockLight(grid), r)
  assert.match(pics.lightPlan, /^light at y=59/); assert.ok(pics.lightPlan.includes('!'), 'the torch cell is marked')
  assert.ok(/[1-9a-f]/.test(pics.lightPlan.split('\n').slice(1).join('')), 'lit digits show')
  assert.ok(pics.along.split('\n').length >= 28 && pics.across.split('\n').length >= 28)
  assert.ok(pics.along.includes('H') && pics.along.includes('C'), 'hopper and chest in the cutaway')
  const perf = perfect([-1, 0]); const pr = M.check(perf.L, perf.g), pp = R.renderMobFarm(perf.L, perf.g, LIGHT.blockLight(perf.g), pr)
  assert.ok(!/[1-9a-f!]/.test(pp.lightPlan.split('\n').slice(1).join('')), 'a perfect room is all dots and rock')
})

// ---- the observer module, end to end on the real blocks
test('inspect module: reads the registry, takes the blocks from the bot, writes the report, summary and a lesson, and exposes bot._inspect', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insp-')), state = path.join(dir, 'brain', 'state'); fs.mkdirSync(state, { recursive: true })
  const reg = path.join(dir, 'registry.json')
  fs.writeFileSync(reg, JSON.stringify({ worlds: { w: { shafts: [{ id: 's1', entry: [-6018, 65, -2355], wall: [0, 1], bottom: [-6018, -7, -2355] }], rooms: [{ id: 'mobfarm-s1', type: 'mobfarm', shaft: 's1', box: { x0: -6039, x1: -6019, y0: 35, y1: 60, z0: -2364, z1: -2346 }, y: 37, platformY: 59 }] } } }))
  process.env.BOT_REGISTRY = reg
  const grid = G.fromFixture(fixture)
  const bot = { entity: { position: { x: -6018, y: 40, z: -2355 } }, world: { getColumn: () => ({}) }, blockAt: (v) => { const c = grid.get(v.x, v.y, v.z); if (!c) return null; return { name: c.n, getProperties: () => c.p || {} } } }
  const logs = []
  const api = { bot, statePath: (f) => path.join(state, f), log: (...a) => logs.push(a.join(' ')), now: () => Date.parse('2026-11-10T22:40:00Z') }
  delete require.cache[require.resolve('../brain/inspect/index.js')]
  const h = require('../brain/inspect/index.js')(api)
  assert.strictEqual(h.name, 'inspect'); assert.ok(bot._inspect)
  // the fixture's margin is 5 blocks, the module asks for 14: the cells outside the dump are unknown, which must not break anything
  const out = await bot._inspect.run()
  assert.strictEqual(out.length, 1); assert.strictEqual(out[0].ok, false)
  const sum = JSON.parse(fs.readFileSync(path.join(state, 'inspect', 'summary.json'), 'utf8'))
  const row = sum.rooms['mobfarm-s1']; assert.strictEqual(row.ok, false); assert.ok(row.faults >= 4); assert.ok(row.fixes.some(f => f.id === 'stray-light'))
  const md = fs.readFileSync(path.join(state, 'inspect', row.file), 'utf8'); assert.match(md, /stray-light/); assert.match(md, /light at y=59/)
  const lessons = fs.readFileSync(path.join(state, 'lessons.md'), 'utf8'); assert.match(lessons, /\[inspect\] mobfarm-s1: \d fault/)
  await bot._inspect.run(); assert.strictEqual(fs.readFileSync(path.join(state, 'lessons.md'), 'utf8').split('\n').filter(Boolean).length, 1, 'same faults: no second lesson')
  // far away from the farm: nothing to inspect
  bot.entity.position.x = 5000; assert.deepStrictEqual(await bot._inspect.run(), [])
  h.stop(); assert.ok(!bot._inspect); delete process.env.BOT_REGISTRY
})

test('roadmap: a recorded farm that fails its own inspection is not done; no inspection yet keeps the old meaning', () => {
  const { evaluate } = require('../brain/roadmap/predicates')
  const st = (f) => Object.fromEntries(evaluate(f).items.map(i => [i.id, i.status]))['2.8.mobfarm']
  const mobfarm = { killBox: {}, chests: [[1, 2, 3]] }
  assert.strictEqual(st({ mobfarm }), 'done')
  assert.strictEqual(st({ mobfarm, inspect: { rooms: { 'mobfarm-s1': { ok: true } } } }), 'done')
  assert.strictEqual(st({ mobfarm, inspect: { rooms: { 'mobfarm-s1': { ok: false, faults: 4 } } } }), 'open')
  assert.strictEqual(st({ mobfarm, inspect: { rooms: { 'mobfarm-s1': { skipped: 'not loaded' } } } }), 'done')
  assert.strictEqual(st({ inspect: { rooms: { 'mobfarm-s1': { ok: true } } } }), 'open')
})

test('reviewer evidence carries the inspection (the one place the model sees the built world); a stale or passing one sends no pictures', () => {
  const { collectBot } = require('../reviewer/lib/collect')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-')), insp = path.join(dir, 'brain', 'state', 'inspect'); fs.mkdirSync(insp, { recursive: true })
  const at = new Date().toISOString()
  fs.writeFileSync(path.join(insp, 'summary.json'), JSON.stringify({ rooms: { 'mobfarm-s1': { at, ok: false, faults: 4, warns: 2, headline: ['a torch inside the spawning room'], stats: { darkFrac: 0.17 }, file: 'mobfarm-s1.md' }, 'mobfarm-old': { at: '2026-01-01T00:00:00Z', ok: false, faults: 1, warns: 0, headline: [], file: 'mobfarm-old.md' } } }))
  fs.writeFileSync(path.join(insp, 'mobfarm-s1.md'), '# report\nlight at y=59\n...')
  const ev = collectBot({ id: 'ozo', dir })
  assert.strictEqual(ev.buildInspections['mobfarm-s1'].faults, 4); assert.match(ev.buildInspections['mobfarm-s1'].report, /light at y=59/)
  assert.strictEqual(ev.buildInspections['mobfarm-old'].report, undefined)
  const none = collectBot({ id: 'x', dir: fs.mkdtempSync(path.join(os.tmpdir(), 'rev2-')) })
  assert.match(String(none.buildInspections), /no inspection/)
})
