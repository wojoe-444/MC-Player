// brain/leftovers (Walter 2026-11-11, screenshot at -6007,72,-2361): scaffolding pillars that were never taken down and trees cut part way up must be found by the
// loop itself, and the bot must be able to finish both. Pure detector (lib.js), the observer module on a fake bot with the real ledger, the telemetry flags, the journal
// rollup, the dream's work orders, and the treefarm engine finishing a half-felled tree on the mock bench.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leftovers-'))
process.env.BOT_LEDGER_DIR = path.join(DIR, 'ledger')
process.env.BOT_REGISTRY = path.join(DIR, 'registry.json')
const L = require('../brain/leftovers/lib')
const D = require('../brain/telemetry/detectors')
const { rollup } = require('../brain/journal/rollup')
const orders = require('../reviewer/lib/orders')
const leftovers = require('../brain/leftovers')
const ledger = require('../brain/ledger')
const telemetry = require('../brain/telemetry')
const { mockBot } = require('./mock-bot')

const T0 = 1_700_000_000_000, MIN = 60000

// a tiny world as a Map; unknown cells are air up to y 70 and null (unloaded) above
function world(blocks = {}) {
  const w = new Map(Object.entries(blocks))
  const read = (x, y, z) => { const k = `${x},${y},${z}`; if (w.has(k)) return w.get(k); return y > 90 ? null : y < 64 ? 'dirt' : 'air' }
  return { w, read, set: (x, y, z, n) => w.set(`${x},${y},${z}`, n) }
}
const placed = (x, y, z, block = 'cobblestone', o = {}) => ({ x, y, z, op: 'p', block, by: 'OzoGo444', t: T0 - 30 * MIN, space: null, via: 'pillar', ...o })
const ours = (n) => /^(OzoGo444|Smeo444)$/.test(n)

test('scaffold: a column of placed cobble is a pillar; a wide one a tower; singles are strays; plugs, covered, young and named cells are not reported', () => {
  const wd = world()
  const cells = []
  for (let y = 64; y <= 68; y++) { cells.push(placed(10, y, 10)); wd.set(10, y, 10, 'cobblestone') }                   // 5-high pillar
  for (let y = 64; y <= 66; y++) for (const x of [20, 21, 22]) { cells.push(placed(x, y, 20, 'dirt')); wd.set(x, y, 20, 'dirt') }   // 3x3 wall: a tower
  cells.push(placed(30, 64, 30)); wd.set(30, 64, 30, 'cobblestone')                                                 // a stray
  cells.push(placed(40, 64, 40, 'cobblestone', { t: T0 - 2 * MIN })); wd.set(40, 64, 40, 'cobblestone')            // two minutes old: a climb in progress
  cells.push(placed(50, 64, 50, 'cobblestone', { space: 'crops' })); wd.set(50, 64, 50, 'cobblestone')             // inside a named space
  cells.push(placed(60, 64, 60)); wd.set(60, 64, 60, 'cobblestone'); wd.set(60, 66, 60, 'stone')                    // rock two above: under ground
  cells.push(placed(70, 64, 70)); wd.set(70, 64, 70, 'cobblestone'); wd.set(71, 64, 70, 'oak_planks')              // touches the house
  cells.push(placed(80, 64, 80)); wd.set(80, 64, 80, 'dirt')                                                        // someone swapped it: not what we placed
  cells.push({ ...placed(90, 64, 90), by: 'Walter' }); wd.set(90, 64, 90, 'cobblestone')                           // not ours
  const r = L.scaffold({ cells, read: wd.read, isOurs: ours, now: T0 })
  const by = Object.fromEntries(r.clusters.map(c => [c.pos.join(','), c]))
  assert.deepStrictEqual(Object.keys(by).sort(), ['10,64,10', '20,64,20', '30,64,30'])
  assert.strictEqual(by['10,64,10'].kind, 'pillar'); assert.strictEqual(by['10,64,10'].h, 5); assert.strictEqual(by['10,64,10'].n, 5)
  assert.strictEqual(by['20,64,20'].kind, 'tower'); assert.strictEqual(by['20,64,20'].n, 9)
  assert.strictEqual(by['30,64,30'].kind, 'stray')
  assert.strictEqual(r.clusters[0].id, 'scaffold@10,64,10', 'tallest first')
  assert.deepStrictEqual(by['10,64,10'].top, [10, 68, 10])
})

