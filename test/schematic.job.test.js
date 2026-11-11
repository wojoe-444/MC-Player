// Following a schematic in the loop: the gate (when it is appropriate), the job, the verify that reads the world, the room it registers on completion, and what the
// inspection, the outcome check, the journal and the work orders do with the number.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const LP = require('../brain/schematic/loop')
const F = require('../brain/schematic/format')
const S = require('../brain/schematic/store')
const register = require('../brain/schematic')
const E = require('../brain/outcome/expect')
const orders = require('../reviewer/lib/orders')

const dirs = () => S.dirsFor({})

test('gate: everyday jobs never follow a schematic; the mob farm does by default; anything else only when asked for by name and only if big enough', () => {
  for (const k of ['torch', 'chest', 'bridge', 'pillar', 'shaft', 'hut', 'door', 'ladder']) assert.strictEqual(LP.policy({ kind: k, explicit: true }).follow, false, k + ' stays a direct job even when asked')
  assert.strictEqual(LP.policy({ kind: 'mobfarm' }).follow, true)
  assert.strictEqual(LP.policy({ kind: 'house' }).follow, false, 'a house is not decided on its own')
  assert.strictEqual(LP.policy({ kind: 'house', explicit: true }).follow, true)
  const tiny = { id: 'tiny', kind: 'house', palette: [{ role: 'any' }, { role: 'block', block: 'stone' }], counts: { 0: 100, 1: 20 } }
  assert.match(LP.policy({ kind: 'house', explicit: true, schem: tiny }).why, /too small/)
  assert.strictEqual(LP.policy({ kind: '' }).follow, false)
})

test('choose: the mob farm picks the benchmark farm; an unknown kind or a missing id finds nothing; an aesthetic id needs the explicit ask', () => {
  const r = LP.choose({ kind: 'mobfarm', dirs: dirs() })
  assert.ok(r.ok, r.why); assert.strictEqual(r.schematic.id, 'mobfarm-forever2k27')
  assert.strictEqual(LP.choose({ kind: 'castle', dirs: dirs() }).ok, false)
  assert.strictEqual(LP.choose({ kind: 'mobfarm', id: 'nope', dirs: dirs() }).ok, false)
  const hut = LP.choose({ kind: 'house', id: 'starter-base', dirs: dirs() })
  assert.ok(hut.ok, hut.why)                       // naming a schematic by id is the explicit ask
  assert.strictEqual(LP.choose({ kind: 'house', dirs: dirs() }).ok, false, 'a house kind alone is not a reason: not followed by default')
})

// a farm-ish schematic small enough to build in the test: a 5x4x5 hall in rock with a hopper, a chest, a torch and a source, anchors for the kill routine
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-job-'))
  process.env.BOT_SHARED = path.join(dir, 'shared'); fs.mkdirSync(path.join(process.env.BOT_SHARED, 'schematics'), { recursive: true })
  const registryFile = path.join(process.env.BOT_SHARED, 'registry.json')
  fs.writeFileSync(registryFile, JSON.stringify({ worlds: { w: { shafts: [], rooms: [] } } }))
  const m = new Map(), set = (x, y, z, name, props = {}) => m.set(x + ',' + y + ',' + z, { name, props })
  const box = { x0: 100, y0: 10, z0: 100, x1: 110, y1: 20, z1: 110 }
  for (let x = box.x0; x <= box.x1; x++) for (let y = box.y0; y <= box.y1; y++) for (let z = box.z0; z <= box.z1; z++) set(x, y, z, 'stone')
  const design = new Map(m), dset = (x, y, z, name, props = {}) => design.set(x + ',' + y + ',' + z, { name, props })
  for (let x = 103; x <= 107; x++) for (let y = 13; y <= 16; y++) for (let z = 103; z <= 107; z++) dset(x, y, z, 'air')
  dset(105, 12, 105, 'hopper', { facing: 'down' }); dset(105, 11, 105, 'chest', { facing: 'north', type: 'single' }); dset(103, 16, 103, 'torch'); dset(107, 13, 107, 'water', { level: '0' })
  const schem = F.capture((x, y, z) => design.get(x + ',' + y + ',' + z) || null, box, { id: 'hall-test', kind: 'mobfarm', surround: 0 })
  schem.anchors = { killSpot: [105, 13, 106], killBox: { x0: 105, x1: 105, y0: 13, y1: 14, z0: 105, z1: 105 }, chests: [[105, 11, 105]] }
  S.save(path.join(process.env.BOT_SHARED, 'schematics'), schem)
  const journal = [], lessons = path.join(dir, 'state', 'lessons.md')
  const bot = { username: 'OzoGo444', spawnPoint: { x: 0, z: 0 }, entity: { position: { x: 105.5, y: 13, z: 103.5 } }, world: { getColumn: () => ({}) }, _journal: { add: (k, f, o) => journal.push({ k, ...f, sal: o && o.sal }) },
    blockAt: (v) => { const b = m.get(v.x + ',' + v.y + ',' + v.z); return b ? { name: b.name, getProperties: () => b.props } : null } }
  const h = register({ bot, now: () => 1_700_000_000_000, log() {}, statePath: (f) => path.join(dir, 'state', f), registryFile })
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true })
  return { bot, h, m, design, set, schem, dir, registryFile, journal, lessons, stateDir: path.join(dir, 'state') }
}

