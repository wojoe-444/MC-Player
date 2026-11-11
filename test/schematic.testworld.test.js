// brain/schematic/testworld.js + anvil.js + settle.js: a schematic as a creative superflat test world (1.21.6 save), checked by reading the region files back.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')
const F = require('../brain/schematic/format')
const T = require('../brain/schematic/testworld')
const A = require('../brain/schematic/anvil')
const W = require('../brain/schematic/world')

// a 5x4x3 aesthetic build: a row of oak fence with a log at one end, a stone brick wall, leaves, a lantern under a slab, a door
function tiny() {
  const cells = new Map()
  const put = (x, y, z, name, props) => cells.set(x + ',' + y + ',' + z, { name, props: props || {} })
  for (let x = 0; x < 4; x++) put(x, 0, 0, 'oak_fence')
  put(4, 0, 0, 'oak_log', { axis: 'y' })
  put(0, 0, 2, 'stone_brick_wall'); put(1, 0, 2, 'stone_brick_wall')
  put(2, 1, 1, 'oak_leaves'); put(3, 2, 1, 'stone_slab', { type: 'bottom' }); put(3, 1, 1, 'lantern')
  put(0, 0, 1, 'oak_door', { facing: 'north', half: 'lower', open: 'false', hinge: 'left' })
  return F.capture((x, y, z) => cells.get(x + ',' + y + ',' + z) || { name: 'air', props: {} }, { x0: 0, y0: 0, z0: 0, x1: 4, y1: 3, z1: 2 }, { id: 'tiny', name: 'Tiny', mode: 'aesthetic', surround: 0 })
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'testworld-'))

