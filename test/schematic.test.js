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
  assert.deepStrictEqual(B.describe('water', { level: '3' }), { role: 'water', level: '3' })
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
  const m = world(), s = F.capture(get(m), box, { id: 't', seeds: [[3, 2, 3]] })
  const roles = s.palette.map(p => p.role + (p.block ? ':' + p.block : ''))
  assert.deepStrictEqual(roles.slice().sort(), ['any', 'air', 'block:hopper', 'block:torch', 'solid', 'water', 'water'].sort())
  assert.ok(!roles.includes('block:oak_log'), 'the tree is not connected to the cavity')
  const cells = F.cellsOf(s); assert.strictEqual(cells.length, 9 * 5 * 7)
  const legend = F.legend(s); assert.ok(legend.find(l => l.role === 'solid' && l.sources[0].block === 'cobblestone'))
  assert.strictEqual(legend.find(l => l.role === 'any').cells, 9 * 5 * 7 - legend.filter(l => l.role !== 'any').reduce((n, l) => n + l.cells, 0))
  // hopper at (3,0,3): kept as exact; rock in the corner (0,0,0) touches nothing open: any
  assert.strictEqual(s.palette[cells[F.idx(s.size, 0, 0, 0)]].role, 'any')
  assert.deepStrictEqual(s.palette[cells[F.idx(s.size, 3, 0, 3)]], { role: 'block', block: 'hopper', props: { facing: 'down' } })
})
test('diff: any other solid block still matches; wood in a wall, a hole, a wrong water level and a hopper facing sideways do not', () => {
  const m = world(), s = F.capture(get(m), box, { id: 't', seeds: [[3, 2, 3]] })
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
  const m = world(), s = F.capture(get(m), box, { id: 't', masks: [{ x0: 0, y0: 0, z0: 0, x1: 4, y1: 4, z1: 6 }] })
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
  const leg = F.legend(s); assert.ok(leg.some(l => l.role === 'solid' && l.sources.some(x => x.block === 'cobblestone')), 'cobblestone walls are stored as "solid"')
  assert.ok(leg.some(l => l.label.startsWith('hopper')) && leg.some(l => l.label.startsWith('water level 0')) && leg.some(l => /trapdoor/.test(l.label)) && leg.some(l => /cobblestone_slab/.test(l.label)))
  assert.ok(!leg.some(l => /leaves|cave_vines|spruce_log/.test(l.label)), 'the trees and vines around it are not part of it')
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

// ---- dashboard: a schematic as a CastData payload
test('dashboard schematiccast: index and cast of the library schematic', () => {
  const sc = require('../dashboard/schematiccast')
  const o = { sharedDir: path.join(os.tmpdir(), 'nonexistent-shared'), botDirs: [] }
  const idx = sc.index(o)
  assert.ok(idx.schematics.some(s => s.id === 'mobfarm-forever2k27'))
  const c = sc.cast(o, 'mobfarm-forever2k27')
  assert.equal(c.cellStride, 5)
  assert.equal(c.cells.length, c.stats.cells * 5)
  assert.ok(c.parts.every(p => p.cells > 0))
  assert.ok(c.schematic.legend.some(l => l.role === 'solid' && /light-blocking/.test(l.needs)))
  assert.equal(sc.cast(o, 'nope'), null)
})