test('job: the gate refuses an everyday kind; a farm is sited, verified from the world, and completion registers the room, writes the kill routine config and tells the journal', () => {
  const r = rig(), M = r.bot._schematic
  assert.strictEqual(M.startJob({ kind: 'torch', id: 'hall-test' }).ok, false, 'a torch is never a schematic, even with an id')
  const j = M.startJob({ kind: 'mobfarm', id: 'hall-test', at: [100, 10, 100], reason: 'the farm decision' })
  assert.ok(j.ok, j.why); assert.deepStrictEqual(j.job.at, [100, 10, 100])
  assert.strictEqual(M.startJob({ kind: 'mobfarm', id: 'hall-test' }).ok, false, 'one job at a time')
  let v = M.verify(); assert.ok(v.ok); assert.strictEqual(v.state, 'building'); assert.ok(v.pct < 100 && v.pct > 40, 'the rock shell is right already, the hall is not: ' + v.pct)
  assert.ok(v.counts.dig > 0 && v.counts.replace > 0)
  // dig the hall and fit it: the world, not a routine, says it is done
  for (const [k, b] of r.design) r.m.set(k, b)
  v = M.verify(); assert.strictEqual(v.state, 'complete', JSON.stringify(v.counts)); assert.strictEqual(v.pct, 100)
  const reg = JSON.parse(fs.readFileSync(r.registryFile, 'utf8')).worlds.w.rooms
  assert.strictEqual(reg.length, 1); assert.strictEqual(reg[0].viaSchematic, true); assert.strictEqual(reg[0].schematic, 'hall-test'); assert.strictEqual(reg[0].type, 'mobfarm')
  const cfg = JSON.parse(fs.readFileSync(path.join(r.stateDir, 'mobfarm.json'), 'utf8'))
  assert.deepStrictEqual(cfg.killSpot, [105, 13, 106]); assert.deepStrictEqual(cfg.chests, [[105, 11, 105]]); assert.strictEqual(cfg.builder, 'schematic')
  assert.deepStrictEqual(r.journal.map(e => e.k + ':' + (e.ev || '') + ':' + (e.state || '')), ['schematic:start:', 'schematic:state:complete'])
  assert.ok(/\[schematic\] hall-test: complete/.test(fs.readFileSync(r.lessons, 'utf8')))
  // somebody puts a torch in the open hall: it is not complete any more
  r.set(104, 14, 104, 'torch'); v = M.verify(); assert.strictEqual(v.state, 'building'); assert.deepStrictEqual(v.counts, { dig: 1 })
  assert.ok(M.job().lastWrong[0].includes('104,14,104'))
  r.h.stop(); delete process.env.BOT_SHARED
})

test('job: work that changes no cell for long enough is stuck, once, with the first wrong cells; abandoning is on the record', () => {
  const r = rig(), M = r.bot._schematic
  assert.ok(M.startJob({ kind: 'mobfarm', id: 'hall-test', at: [100, 10, 100] }).ok)
  M.verify(); M.noteWork(10 * 60000); assert.strictEqual(M.verify().state, 'building', '10 minutes of work is not stuck yet')
  M.noteWork(20 * 60000); assert.strictEqual(M.verify().state, 'stuck')
  const ev = r.journal.filter(e => e.ev === 'state'); assert.deepStrictEqual(ev.map(e => e.state), ['stuck']); assert.ok(ev[0].wrong.length > 0); assert.strictEqual(ev[0].sal, true)
  // one more cell dug: progress, so it is building again
  r.m.set('103,13,103', { name: 'air', props: {} }); assert.strictEqual(M.verify().state, 'building')
  assert.ok(M.abandon('the rock is full of lava').ok); assert.strictEqual(M.job().state, 'abandoned')
  assert.ok(M.clearJob()); assert.strictEqual(M.job(), null)
  r.h.stop(); delete process.env.BOT_SHARED
})