test('a grass test world: the build is in the region files, on the flat ground, with the right level.dat', async () => {
  const dir = tmp()
  try {
    const r = T.buildWorld(tiny(), { savesDir: dir, name: 'Test - Tiny' })
    assert.strictEqual(r.name, 'Test - Tiny')
    assert.ok(fs.existsSync(path.join(r.saveDir, T.MARK)) && fs.existsSync(path.join(r.saveDir, 'region')))
    const w = W.openSave(r.saveDir), [ox, oy, oz] = r.origin
    assert.strictEqual(w.get(ox, oy - 1, oz).name, 'minecraft:grass_block', 'the lowest layer stands on the grass')
    assert.strictEqual(w.get(ox, -64, oz).name, 'minecraft:bedrock')
    assert.strictEqual(w.get(ox, -62, oz).name, 'minecraft:dirt')
    assert.strictEqual(w.get(ox + 4, oy, oz).name, 'minecraft:oak_log'); assert.strictEqual(w.get(ox + 4, oy, oz).props.axis, 'y')
    // what a schematic does not keep, worked out from the neighbours
    assert.deepStrictEqual(['north', 'south', 'east', 'west'].map(d => w.get(ox + 1, oy, oz).props[d]), ['false', 'false', 'true', 'true'], 'a fence joins the fences and the log beside it')
    assert.strictEqual(w.get(ox + 3, oy, oz).props.east, 'true', 'and a full block')
    const wall = w.get(ox, oy, oz + 2).props; assert.strictEqual(wall.east, 'low'); assert.strictEqual(wall.west, 'none'); assert.strictEqual(wall.up, 'true')
    assert.strictEqual(w.get(ox + 2, oy + 1, oz + 1).props.persistent, 'true', 'leaves do not decay')
    assert.strictEqual(w.get(ox + 3, oy + 1, oz + 1).props.hanging, 'true', 'a lantern under a slab hangs')
    assert.strictEqual(w.get(ox, oy, oz + 1).props.hinge, 'left', 'the properties the schematic keeps stay')
    w.close()
    const { parsed } = await nbt.parse(fs.readFileSync(path.join(r.saveDir, 'level.dat')))
    const D = nbt.simplify(parsed).Data
    assert.strictEqual(D.DataVersion, A.DATA_VERSION); assert.strictEqual(D.GameType, 1); assert.strictEqual(D.allowCommands, 1); assert.strictEqual(D.LevelName, 'Test - Tiny')
    assert.deepStrictEqual(Array.from(D.DayTime), [0, 6000]); assert.strictEqual(D.GameRules.doDaylightCycle, 'false')
    assert.strictEqual(D.WorldGenSettings.dimensions['minecraft:overworld'].generator.type, 'minecraft:flat')
    assert.deepStrictEqual([D.SpawnX, D.SpawnY, D.SpawnZ], r.spawn)
    assert.ok(r.spawn[2] < oz, 'spawn is north of the build, outside it')
    assert.ok(zlib.gunzipSync(fs.readFileSync(path.join(r.saveDir, 'level.dat'))).length > 0, 'level.dat is gzip')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('never touches an existing save: refuses, and --overwrite only replaces a world this tool made', () => {
  const dir = tmp()
  try {
    fs.mkdirSync(path.join(dir, 'Earth24k')); fs.writeFileSync(path.join(dir, 'Earth24k', 'level.dat'), 'precious')
    assert.throws(() => T.buildWorld(tiny(), { savesDir: dir, name: 'Earth24k' }), /already exists/)
    assert.throws(() => T.buildWorld(tiny(), { savesDir: dir, name: 'Earth24k', overwrite: true }), /not made by this tool/)
    assert.strictEqual(fs.readFileSync(path.join(dir, 'Earth24k', 'level.dat'), 'utf8'), 'precious')
    T.buildWorld(tiny(), { savesDir: dir, name: 'Test - Again' })
    assert.throws(() => T.buildWorld(tiny(), { savesDir: dir, name: 'Test - Again' }), /already exists/)
    assert.ok(T.buildWorld(tiny(), { savesDir: dir, name: 'Test - Again', overwrite: true }).chunks > 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a void world has a platform at spawn and nothing else but the build', () => {
  const dir = tmp()
  try {
    const r = T.buildWorld(tiny(), { savesDir: dir, name: 'Test - Void', kind: 'void' }), w = W.openSave(r.saveDir)
    assert.strictEqual(r.origin[1], 64)
    assert.strictEqual(w.get(r.spawn[0], r.spawn[1] - 1, r.spawn[2]).name, 'minecraft:smooth_stone')
    assert.strictEqual(w.get(r.origin[0] + 4, r.origin[1], r.origin[2]).name, 'minecraft:oak_log')
    assert.strictEqual(w.get(r.origin[0] + 4, -61, r.origin[2]).name, 'minecraft:air', 'no ground')
    w.close()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('an underground build: deep stone ground, and the rooms (air that is not rock) are cut out of it', () => {
  const dir = tmp()
  try {
    // a 7x6x7 box: a closed room (air at the middle, walled in cobblestone) below the surface at layer 5; the rest of the air is rock
    const W0 = 7, H0 = 6, D0 = 7, cells = new Uint16Array(W0 * H0 * D0), states = [{ name: 'air', props: {} }, { name: 'cobblestone', props: {} }]
    for (let y = 0; y <= 4; y++) for (let z = 1; z <= 5; z++) for (let x = 1; x <= 5; x++) if (!(x >= 2 && x <= 4 && z >= 2 && z <= 4 && y >= 1 && y <= 3)) cells[x + W0 * (z + D0 * y)] = 1
    const r = T.buildWorld({ id: 'room', name: 'Room', mode: 'aesthetic', raw: { W: W0, H: H0, D: D0, cells, states } }, { savesDir: dir, name: 'Test - Room', surface: 5 }), w = W.openSave(r.saveDir)
    const [ox, oy, oz] = r.origin
    assert.strictEqual(r.groundTop, oy + 4)
    assert.strictEqual(r.carved, 27, 'the 3x3x3 room')
    assert.strictEqual(w.get(ox + 3, oy + 2, oz + 3).name, 'minecraft:air', 'the room is open')
    assert.strictEqual(w.get(ox + 3, oy + 4, oz + 3).name, 'minecraft:cobblestone', 'its roof')
    assert.strictEqual(w.get(ox, oy + 1, oz).name, 'minecraft:stone', 'the rock around it is the flat ground')
    assert.strictEqual(w.get(ox, oy + 4, oz).name, 'minecraft:grass_block')
    w.close()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