test('scaffold: our own stacked blocks are not cover (a pillar under a pillar is still open to the sky), but natural rock above is', () => {
  const wd = world(), cells = []
  for (let y = 64; y <= 67; y++) { cells.push(placed(5, y, 5)); wd.set(5, y, 5, 'cobblestone') }
  for (let y = 64; y <= 66; y++) { cells.push(placed(8, y, 5)); wd.set(8, y, 5, 'cobblestone') }
  wd.set(8, 72, 5, 'stone')                                                                                         // 6 above the second pillar's top: inside coverMax 8
  const r = L.scaffold({ cells, read: wd.read, isOurs: ours, now: T0 })
  assert.deepStrictEqual(r.clusters.map(c => c.pos.join(',')), ['5,64,5'])
})

test('trees: logs standing on nothing are a half-felled tree, with the leaves they hold; a tree with its trunk on soil and a cabin are not', () => {
  const wd = world()
  // half-felled oak at 10,10: ground y63, logs only from y68 to 72, a limb to the side, leaves around
  for (let y = 68; y <= 72; y++) wd.set(10, y, 10, 'oak_log')
  wd.set(11, 71, 10, 'oak_log'); wd.set(12, 72, 10, 'oak_log')
  for (let x = 8; x <= 13; x++) for (let y = 69; y <= 74; y++) for (let z = 8; z <= 12; z++) if (!wd.w.has(`${x},${y},${z}`)) wd.set(x, y, z, 'oak_leaves')
  // a living tree at 30,30
  for (let y = 64; y <= 69; y++) wd.set(30, y, 30, 'birch_log')
  for (let x = 28; x <= 32; x++) for (let z = 28; z <= 32; z++) wd.set(x, 70, z, 'birch_leaves')
  const cut = { x: 10, y: 66, z: 10, op: 'd', block: 'oak_log', by: 'Smeo444', t: T0 - 20 * MIN, space: null, via: 'autopilot' }
  const get = (x, y, z) => (x === 10 && y === 66 && z === 10 ? cut : null)
  const seeds = [...wd.w].filter(([, n]) => /_log$/.test(n)).map(([k]) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z } })
  const r = L.trees({ seeds, read: wd.read, get, isOurs: ours, now: T0 })
  assert.strictEqual(r.clusters.length, 1)
  const c = r.clusters[0]
  assert.strictEqual(c.what, 'tree'); assert.strictEqual(c.species, 'oak'); assert.strictEqual(c.n, 7); assert.ok(c.leaves >= 30, 'leaves ' + c.leaves)
  assert.deepStrictEqual(c.pos, [10, 68, 10]); assert.strictEqual(c.by, 'Smeo444'); assert.strictEqual(c.cutAgeMin, 20)
  // a log a bot placed itself is a build, not a tree; a tree running into unloaded ground is not guessed at
  const wd2 = world(); wd2.set(5, 70, 5, 'oak_log'); wd2.set(5, 71, 5, 'oak_log')
  const mine = (x, y, z) => ({ op: 'p', by: 'OzoGo444' })
  assert.strictEqual(L.trees({ seeds: [{ x: 5, y: 70, z: 5 }], read: wd2.read, get: mine, isOurs: ours, now: T0 }).clusters.length, 0)
  const wd3 = world(); wd3.set(5, 89, 5, 'oak_log'); wd3.set(5, 90, 5, 'oak_log')
  assert.strictEqual(L.trees({ seeds: [{ x: 5, y: 89, z: 5 }], read: wd3.read, now: T0 }).clusters.length, 0, 'the log above is in an unloaded chunk')
})