test('job: sited automatically, the cheapest fitting anchor is chosen; a site full of lava is refused; an unloaded area is refused', () => {
  const r = rig(), M = r.bot._schematic
  const j = M.startJob({ kind: 'mobfarm', id: 'hall-test' }); assert.ok(j.ok, j.why); assert.ok(j.job.siteCost > 0)
  M.abandon('test'); M.clearJob()
  for (const k of [...r.m.keys()]) { const [x, y, z] = k.split(',').map(Number); if ((x + y + z) % 4 === 0) r.m.set(k, { name: 'lava', props: { level: '0' } }) }
  const bad = M.startJob({ kind: 'mobfarm', id: 'hall-test' }); assert.strictEqual(bad.ok, false); assert.match(bad.why, /no fitting place/); assert.match(bad.why, /lava|unloaded/)
  r.bot.world.getColumn = () => null
  assert.match(M.startJob({ kind: 'mobfarm', id: 'hall-test' }).why, /not loaded/)
  r.h.stop(); delete process.env.BOT_SHARED
})

test('outcome: a farm whose schematic is not complete is "building", not overdue, and its grace clock has not started', () => {
  const farm = { id: 'mobfarm-x', kind: 'mobfarm', liveMs: 30 * 3600000, got: 0 }
  const b = E.evaluate({ ...farm, schematic: { state: 'building', pct: 83.4, id: 'hall-test' } }, { difficulty: 'hard' })
  assert.strictEqual(b.state, 'building'); assert.match(b.why[0], /83.4% of hall-test/)
  assert.strictEqual(E.evaluate({ ...farm, schematic: { state: 'stuck', pct: 90, id: 'x' } }, { difficulty: 'hard' }).state, 'building')
  assert.strictEqual(E.evaluate({ ...farm, schematic: { state: 'complete', pct: 100, id: 'x' } }, { difficulty: 'hard' }).state, 'overdue', 'complete and no output: judged as ever')
  assert.strictEqual(E.evaluate({ ...farm }, { difficulty: 'peaceful' }).state, 'blocked')
})

test('work orders: a stuck schematic job becomes an order written in code from the journal event (no model); a farm that is merely building does not', () => {
  const ev = (state) => ({ at: '2026-11-11T05:00:00Z', k: 'schematic', ev: 'state', id: 'mobfarm-forever2k27', kindOf: 'mobfarm', state, pct: 91.2, off: 140, counts: { place: 30, dig: 110 }, wrong: ['156,70,406 place: want cobblestone_slab type=bottom, got air'], foreign: 3 })
  const c = orders.candidates({ rollup: { steps: {}, deaths: [], flags: {} }, events: [ev('stuck')] }).find(x => x.type === 'schematic')
  assert.ok(c); assert.strictEqual(c.key, 'schematic-mobfarm-forever2k27'); assert.ok(c.auto.isBug); assert.match(c.auto.problem, /91.2%/); assert.match(c.auto.problem, /3 of the wrong cells hold blocks no bot of ours made/)
  assert.strictEqual(orders.candidates({ rollup: { steps: {}, deaths: [], flags: {} }, events: [ev('building')] }).filter(x => x.type === 'schematic').length, 0)
  assert.strictEqual(orders.candidates({ rollup: { steps: {}, deaths: [], flags: {} }, events: [ev('stuck'), ev('complete')] }).filter(x => x.type === 'schematic').length, 0, 'the last state wins')
})

test('inspect: a room built by following a schematic is checked cell by cell and reports the percent that is right; a stray torch is a fault', async () => {
  const r = rig(); const M = r.bot._schematic
  assert.ok(M.startJob({ kind: 'mobfarm', id: 'hall-test', at: [100, 10, 100] }).ok)
  for (const [k, b] of r.design) r.m.set(k, b)
  assert.strictEqual(M.verify().state, 'complete')
  process.env.BOT_REGISTRY = r.registryFile
  const inspect = require('../brain/inspect')
  const h = inspect({ bot: r.bot, now: () => 1_700_000_000_000, log() {}, statePath: (f) => path.join(r.stateDir, f), registryFile: r.registryFile })
  let res = await h._run()
  assert.strictEqual(res.length, 1, 'the schematic room is inspected like a mob farm room'); assert.strictEqual(res[0].ok, true); assert.strictEqual(res[0].stats.percentRight, 100)
  r.set(104, 14, 104, 'torch')
  res = await h._run(); assert.strictEqual(res[0].ok, false); assert.strictEqual(res[0].stats.percentRight < 100, true)
  assert.match(res[0].headline.join(' '), /open air but are torch/)
  h.stop && h.stop(); r.h.stop(); delete process.env.BOT_SHARED; delete process.env.BOT_REGISTRY
})
