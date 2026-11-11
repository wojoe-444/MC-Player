// dashboard/basecast.js and /api/bases: the base as a cast of its dug and built space, from the bots' own records.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net')
const { spawn } = require('child_process')
const bc = require('../dashboard/basecast')

const REPO = path.join(__dirname, '..')
const J = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof o === 'string' ? o : JSON.stringify(o)) }
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const BASE = { id: 'chicago-1a2b', name: 'Chicago', x: -6023, y: 67, z: -2355, radius: 110, world: 'w' }

// the real Chicago shapes (registry from the laptop on 2026-11-11, trimmed)
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'basecast-'))
  const shared = path.join(root, 'bot-shared'), ozo = path.join(root, 'ozo'), smeo = path.join(root, 'smeo')
  J(path.join(shared, 'registry.json'), { worlds: {
    w: {
      shafts: [{ id: 'sh', by: 'OzoGo444', entry: [-6018, 65, -2355], wall: [0, 1], bottom: [-6018, -7, -2355], at: 5 }],
      rooms: [
        { id: 'storage-sh', type: 'storage', by: 'Smeo444', shaft: 'sh', box: { x0: -6020, x1: -6016, y0: 55, y1: 57, z0: -2364, z1: -2358 }, y: 55, chests: [[-6016, 55, -2359]], at: 6 },
        { id: 'mobfarm-sh', type: 'mobfarm', by: 'Smeo444', shaft: 'sh', box: { x0: -6039, x1: -6019, y0: 35, y1: 60, z0: -2364, z1: -2346 }, y: 37, platformY: 59, chests: [[-6030, 35, -2355]], at: 7 },
      ],
    },
    far: { shafts: [{ id: 'elsewhere', entry: [9000, 70, 9000], bottom: [9000, 10, 9000] }], rooms: [] },
  } })
  J(path.join(shared, 'placed-blocks.json'), { worlds: { w: { '-6016,55,-2359': ['chest', 'Smeo444', 1], '-6026,66,-2332': ['crafting_table', 'OzoGo444', 1], '-6019,65,-2340': ['white_bed', 'OzoGo444', 1], '-6020,60,-2350': ['cobblestone', 'OzoGo444', 1], '9000,70,9000': ['chest', 'x', 1] } } })
  const st = path.join(ozo, 'brain', 'state')
  J(path.join(st, 'treefarm-state.json'), { farms: [{ id: 'farm1', x: -6031, y: 66, z: -2336, cols: 2, rows: 1, species: 'oak', spotY: { '-6031,-2336': 66, '-6027,-2336': 67 } }] })
  J(path.join(st, 'husbandry-state.json'), { pens: [{ id: 'pen1', ox: -6035, oy: 66, oz: -2371, w: 7, d: 7, built: true }, { id: 'pen2', ox: 0, oy: 66, oz: 0, w: 3, d: 3, built: false }] })
  J(path.join(st, 'autopilot-state.json'), { farm: [[-6020, 62, -2360], [-6019, 62, -2360]], farmWater: [-6017, 62, -2359] })
  fs.mkdirSync(smeo, { recursive: true })
  return { root, shared, ozo, smeo, opts: { sharedDir: shared, registryFile: path.join(shared, 'registry.json'), botDirs: [{ id: 'ozo', dir: ozo }, { id: 'smeo', dir: smeo }], codeDir: REPO } }
}
const cellsOf = (c) => { const out = []; for (let i = 0; i < c.cells.length; i += c.cellStride) out.push({ x: c.cells[i], y: c.cells[i + 1], z: c.cells[i + 2], part: c.parts[c.cells[i + 3]], recorded: c.cells[i + 4] }); return out }
const has = (cells, x, y, z) => cells.find(c => c.x === x && c.y === y && c.z === z)

