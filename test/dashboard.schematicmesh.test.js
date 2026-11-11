// dashboard/web/src/lib/schematic: block appearance, shapes and the mesher behind the Schematics viewer. Plain TypeScript, so node loads it as is.
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { pathToFileURL } = require('url')
const lib = (f) => pathToFileURL(path.join(__dirname, '..', 'dashboard', 'web', 'src', 'lib', 'schematic', f)).href
const SC = require('../dashboard/schematiccast')
const opts = { sharedDir: path.join(require('os').tmpdir(), 'nonexistent-shared'), botDirs: [] }
const all = { minLayer: 0, maxLayer: 99, isolate: null, scenery: true, ghost: true }
const quads = (m) => m.indices.length / 6

test('every block gets a tile; the same spec paints the same pixels; unknown blocks still get a colour', async () => {
  const A = await import(lib('appearance.ts'))
  for (const n of ['cobblestone', 'oak_planks', 'oak_stairs', 'cobblestone_slab', 'birch_trapdoor', 'torch', 'hopper', 'chest', 'water', 'oak_log', 'stone_bricks', 'coal_ore', 'white_wool', 'glass', 'grass_block', 'some_modded_thing']) {
    const s = A.styleOf(n); for (const sp of [s.top, s.side, s.bottom]) { const px = A.paintTile(sp); assert.strictEqual(px.length, 16 * 16 * 4); assert.deepStrictEqual(A.paintTile(sp), px, n) }
  }
  assert.strictEqual(A.styleOf('oak_stairs').side, A.styleOf('oak_planks').side, 'stairs are painted like the planks they are cut from')
  assert.notStrictEqual(A.styleOf('oak_log').top, A.styleOf('oak_log').side, 'a log has rings on top')
  assert.notStrictEqual(A.styleOf('stone').side, A.styleOf('cobblestone').side)
  const px = A.paintTile(A.styleOf('torch').side); let clear = 0, solid = 0; for (let i = 3; i < px.length; i += 4) px[i] ? solid++ : clear++
  assert.ok(clear > 200 && solid > 10, 'a torch is a stick on a transparent tile')
  const atlas = A.makeAtlas([A.styleOf('stone').side, A.styleOf('dirt').side, A.styleOf('stone').side])
  assert.strictEqual(atlas.index.size, 2); assert.ok(atlas.width >= 16 && atlas.pixels.length === atlas.width * atlas.height * 4)
})

test('shapes: stairs, slabs, trapdoors, fences that join, double chests', async () => {
  const S = await import(lib('shapes.ts'))
  assert.deepStrictEqual(S.shapeOf('stone').boxes, [[0, 0, 0, 16, 16, 16]])
  assert.deepStrictEqual(S.shapeOf('oak_slab', { type: 'top' }).boxes, [[0, 8, 0, 16, 16, 16]])
  const east = S.shapeOf('oak_stairs', { facing: 'east', half: 'bottom' }).boxes, west = S.shapeOf('oak_stairs', { facing: 'west', half: 'bottom' }).boxes
  assert.deepStrictEqual(east[1], [8, 8, 0, 16, 16, 16]); assert.deepStrictEqual(west[1], [0, 8, 0, 8, 16, 16], 'the high side turns with the facing')
  assert.deepStrictEqual(S.shapeOf('oak_stairs', { facing: 'east', half: 'top' }).boxes[1], [8, 0, 0, 16, 8, 16], 'upside down')
  assert.deepStrictEqual(S.shapeOf('birch_trapdoor', { open: 'false', half: 'top' }).boxes, [[0, 13, 0, 16, 16, 16]])
  assert.deepStrictEqual(S.shapeOf('birch_trapdoor', { open: 'true', facing: 'east' }).boxes, [[0, 0, 0, 3, 16, 16]], 'an open trapdoor lies against the side opposite its facing')
  assert.strictEqual(S.shapeOf('oak_fence', {}, () => false).boxes.length, 1); assert.strictEqual(S.shapeOf('oak_fence', {}, (dx) => dx === 1).boxes.length, 3)
  const l = S.shapeOf('chest', { facing: 'south', type: 'left' }).boxes[0], r = S.shapeOf('chest', { facing: 'south', type: 'right' }).boxes[0]
  assert.strictEqual(l[3], 16); assert.strictEqual(r[0], 0); assert.deepStrictEqual(S.shapeOf('chest', {}).boxes[0], [1, 0, 1, 15, 14, 15])
  assert.strictEqual(S.shapeOf('water', { level: '0' }, undefined, true).boxes[0][4], 16); assert.ok(S.shapeOf('water', { level: '0' }).boxes[0][4] < 16)
  assert.strictEqual(S.shapeOf('short_grass').kind, 'cross')
})

