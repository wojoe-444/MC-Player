// brain/schematic: roles instead of block names, capture, exact diff, the store, the bot module, and the exact check on the real farm of 2026-11-10.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const B = require('../brain/schematic/blocks')
const F = require('../brain/schematic/format')
const S = require('../brain/schematic/store')
const D = require('../brain/schematic/designs')
const MF = require('../brain/mobfarm/geometry')
const G = require('../brain/inspect/grid')
const X = require('../brain/inspect/exact')
const register = require('../brain/schematic')

test('roles: any solid, light-blocking, non-flammable cube is "solid"; wood, glass, glowstone, slabs, sand are not', () => {
  for (const n of ['cobblestone', 'minecraft:stone', 'deepslate', 'cobbled_deepslate', 'stone_bricks', 'white_concrete', 'iron_ore', 'tuff', 'polished_andesite', 'dirt']) assert.strictEqual(B.describe(n).role, 'solid', n)
  for (const n of ['oak_planks', 'birch_log', 'glass', 'glowstone', 'cobblestone_slab', 'cobblestone_stairs', 'sand', 'gravel', 'white_wool', 'ice', 'spawner', 'hay_block', 'slime_block', 'cobblestone_wall']) assert.notStrictEqual(B.describe(n).role, 'solid', n)
  assert.deepStrictEqual(B.describe('hopper', { facing: 'down', enabled: 'true' }), { role: 'block', block: 'hopper', props: { facing: 'down' } }, 'noise properties are dropped')
  assert.deepStrictEqual(B.describe('water', { level: '3' }), { role: 'water', block: 'water', level: '3' })
  assert.deepStrictEqual(B.describe('minecraft:cobblestone'), { role: 'solid', block: 'cobblestone' }, 'a wall cell keeps the specific block it shows')
  assert.deepStrictEqual(B.describeExact('cobblestone'), { role: 'block', block: 'cobblestone' }, 'an aesthetic build wants the block itself')
  assert.ok(B.matches({ role: 'solid' }, 'minecraft:deepslate') && !B.matches({ role: 'solid' }, 'oak_planks') && B.matches({ role: 'air' }, 'cave_air'))
  assert.ok(B.matches({ role: 'water', level: '0' }, 'water', { level: '0' }) && !B.matches({ role: 'water', level: '0' }, 'water', { level: '2' }))
})

// a little world as a Map: a 7x5x7 rock mass with a cavity, a hopper under it, water, a torch and a tree beside it
function world() {
  const m = new Map(), set = (x, y, z, name, props = {}) => m.set(x + ',' + y + ',' + z, { name, props })
  for (let x = 0; x < 9; x++) for (let y = 0; y < 5; y++) for (let z = 0; z < 7; z++) set(x, y, z, 'cobblestone')
  for (let x = 1; x <= 5; x++) for (let y = 1; y <= 3; y++) for (let z = 1; z <= 5; z++) set(x, y, z, 'air')
  set(3, 0, 3, 'hopper', { facing: 'down' }); set(2, 1, 2, 'water', { level: '0' }); set(3, 1, 2, 'water', { level: '1' }); set(5, 3, 5, 'torch')
  for (let y = 1; y <= 4; y++) set(8, y, 3, 'oak_log')                                  // a tree in the box, outside the build
  return m
}
const box = { x0: 0, y0: 0, z0: 0, x1: 8, y1: 4, z1: 6 }
const get = (m) => (x, y, z) => m.get(x + ',' + y + ',' + z) || null