// ---- the module, the telemetry flag, the journal, the orders ----
let n = 0
function rig() {
  const bot = mockBot({ pos: [10.5, 64, 10.5] })
  bot.spawnPoint = { x: 0, z: 0 }; bot._client = { write() {} }
  const wd = world()
  bot.blockAt = (p) => { const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z); const nm = wd.read(x, y, z); return nm == null ? null : { name: nm, position: new Vec3(x, y, z), boundingBox: nm === 'air' ? 'empty' : 'block' } }
  bot.findBlocks = ({ matching }) => { const out = []; for (const [k, nm] of wd.w) { const b = bot.registry.blocksByName[nm]; if (b && matching.includes(b.id)) { const [x, y, z] = k.split(',').map(Number); out.push(new Vec3(x, y, z)) } } return out }
  const dir = path.join(DIR, 'bot' + (n++)); fs.mkdirSync(dir, { recursive: true })
  let clock = T0
  const journal = []
  bot._journal = { v: 1, add: (k, f, o) => journal.push({ k, ...f, sal: !!(o && o.sal) }) }
  const api = { bot, events: new EventEmitter(), now: () => clock, log() {}, dir, statePath: (f) => path.join(dir, f), scheduler: { running: { name: 'autopilot' } } }
  const led = ledger(api); led.start()
  const tel = telemetry(api); tel.start()
  const mod = leftovers(api); mod.start()
  const place = (x, y, z, name, by = 'OzoGo444') => { wd.set(x, y, z, name); bot._ledger._store.apply({ t: clock, op: 'p', x, y, z, block: name, by, space: null, via: 'pillar' }) }
  return { bot, wd, tel, mod, journal, place, dir, adv: (ms) => { clock += ms }, now: () => clock, stop: () => { mod.stop(); tel.stop(); led.stop() } }
}

test('module: a pillar is reported only after it has stood a while, once to the journal (salient), every scan to telemetry, and the flag goes high for a tall one', () => {
  const r = rig()
  for (let y = 64; y <= 68; y++) r.place(10, y, 13, 'cobblestone')
  r.bot._ledger._store.bots.add('OzoGo444')
  r.adv(11 * MIN)
  const first = r.mod._tick.scan()
  assert.strictEqual(first.scaffold.length, 0, 'seen for the first time: not yet standing 5 minutes')
  r.adv(6 * MIN)
  const s2 = r.mod._tick.scan()
  assert.strictEqual(s2.scaffold.length, 1); assert.strictEqual(s2.scaffold[0].kind, 'pillar'); assert.strictEqual(s2.scaffold[0].h, 5)
  const j = r.journal.filter(e => e.k === 'leftover')
  assert.strictEqual(j.length, 1); assert.strictEqual(j[0].sal, true); assert.strictEqual(j[0].what, 'scaffold'); assert.deepStrictEqual(j[0].pos, [10, 64, 13]); assert.strictEqual(j[0].by, 'OzoGo444')
  r.adv(2 * MIN); r.mod._tick.scan()
  assert.strictEqual(r.journal.filter(e => e.k === 'leftover').length, 1, 'not repeated every scan')
  assert.ok(r.tel._tick.events().filter(e => e.k === 'leftover').length >= 2, 'telemetry hears it every scan')
  r.tel._tick.analyze()
  const f = JSON.parse(fs.readFileSync(path.join(r.dir, 'telemetry/summary.json'), 'utf8')).flags.find(x => x.kind === 'leftover_scaffold')
  assert.ok(f && f.sev === 'high', JSON.stringify(f)); assert.match(f.msg, /1 scaffolding leftover\(s\) \(5 blocks\)/); assert.match(f.msg, /tallest 5 high at 10,64,13/)
  const st = JSON.parse(fs.readFileSync(path.join(r.dir, 'leftovers.json'), 'utf8'))
  assert.strictEqual(st.scaffold.length, 1); assert.strictEqual(st.scaffold[0].cells.length, 5)
  // when it is taken down the cluster is forgotten and nothing is flagged any more
  for (let y = 64; y <= 68; y++) r.wd.set(10, y, 13, 'air')
  r.adv(2 * MIN); assert.strictEqual(r.mod._tick.scan().scaffold.length, 0)
  assert.strictEqual(r.mod._tick.firstSeen().size, 0)
  r.stop()
})