test('cast: shaft column, storage room with its two-cell corridor, mob farm from its design, farms, markers', () => {
  const w = world()
  const c = bc.buildCast({ base: BASE, ...w.opts })
  const cells = cellsOf(c)
  assert.deepStrictEqual(c.parts.map(p => p.id), ['sh', 'storage-sh', 'mobfarm-sh', 'tree-farm1', 'pen-pen1', 'crops'])
  // shaft: every cell from the bottom to the entry, one wide
  assert.strictEqual(c.parts[0].cells, 73)
  assert.ok(has(cells, -6018, -7, -2355) && has(cells, -6018, 65, -2355) && !has(cells, -6018, 66, -2355))
  // storage: the 5 x 7 x 3 box plus a corridor from the shaft (z -2356 and -2357, two high)
  assert.strictEqual(c.parts[1].cells, 5 * 7 * 3 + 4)
  assert.ok(has(cells, -6018, 55, -2356) && has(cells, -6018, 56, -2357) && has(cells, -6018, 55, -2358))
  // mob farm: from the design (the drop column at x -6030, chest cell at y35), not the 21 x 26 x 19 box
  assert.match(c.parts[2].detail, /design/)
  assert.ok(has(cells, -6030, 59, -2355) && has(cells, -6030, 35, -2355))
  assert.ok(c.parts[2].cells < 21 * 26 * 19 / 4)
  // farms: tree spots (2 high), the built pen only, crops with headroom and the water cell
  assert.strictEqual(c.parts[3].cells, 4)
  assert.strictEqual(c.parts[4].cells, 7 * 7 * 2)
  assert.ok(has(cells, -6020, 63, -2360) && has(cells, -6020, 64, -2360) && has(cells, -6017, 62, -2359))
  // markers: the chests of the rooms, plus a table and a bed from the placed log; nothing outside the base; a cobblestone block is not a marker
  assert.deepStrictEqual(c.markers.map(m => m.type).sort(), ['bed', 'chest', 'chest', 'table'])
  assert.ok(c.markers.every(m => Math.hypot(m.x - BASE.x, m.z - BASE.z) <= BASE.radius))
  assert.strictEqual(c.stats.placedInBase, 4)
  assert.strictEqual(c.stats.minY, -7)
  assert.strictEqual(c.stats.recorded, 0)
  assert.match(c.notes.join(' '), /No digs recorded yet/)
  assert.strictEqual(c.sources.dugLog, false)
})

test('cast: recorded digs become tunnels, never override a shaft or room cell, and say they are recorded', () => {
  const w = world()
  const dug = [[-6018, 10, -2355, 'stone', 'OzoGo444', 100], [-6017, 10, -2355, 'stone', 'OzoGo444', 101], [-6016, 10, -2355, 'stone', 'Smeo444', 102], [-6016, 10, -2355, 'dirt', 'Smeo444', 103]]
  J(path.join(w.shared, 'base-dug', BASE.id + '.jsonl'), dug.map(l => JSON.stringify(l)).join('\n') + '\nnot json\n[1,2]\n')
  const c = bc.buildCast({ base: BASE, ...w.opts })
  const cells = cellsOf(c)
  assert.strictEqual(c.stats.digsRecorded, 3)                        // a cell dug twice counts once; junk lines are skipped
  assert.strictEqual(has(cells, -6018, 10, -2355).part.id, 'sh')     // the shaft keeps its own cell
  assert.strictEqual(has(cells, -6018, 10, -2355).recorded, 0)
  assert.strictEqual(has(cells, -6017, 10, -2355).part.id, 'dug')
  assert.strictEqual(has(cells, -6017, 10, -2355).recorded, 1)
  const part = c.parts.find(p => p.id === 'dug')
  assert.strictEqual(part.kind, 'tunnel'); assert.strictEqual(part.cells, 2); assert.match(part.detail, /3 blocks dug/)
  assert.ok(!/No digs recorded yet/.test(c.notes.join(' ')))
  assert.strictEqual(c.stats.recorded, 2)
})

test('cast: no registry, no state, no code folder: an empty cast, not a crash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'basecast-empty-'))
  const c = bc.buildCast({ base: BASE, sharedDir: root, registryFile: path.join(root, 'nope.json'), botDirs: [], codeDir: null })
  assert.deepStrictEqual(c.cells, []); assert.strictEqual(c.stats.cells, 0); assert.strictEqual(c.stats.minY, null)
  assert.deepStrictEqual(bc.basesIndex({ sharedDir: root, registryFile: path.join(root, 'nope.json'), codeDir: null }).bases, [])
})

test('mob farm without the code folder falls back to the recorded box, and says so', () => {
  const w = world()
  const c = bc.buildCast({ base: BASE, ...w.opts, codeDir: null })
  const part = c.parts.find(p => p.id === 'mobfarm-sh')
  assert.ok(part.cells > 10000 && part.cells <= 21 * 26 * 19)           // the whole box, less the cells the shaft and the storage room already hold
  assert.match(c.notes.join(' '), /whole recorded box/)
})