test('capture keeps open space, the shell and the exact pieces; deep rock is "any"; a tree outside the seeds is not the build; runs add up', () => {
  const m = world(), s = F.capture(get(m), box, { id: 't', seeds: [[3, 2, 3]], surround: 0 })
  const roles = s.palette.map(p => p.role + (p.block ? ':' + p.block : ''))
  assert.deepStrictEqual(roles.slice().sort(), ['any', 'air', 'block:hopper', 'block:torch', 'solid:cobblestone', 'water:water', 'water:water'].sort())
  assert.ok(!roles.includes('block:oak_log'), 'the tree is not connected to the cavity')
  const cells = F.cellsOf(s); assert.strictEqual(cells.length, 9 * 5 * 7)
  const legend = F.legend(s); assert.ok(legend.find(l => l.role === 'solid' && l.block === 'cobblestone'), 'the wall is solid and shows cobblestone')
  assert.strictEqual(legend.find(l => l.role === 'any').cells, 9 * 5 * 7 - legend.filter(l => l.role !== 'any').reduce((n, l) => n + l.cells, 0))
  // hopper at (3,0,3): kept as exact; rock in the corner (0,0,0) touches nothing open: any
  assert.strictEqual(s.palette[cells[F.idx(s.size, 0, 0, 0)]].role, 'any')
  assert.deepStrictEqual(s.palette[cells[F.idx(s.size, 3, 0, 3)]], { role: 'block', block: 'hopper', props: { facing: 'down' } })
})
test('diff: any other solid block still matches; wood in a wall, a hole, a wrong water level and a hopper facing sideways do not', () => {
  const m = world(), s = F.capture(get(m), box, { id: 't', seeds: [[3, 2, 3]], surround: 0 })
  assert.ok(F.diff(s, get(m)).ok)
  m.set('0,2,3', { name: 'stone', props: {} }); m.set('1,2,0', { name: 'deepslate', props: {} })         // wall cells swapped for other rock
  assert.ok(F.diff(s, get(m)).ok, 'cobble, stone and deepslate are the same to the build')
  m.set('0,2,2', { name: 'oak_planks', props: {} }); m.set('6,2,3', { name: 'air', props: {} }); m.set('3,1,2', { name: 'water', props: { level: '4' } }); m.set('3,0,3', { name: 'hopper', props: { facing: 'north' } })
  const r = F.diff(s, get(m))
  assert.strictEqual(r.wrong.length, 4); assert.deepStrictEqual(r.wrong.map(w => w.want).sort(), ['hopper facing=down', 'solid', 'solid', 'water level 1'].sort())
  assert.ok(r.wrong.find(w => w.got.startsWith('oak_planks')))
  m.delete('2,2,3'); const u = F.diff(s, get(m)); assert.strictEqual(u.unknown, 1, 'an unloaded cell is unknown, never a mismatch')
  assert.strictEqual(F.diff(s, get(m), [20, 0, 0]).unknown, F.diff(s, get(m)).checked + F.diff(s, get(m)).unknown, 'a schematic moved to where nothing is loaded compares nothing')
})
test('masks: only the boxes named are the build', () => {
  const m = world(), s = F.capture(get(m), box, { id: 't', surround: 0, masks: [{ x0: 0, y0: 0, z0: 0, x1: 4, y1: 4, z1: 6 }] })
  const cells = F.cellsOf(s); assert.strictEqual(s.palette[cells[F.idx(s.size, 6, 2, 3)]].role, 'any'); assert.strictEqual(s.palette[cells[F.idx(s.size, 2, 2, 3)]].role, 'air')
})

test('exact check on the REAL farm of 2026-11-10 against the bots\' design: it finds the torch in the spawning room, the missing corridor torches and the plug', () => {
  const fx = require('./fixtures/mobfarm-live-2026-11-10.json'), grid = G.fromFixture(fx)
  const L = MF.layout({ ox: -6018, oz: -2355, d: [-1, 0], yPlatform: 59 }), s = D.mobfarmDesign(L)
  const r = X.check(s, s.origin, grid, { fault: false })
  assert.ok(r.stats.checked > 1000 && r.stats.wrong > 10 && r.stats.wrong < 40, JSON.stringify(r.stats))
  const all = r.findings.flatMap(f => f.cells)
  assert.ok(all.includes('-6027,59,-2359'), 'the torch inside the spawning room'); assert.ok(all.includes('-6026,37,-2355') && all.includes('-6023,37,-2355'), 'the corridor torches that never went in')
  assert.ok(r.findings.every(f => f.sev === 'note' || f.sev === 'warn' || f.sev === 'fault'))
  assert.ok(X.check(s, s.origin, grid, { fault: true }).findings.some(f => f.sev === 'fault'), 'with an explicit blueprint a wrong cell is a fault')
})