test('module: a half-felled tree is flagged (med for one, high past 40 leaves) and a bot-felled tree needs no ledger to be found', () => {
  const r = rig()
  for (let y = 69; y <= 73; y++) r.wd.set(10, y, 16, 'oak_log')
  for (let x = 8; x <= 12; x++) for (let y = 70; y <= 75; y++) for (let z = 14; z <= 18; z++) if (!r.wd.w.has(`${x},${y},${z}`)) r.wd.set(x, y, z, 'oak_leaves')
  r.mod._tick.scan(); r.adv(6 * MIN)
  const s = r.mod._tick.scan()
  assert.strictEqual(s.trees.length, 1); assert.strictEqual(s.trees[0].n, 5); assert.ok(s.trees[0].leaves >= 40)
  const j = r.journal.find(e => e.k === 'leftover' && e.what === 'tree'); assert.ok(j && j.sal && j.leaves >= 40 && j.species === 'oak')
  r.tel._tick.analyze()
  const f = JSON.parse(fs.readFileSync(path.join(r.dir, 'telemetry/summary.json'), 'utf8')).flags.find(x => x.kind === 'leftover_trees')
  assert.ok(f && f.sev === 'high', JSON.stringify(f)); assert.match(f.msg, /1 half-felled tree\(s\): 5 log\(s\)/)
  r.stop()
})

test('detector: one stray-free tree remnant is med; nothing standing means no flag; old events fall out of the window', () => {
  const ev = (o) => ({ k: 'leftover', t: T0, what: 'tree', id: 'tree@1,2,3', kind: 'ungrounded', n: 3, h: 3, leaves: 10, x: 1, y: 2, z: 3, standingMin: 6, ...o })
  const fl = D.analyze([], [ev({})], T0 + 1000, undefined, { worn: [], carried: [] })
  const f = fl.find(x => x.kind === 'leftover_trees'); assert.ok(f && f.sev === 'med')
  assert.ok(!D.analyze([], [ev({})], T0 + 10 * MIN, undefined, { worn: [], carried: [] }).some(x => x.kind === 'leftover_trees'))
  const sc = D.analyze([], [ev({ what: 'scaffold', id: 'scaffold@1,2,3', kind: 'stray', h: 1, n: 1 })], T0 + 1000, undefined, { worn: [], carried: [] }).find(x => x.kind === 'leftover_scaffold')
  assert.ok(sc && sc.sev === 'med')
})

test('journal rollup counts each cluster once (the latest report wins) and the dream opens one work order per kind without asking a model', () => {
  const at = (m) => new Date(T0 + m * MIN).toISOString()
  const evs = [
    { at: at(0), k: 'leftover', what: 'scaffold', id: 'scaffold@10,64,13', kind: 'pillar', pos: [10, 64, 13], n: 4, h: 4, block: 'cobblestone', by: 'OzoGo444', via: 'pillar', standingMin: 6 },
    { at: at(190), k: 'leftover', what: 'scaffold', id: 'scaffold@10,64,13', kind: 'pillar', pos: [10, 64, 13], n: 5, h: 5, block: 'cobblestone', by: 'OzoGo444', via: 'pillar', standingMin: 200, again: true },
    { at: at(5), k: 'leftover', sal: 1, what: 'tree', id: 'tree@3,68,3', kind: 'ungrounded', pos: [3, 68, 3], n: 6, h: 6, leaves: 55, species: 'oak', by: 'Smeo444', standingMin: 8 },
  ]
  const ro = rollup(evs, { date: '2026-11-11' })
  assert.strictEqual(Object.keys(ro.leftovers.scaffold.ids).length, 1); assert.strictEqual(ro.leftovers.scaffold.ids['scaffold@10,64,13'].n, 5)
  assert.strictEqual(Object.keys(ro.leftovers.trees.ids).length, 1)
  assert.ok(ro.salient.some(s => /half-felled oak tree at 3,68,3: 6 log\(s\) stand on nothing, 55 leaves/.test(s.what || s)), JSON.stringify(ro.salient))
  const cands = orders.candidates({ rollup: ro, events: evs })
  const sc = cands.find(c => c.key === 'leftover-scaffold'), tr = cands.find(c => c.key === 'leftover-trees')
  assert.ok(sc && sc.auto && sc.auto.isBug, 'scaffold order'); assert.ok(tr && tr.auto && tr.auto.isBug, 'tree order')
  assert.strictEqual(sc.costMin, 7.5); assert.strictEqual(tr.costMin, 10)
  assert.match(sc.line, /1 scaffolding leftover\(s\), 5 blocks, tallest 5 high/); assert.match(tr.line, /1 half-felled tree\(s\): 6 log\(s\).*about 55 leaves/)
  assert.match(sc.auto.suggestion, /tidy step/); assert.match(tr.auto.suggestion, /finishRemnant/)
  // one loose block is not an order, a pillar is
  const one = rollup([{ at: at(0), k: 'leftover', what: 'scaffold', id: 's@1', kind: 'stray', pos: [1, 64, 1], n: 1, h: 1, block: 'dirt', by: 'OzoGo444', standingMin: 12 }], { date: '2026-11-11' })
  assert.ok(!orders.candidates({ rollup: one, events: [] }).some(c => c.key === 'leftover-scaffold'))
})