test('corridorToBox: along the axis that points at the box, stops at the wall, nothing for a diagonal', () => {
  const sh = { entry: [-6018, 65, -2355] }
  const box = { x0: -6020, x1: -6016, z0: -2364, z1: -2358 }
  assert.deepStrictEqual(bc.corridorToBox(sh, box, 55), [[-6018, 55, -2356], [-6018, 56, -2356], [-6018, 55, -2357], [-6018, 56, -2357]])
  assert.deepStrictEqual(bc.corridorToBox(sh, { x0: 0, x1: 5, z0: 0, z1: 5 }, 55), [])
  assert.deepStrictEqual(bc.corridorToBox(sh, null, 55), [])
})

test('base list: bases.json first, across worlds; the waypoint book of the code folder when there is none yet', () => {
  const w = world()
  assert.deepStrictEqual(bc.listBases({ sharedDir: w.shared, codeDir: null, registry: null }), [])
  J(path.join(w.shared, 'bases.json'), { worlds: { w: { bases: [{ id: 'chicago-1a2b', name: 'Chicago', x: -6023, y: 67, z: -2355, radius: 110, source: 'waypoint' }, { id: 'bad', name: 'Bad', x: 'x', radius: 5 }] } } })
  const list = bc.listBases({ sharedDir: w.shared, codeDir: null, registry: null })
  assert.deepStrictEqual(list.map(b => [b.id, b.name, b.world]), [['chicago-1a2b', 'Chicago', 'w']])

  // before the bot wrote bases.json: Chicago looked up in the waypoint book through the code folder (Xaero path overridden to a fixture)
  const w2 = world(), xdir = path.join(w2.root, 'xaero')
  J(path.join(xdir, 'minimap', 'Test World', 'dim%0', 'waypoints.txt'), '#\nwaypoint:Chicago:C:-6023:67:-2355:3:false:0:gui.xaero_default:false:0:0:false\nwaypoint:Mumbai:M:5009:84:-626:3:false:0:gui.xaero_default:false:0:0:false\n')
  J(path.join(xdir, 'world-map', 'Test World', 'null', 'cache_1', 'x'), '')
  const out = require('child_process').spawnSync(process.execPath, ['-e', `const bc = require(${JSON.stringify(path.join(REPO, 'dashboard', 'basecast.js'))}); console.log(JSON.stringify(bc.basesIndex(${JSON.stringify(w2.opts)}).bases))`], { env: { ...process.env, XAERO_DIR: xdir }, encoding: 'utf8' })
  const found = JSON.parse(out.stdout.trim())
  assert.strictEqual(found.length, 1); assert.strictEqual(found[0].name, 'Chicago'); assert.strictEqual(found[0].x, -6023); assert.strictEqual(found[0].radius, 110)
})

test('/api/bases and /api/bases/<id> serve the cast; an unknown base is a 404', async () => {
  const w = world()
  J(path.join(w.shared, 'bases.json'), { worlds: { w: { bases: [{ id: 'chicago-1a2b', name: 'Chicago', x: -6023, y: 67, z: -2355, radius: 110 }] } } })
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(REPO, 'dashboard', 'server.js')], { env: { ...process.env, PORT: String(port), BOT_OZO_DIR: w.ozo, BOT_SMEO_DIR: w.smeo, BOT_CODE_DIR: REPO, BOT_REGISTRY: path.join(w.shared, 'registry.json') }, stdio: 'ignore' })
  try {
    let r
    for (let i = 0; i < 50 && !r; i++) { try { r = await fetch(`http://127.0.0.1:${port}/api/bases`) } catch { await new Promise(x => setTimeout(x, 100)) } }
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual((await r.json()).bases.map(b => b.name), ['Chicago'])
    const c = await (await fetch(`http://127.0.0.1:${port}/api/bases/chicago-1a2b`)).json()
    assert.strictEqual(c.base.name, 'Chicago'); assert.ok(c.stats.cells > 500); assert.strictEqual(c.cellStride, 5)
    assert.strictEqual((await fetch(`http://127.0.0.1:${port}/api/bases/nope`)).status, 404)
  } finally { child.kill() }
})