test('the library: the captured working farm loads, its runs add up, and what it needs is generic', () => {
  const lib = S.list([S.LIBRARY]); const f = lib.find(e => e.schematic.id === 'mobfarm-forever2k27'); assert.ok(f, 'mobfarm-forever2k27 is in the library')
  const s = f.schematic; assert.strictEqual(F.cellsOf(s).length, s.size[0] * s.size[1] * s.size[2])
  assert.strictEqual(s.v, 2); assert.ok(!s.sources, 'format 2 has no per-entry source counts')
  const leg = F.legend(s).filter(l => !l.scenery); assert.ok(leg.some(l => l.role === 'solid' && l.block === 'cobblestone') && leg.some(l => l.role === 'solid' && l.block === 'stone'), 'walls are role solid, each cell names its block')
  assert.ok(s.palette.every(e => e.role === 'any' || e.role === 'air' || e.block), 'every cell that is not air or any names a specific block')
  assert.ok(leg.some(l => l.label.startsWith('hopper')) && leg.some(l => l.label.startsWith('water level 0')) && leg.some(l => /trapdoor/.test(l.label)) && leg.some(l => /cobblestone_slab/.test(l.label)))
  assert.ok(!leg.some(l => /leaves|cave_vines|spruce_log/.test(l.label)), 'the trees and vines around it are not part of it')
  assert.ok(F.legend(s).some(l => l.scenery), 'the rock and the torches around it are kept as scenery')
})

test('store: later directories win; ids are safe file names', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-a-')), b = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-b-'))
  const mk = (name) => F.capture(get(world()), box, { id: 'x', name, seeds: [[3, 2, 3]] })
  S.save(a, mk('first')); S.save(b, mk('second'))
  assert.strictEqual(S.load([a, b], 'x').name, 'second'); assert.strictEqual(S.load([b, a], 'x').name, 'first'); assert.strictEqual(S.safeId('../My Farm!'), 'my-farm')
})

test('bot module: capture from the loaded world, save it for both bots, tag the registry room, diff later', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-bot-')), m = world()
  process.env.BOT_SHARED = path.join(dir, 'shared'); fs.mkdirSync(process.env.BOT_SHARED, { recursive: true })
  const registryFile = path.join(process.env.BOT_SHARED, 'registry.json')
  fs.writeFileSync(registryFile, JSON.stringify({ worlds: { w: { rooms: [{ id: 'mobfarm-t', type: 'mobfarm', box: { x0: 1, y0: 1, z0: 1, x1: 5, y1: 3, z1: 5 } }] } } }))
  const added = []
  const bot = { username: 'Smeo444', _journal: { add: (k, f) => added.push([k, f.id]) }, world: { getColumn: () => ({}) },
    blockAt: (v) => { const b = m.get(v.x + ',' + v.y + ',' + v.z); return b ? { name: b.name, getProperties: () => b.props } : null } }
  const h = register({ bot, now: () => 1_700_000_000_000, log() {}, statePath: (f) => path.join(dir, 'state', f), registryFile })
  const r = bot._schematic.capture({ id: 'farm-a', room: 'mobfarm-t' })
  assert.ok(r.ok, r.why); assert.ok(fs.existsSync(path.join(process.env.BOT_SHARED, 'schematics', 'farm-a.json'))); assert.deepStrictEqual(added, [['schematic', 'farm-a']])
  assert.strictEqual(JSON.parse(fs.readFileSync(registryFile, 'utf8')).worlds.w.rooms[0].schematic, 'farm-a', 'the room now names its blueprint')
  assert.ok(bot._schematic.diff('farm-a').ok && bot._schematic.diff('farm-a').wrong.length === 0)
  m.set('0,2,2', { name: 'air', props: {} }); m.set('1,1,1', { name: 'torch', props: {} })
  assert.strictEqual(bot._schematic.diff('farm-a').wrong.length, 2)
  bot.world.getColumn = () => null; assert.match(bot._schematic.capture({ id: 'x', box }).why, /not loaded/)
  assert.ok(bot._schematic.list().some(x => x.id === 'farm-a')); h.stop(); assert.ok(!bot._schematic)
  delete process.env.BOT_SHARED
})