test('mesher: a closed cube hides its inner faces; slicing, isolating and ghosts', async () => {
  const M = await import(lib('mesher.ts'))
  const pal = [{ role: 'any' }, { role: 'solid', block: 'cobblestone' }, { role: 'block', block: 'oak_planks' }]
  const cells = new Uint16Array(27).fill(1); cells[13] = 0                                    // 3x3x3 cobblestone with a hole in the middle
  const prep = M.prepare({ size: [3, 3, 3], cells, palette: pal })
  const b = M.build(prep, all)
  assert.strictEqual(quads(b.opaque), 6 * 9 + 6, 'the 54 outer faces and the 6 faces of the hole show; nothing else')
  assert.strictEqual(b.visible, 26); assert.strictEqual(b.total, 26)
  const top = M.build(prep, { ...all, maxLayer: 0 })
  assert.strictEqual(top.visible, 9); assert.ok(quads(top.ghost) > 0 && quads(top.ghost) < 54, 'the hidden layers are a faint shell, not every face')
  assert.strictEqual(M.build(prep, { ...all, maxLayer: 0, ghost: false }).ghost.indices.length, 0)
  assert.strictEqual(M.build(prep, { ...all, minLayer: 1, maxLayer: 1 }).visible, 8, 'a single layer')
  const mixed = cells.slice(); mixed[0] = 2; mixed[1] = 2
  const iso = M.build(M.prepare({ size: [3, 3, 3], cells: mixed, palette: pal }), { ...all, isolate: new Set([2]) })
  assert.strictEqual(iso.visible, 2); assert.strictEqual(quads(iso.opaque), 10 + 0, 'two planks side by side: 10 outer faces')
  const cell = iso.opaque.quadCell; assert.ok([...cell].every(c => c === 0 || c === 1), 'every face knows its cell (for hover)')
})

test('mesher: the real mob farm. Scenery can be turned off; water is translucent; every face points at a known cell', async () => {
  const M = await import(lib('mesher.ts'))
  const d = SC.detail(opts, 'mobfarm-forever2k27'), cells = M.decodeCells(d.rle, d.size)
  const prep = M.prepare({ size: d.size, cells, palette: d.palette })
  const on = M.build(prep, all), off = M.build(prep, { ...all, scenery: false })
  assert.ok(quads(on.opaque) > quads(off.opaque) && quads(off.opaque) > 500, `${quads(on.opaque)} vs ${quads(off.opaque)}`)
  assert.ok(quads(on.trans) > 20, 'the water')
  assert.strictEqual(on.total, d.bom.reduce((n, r) => n + r.cells, 0), 'the bill counts exactly the cells that are drawn as the build')
  assert.strictEqual(on.visible, on.total)
  const cobble = d.bom.find(r => r.key === 'cobblestone'), only = M.build(prep, { ...all, isolate: new Set(cobble.indices) })
  assert.strictEqual(only.visible, 926); assert.ok(quads(only.ghost) > 0)
  const n = d.size[0] * d.size[1] * d.size[2]; for (const m of [on.opaque, on.trans, off.opaque]) assert.ok(m.quadCell.every(c => c >= 0 && c < n))
  assert.ok(on.opaque.positions.every(Number.isFinite) && on.opaque.uvs.every(v => v >= 0 && v <= 1))
})