test('tidy: a column comes down top first in one visit (the old rule took one block per pass); a column taller than an arm reaches keeps its top and is reported stuck', async () => {
  const wd = world(), cells = []
  const col = (x, z, h) => { for (let y = 64; y < 64 + h; y++) { cells.push(placed(x, y, z)); wd.set(x, y, z, 'cobblestone') } }
  col(10, 10, 5); col(14, 10, 9)
  wd.set(10, 69, 10, 'torch')                                                       // a torch on top of the pillar does not keep it up
  const REACH_TOP = 64 + 5                                                          // the highest cell an arm reaches from the ground beside a column
  const eligible = () => L.scaffold({ cells, read: wd.read, isOurs: ours, now: T0 }).clusters.flatMap(c => c.cells.map(([x, y, z]) => ({ x, y, z })))
  const passable = (x, y, z) => { const n = wd.read(x, y, z); return !n || n === 'air' || n === 'torch' }
  const list0 = L.topFirst(eligible(), passable)
  assert.deepStrictEqual(list0.map(p => `${p.x},${p.y}`).filter(s => s.startsWith('10,')), ['10,68', '10,67', '10,66', '10,65', '10,64'], 'the whole column is on the list, top first (the old rule listed only blocks with nothing on top)')
  assert.ok(!L.topFirst([{ x: 1, y: 64, z: 1 }, { x: 1, y: 66, z: 1 }], () => false).some(p => p.y === 64), 'a block with a block on it that is not listed stays')
  // the visit: rounds, recomputing between them, as the tidy step does
  const tried = new Set(), stuck = []
  let removed = 0
  for (let round = 0; round < 4; round++) {
    const list = L.topFirst(eligible(), passable).filter(p => !tried.has(`${p.x},${p.y},${p.z}`))
    if (!list.length) break
    let did = 0
    const stuckSet = new Set()
    for (const p of list.slice(0, 24)) {
      const k = `${p.x},${p.y},${p.z}`; tried.add(k)
      if (stuckSet.has(`${p.x},${p.y + 1},${p.z}`)) { stuckSet.add(k); continue }          // never take the lower blocks out from under a top that cannot be reached
      if (p.y <= REACH_TOP) { wd.set(p.x, p.y, p.z, 'air'); removed++; did++ } else { stuck.push(k); stuckSet.add(k) }
    }
    if (!did) break
  }
  assert.strictEqual([...wd.w].filter(([k, n]) => k.startsWith('10,') && n === 'cobblestone').length, 0, 'the 5 high pillar is gone in one visit')
  assert.deepStrictEqual(stuck, ['14,72,10'], 'the top of the 9 high column is out of reach and is said so')
  assert.strictEqual([...wd.w].filter(([k, n]) => k.startsWith('14,') && n === 'cobblestone').length, 9, 'and the column stays whole (nothing is taken out from under it)')
  assert.ok(removed === 5)
})