// ---- format 2: a specific block in every cell, roles as the allowed substitutes
test('surroundings are kept as scenery: drawn, never checked', () => {
  const m = world(), s = F.capture(get(m), box, { id: 't', seeds: [[3, 2, 3]], surround: 1 })
  const sc = s.palette.map((e, i) => ({ e, i })).filter(x => x.e.scenery)
  assert.ok(sc.length && sc.some(x => x.e.block === 'oak_log' || x.e.block === 'cobblestone'), JSON.stringify(sc))
  const mm = world(); mm.set('8,2,3', { name: 'air', props: {} })   // the tree trunk is scenery: changing it is no mismatch
  assert.ok(F.diff(s, get(mm)).ok)
})
test('aesthetic mode: every block is wanted as itself; air is not kept', () => {
  const m = new Map(), set = (x, y, z, n, props = {}) => m.set(x + ',' + y + ',' + z, { name: n, props })
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) { set(x, 0, z, 'oak_planks'); set(x, 1, z, x === 1 && z === 1 ? 'air' : 'cobblestone') }
  set(1, 2, 1, 'oak_stairs', { facing: 'east', half: 'bottom', waterlogged: 'false' })
  const s = F.capture(get(m), { x0: 0, y0: 0, z0: 0, x1: 2, y1: 2, z1: 2 }, { id: 'a', mode: 'aesthetic', surround: 0 })
  assert.strictEqual(s.mode, 'aesthetic'); assert.ok(s.palette.every(e => e.role === 'any' || e.role === 'block'), 'no generic solid role: ' + JSON.stringify(s.palette))
  assert.ok(F.diff(s, get(m)).ok); m.set('0,1,0', { name: 'stone', props: {} }); assert.strictEqual(F.diff(s, get(m)).wrong.length, 1, 'stone is not cobblestone in an aesthetic build')
})
test('alt: an exact entry can name the blocks accepted in its place', () => {
  const e = { role: 'block', block: 'oak_planks', alt: ['spruce_planks'] }
  assert.ok(B.matches(e, 'oak_planks') && B.matches(e, 'minecraft:spruce_planks') && !B.matches(e, 'birch_planks'))
})
test('upgrade: a format 1 file becomes format 2 with a block for every wall cell', () => {
  const v1 = { v: 1, id: 'old', size: [1, 1, 1], origin: [0, 0, 0], palette: [{ role: 'any' }, { role: 'solid' }, { role: 'water', level: '0' }], rle: [1, 1], counts: { 1: 1 }, sources: { 1: { stone: 3, cobblestone: 9 } } }
  const u = F.upgrade(v1); assert.strictEqual(u.v, 2); assert.strictEqual(u.palette[1].block, 'cobblestone'); assert.strictEqual(u.palette[2].block, 'water'); assert.ok(!u.sources)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-v1-')); fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify(v1))
  assert.strictEqual(S.load([dir], 'old').palette[1].block, 'cobblestone', 'the store upgrades what it reads')
})
test('bill of materials: one row per block, isolatable; raw materials in cobblestone, logs and smelting', () => {
  const BOM = require('../brain/schematic/bom')
  const pal = [{ role: 'any' }, { role: 'solid', block: 'cobblestone' }, { role: 'solid', block: 'stone' }, { role: 'block', block: 'oak_stairs', props: { facing: 'east' } }, { role: 'block', block: 'oak_stairs', props: { facing: 'west' } },
    { role: 'block', block: 'oak_planks' }, { role: 'block', block: 'torch' }, { role: 'block', block: 'wall_torch', props: { facing: 'east' } }, { role: 'water', block: 'water', level: '0' }, { role: 'block', block: 'oak_log', scenery: true }, { role: 'block', block: 'cobblestone_slab', props: { type: 'bottom' } }]
  const s = { palette: pal, counts: { 1: 100, 2: 10, 3: 6, 4: 6, 5: 8, 6: 3, 7: 1, 8: 5, 9: 50, 10: 4 } }
  const rows = BOM.bom(s), by = Object.fromEntries(rows.map(r => [r.key, r]))
  assert.strictEqual(by.oak_stairs.cells, 12); assert.deepStrictEqual(by.oak_stairs.indices, [3, 4]); assert.strictEqual(by.torch.cells, 4, 'wall torches count as torches'); assert.ok(!by.oak_log, 'scenery is not in the bill')
  assert.ok(by.cobblestone.subs && /solid/.test(by.cobblestone.subs) && by.water.fluid)
  const raw = BOM.rawMaterials(rows), l = Object.fromEntries(raw.lines.map(x => [x.id, x.amount]))
  assert.strictEqual(l.cobblestone, 100 + 10 + 2, '100 cobblestone, 10 stone, 4 slabs = 2'); assert.strictEqual(l.smelting, 10 + 1, '10 stone + a quarter log of charcoal for 4 torches')
  assert.strictEqual(l.oak_log, Math.ceil((12 * 1.5 + 8) / 4 + 1 + 4 / 32))
  assert.ok(!raw.lines.some(x => /water/i.test(x.label)))
})

// ---- dashboard: a schematic for the viewer
test('dashboard schematiccast: index and detail of the library schematic', () => {
  const sc = require('../dashboard/schematiccast')
  const o = { sharedDir: path.join(os.tmpdir(), 'nonexistent-shared'), botDirs: [] }
  const idx = sc.index(o)
  assert.ok(idx.schematics.some(s => s.id === 'mobfarm-forever2k27' && s.mode === 'functional'))
  const d = sc.detail(o, 'mobfarm-forever2k27')
  assert.strictEqual(d.v, 2); assert.strictEqual(F.cellsOf(d).length, d.size[0] * d.size[1] * d.size[2])
  const cobble = d.bom.find(r => r.key === 'cobblestone'); assert.ok(cobble && cobble.cells === 926 && /solid/.test(cobble.subs))
  assert.ok(d.bom.every(r => r.indices.every(i => d.palette[i] && !d.palette[i].scenery)))
  assert.ok(d.raw.lines.find(l => l.id === 'cobblestone').amount > 900 && d.raw.lines.some(l => l.id === 'smelting'))
  assert.strictEqual(sc.detail(o, 'nope'), null)
})

test('the built-for-looks example: every block exact, stairs and fences and a door in the bill, the yard around it is scenery', () => {
  const s = D.starterHut(); assert.strictEqual(s.mode, 'aesthetic'); assert.ok(s.palette.every(e => e.role === 'any' || e.role === 'block' || e.role === 'air'), 'no generic roles in an aesthetic build')
  assert.ok(F.diff(s, (x, y, z) => ({ name: 'minecraft:stone', props: {} })).wrong.length === F.diff(s, (x, y, z) => ({ name: 'minecraft:stone', props: {} })).checked, 'stone is not the hut')
  const BOM = require('../brain/schematic/bom'), rows = BOM.bom(s), by = Object.fromEntries(rows.map(r => [r.key, r.cells]))
  assert.ok(by.oak_stairs > 20 && by.oak_fence > 30 && by.oak_planks > 100 && by.torch === 6 && by.oak_door === 2, JSON.stringify(by))
  assert.ok(s.palette.some(e => e.scenery && e.block === 'grass_block'), 'the lawn is scenery'); assert.ok(!rows.some(r => r.key === 'grass_block'))
  const lib = S.load([S.LIBRARY], 'starter-hut'); assert.ok(lib && lib.mode === 'aesthetic', 'it ships in the library')
})
