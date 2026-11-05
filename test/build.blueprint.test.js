const test = require('node:test')
const assert = require('node:assert')
const bp = require('../brain/build/blueprint')

const O = { ox: 100, oy: 70, oz: 200 }
const rel = (s) => `${s.x - O.ox},${s.y - O.oy},${s.z - O.oz}`
const steps = bp.tower(O)
const at = (x, y, z) => steps.find(s => s.stage === 'pillar' && rel(s) === `${x},${y},${z}`)   // the tower as built from the pillar

test('deterministic: the same origin gives the same list, a different origin only shifts it', () => {
  assert.deepStrictEqual(bp.tower(O), steps)
  const moved = bp.tower({ ox: 5, oy: 10, oz: -7 })
  assert.strictEqual(moved.length, steps.length)
  moved.forEach((m, i) => { assert.strictEqual(m.x - 5, steps[i].x - O.ox); assert.strictEqual(m.y - 10, steps[i].y - O.oy); assert.strictEqual(m.z + 7, steps[i].z - O.oz); assert.strictEqual(m.block, steps[i].block) })
})

test('counts: stone bricks, 36 spruce logs, planks, 10 ladders, 4 torches (+1 optional), one door', () => {
  const all = bp.count(steps, { optional: true }), req = bp.count(steps)
  assert.strictEqual(req.spruce_log, 36)
  assert.strictEqual(req.stone_bricks, 98 + 20)                       // ring 16x9 - 36 corner logs - 8 window cells - 2 door cells; plus 20 parapet cells
  assert.strictEqual(req.spruce_planks, 7 + 43 + 2)                   // floor 7, deck 43, the two centre fills
  assert.strictEqual(req.ladder, 10)
  assert.strictEqual(req.torch, 4)
  assert.strictEqual(all.torch, 5, 'one more torch inside, optional')
  assert.strictEqual(req.spruce_door, 1)
  assert.strictEqual(req.cobblestone, undefined, 'no foundation on flat ground')
  assert.deepStrictEqual([all.crafting_table, all.chest, all.bed], [1, 1, 1])
  assert.ok(steps.filter(s => s.optional).every(s => s.stage === 'furnish'))
})

test('corners are logs placed on top faces (axis y), the rest of the ring is stone bricks', () => {
  for (let c = 0; c < 9; c++) {
    for (const [x, z] of [[0, 0], [4, 0], [0, 4], [4, 4]]) {
      const s = at(x, c, z)
      assert.strictEqual(s.block, 'spruce_log'); assert.deepStrictEqual(s.face, { x: 0, y: 1, z: 0 }); assert.strictEqual(s.refKind, c === 0 ? 'ground' : 'below')
    }
  }
  assert.strictEqual(at(1, 3, 0).block, 'stone_bricks')
})

test('door and window cells stay empty in the ring; the door itself goes in last, from outside', () => {
  for (const c of [0, 1]) assert.strictEqual(at(2, c, 4), undefined, `door gap at course ${c}`)
  for (const c of [2, 6]) for (const [x, z] of [[2, 0], [2, 4], [0, 2], [4, 2]]) assert.strictEqual(at(x, c, z), undefined, `window ${x},${c},${z}`)
  const door = steps[steps.length - 1]
  assert.strictEqual(door.block, 'spruce_door'); assert.strictEqual(rel(door), '2,0,4'); assert.strictEqual(door.stage, 'door')
  assert.deepStrictEqual(door.stand, { x: O.ox + 2, y: O.oy, z: O.oz + 5 }, 'placed standing at (2,0,5)')
  assert.strictEqual(rel({ x: door.ref.x, y: door.ref.y, z: door.ref.z }), '2,-1,4', 'on the ground block under the gap')
  // the lintel above the window over the door hangs on the previous ring block of its course
  const lintel = at(2, 3, 4)
  assert.strictEqual(lintel.refKind, 'side'); assert.strictEqual(rel({ x: lintel.ref.x, y: lintel.ref.y, z: lintel.ref.z }), '3,3,4')
})

test('floor at course 4: 7 planks, no ladder cell, no centre; against side faces of ring blocks of the same level', () => {
  const floor = steps.filter(s => s.phase === 'floor')
  assert.strictEqual(floor.length, 7)
  assert.ok(floor.every(s => s.y === O.oy + 4 && s.refKind === 'side' && s.ref.y === s.y))
  assert.strictEqual(at(1, 4, 1), undefined, 'ladder cell open'); assert.ok(!floor.some(s => rel(s) === '2,4,2'))
})

test('deck at course 9 is an octagon: 7x7 minus its corners, 43 planks before the centre and ladder-hole fills, parapet on the edge', () => {
  const deck = steps.filter(s => s.phase === 'deck')
  assert.strictEqual(deck.length, 43)
  const cells = new Set(deck.map(rel).map(k => k.replace(/^(-?\d+),9,(-?\d+)$/, '$1,$2')))
  cells.add('1,1'); cells.add('2,2')                                    // the hole and the centre (filled / left open later)
  assert.strictEqual(cells.size, 45)
  for (let x = -1; x <= 5; x++) for (let z = -1; z <= 5; z++) {
    const corner = (x === -1 || x === 5) && (z === -1 || z === 5)
    assert.strictEqual(cells.has(`${x},${z}`), !corner, `deck ${x},${z}`)
  }
  assert.ok(deck.every(s => s.y === O.oy + 9 && s.feet === 9))
  const parapet = steps.filter(s => s.phase === 'parapet')
  assert.strictEqual(parapet.length, 20)
  assert.ok(parapet.every(s => s.block === 'stone_bricks' && s.y === O.oy + 10 && s.refKind === 'below'))
  assert.ok(parapet.every(s => { const x = s.x - O.ox, z = s.z - O.oz; return x === -1 || x === 5 || z === -1 || z === 5 }))
  const torches = steps.filter(s => s.phase === 'torches')
  assert.deepStrictEqual(torches.map(rel).sort(), ['-1,11,2', '2,11,-1', '2,11,5', '5,11,2'])
  assert.ok(torches.every(s => s.feet === 10))
})

test('ladder: cells (1,0..9,1) bottom-up against the east faces of the west wall, each placed from the rung below', () => {
  const lad = steps.filter(s => s.block === 'ladder')
  assert.deepStrictEqual(lad.map(s => s.y - O.oy), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  for (const s of lad) {
    assert.strictEqual(s.x - O.ox, 1); assert.strictEqual(s.z - O.oz, 1)
    assert.deepStrictEqual(s.face, { x: 1, y: 0, z: 0 }); assert.strictEqual(s.ref.x - O.ox, 0); assert.strictEqual(s.ref.y, s.y); assert.strictEqual(s.ref.z - O.oz, 1)
    assert.strictEqual(s.stand.y - O.oy, Math.max(0, s.y - O.oy - 1))
  }
  // the pillar stages come first, then the ladder, then the fills
  const firstLadder = steps.indexOf(lad[0])
  assert.ok(steps.slice(0, firstLadder).every(s => s.stage === 'foundation' || s.stage === 'pillar'))
  assert.deepStrictEqual(steps.filter(s => s.stage.startsWith('fill')).map(rel), ['2,9,2', '2,4,2'])
})

test('every step has its reference block already there: natural ground or an earlier step; nothing is placed twice', () => {
  const placed = new Map()                                              // key -> block
  const key = (p) => `${p.x},${p.y},${p.z}`
  for (const s of steps) {
    assert.strictEqual(placed.has(s.key), false, `${s.key} placed twice`)
    if (s.refKind === 'ground') assert.ok(s.ref.y <= O.oy - 1, `ground ref of ${s.key}`)
    else {
      const r = placed.get(key(s.ref))
      assert.ok(r, `step ${s.id} (${s.block} at ${rel(s)}) has no reference block at ${s.ref.x - O.ox},${s.ref.y - O.oy},${s.ref.z - O.oz}`)
      assert.ok(!/torch|ladder|door/.test(r), 'never against a thin block')
      assert.strictEqual(s.refKind, s.ref.y === s.y - 1 && s.face.y === 1 ? 'below' : 'side')
    }
    // the reference face really points at the target
    assert.strictEqual(s.ref.x + s.face.x, s.x); assert.strictEqual(s.ref.y + s.face.y, s.y); assert.strictEqual(s.ref.z + s.face.z, s.z)
    placed.set(s.key, s.block)
  }
})

test('nothing is placed outside the 7x7 (+margin) x 13 volume, only whitelisted items', () => {
  for (const s of steps) {
    assert.ok(bp.inBox(O, s), `${s.key} outside the volume`)
    assert.ok(bp.allowedItem(s.item), `${s.item} is not on the whitelist`)
    assert.ok(s.y >= O.oy - 1 && s.y <= O.oy + 12)
  }
  assert.ok(!bp.allowedItem('dirt') && !bp.allowedItem('tnt') && !bp.allowedItem('lava_bucket') && bp.allowedItem('red_bed'))
  assert.deepStrictEqual(bp.box(O), { min: { x: 99, y: 68, z: 199 }, max: { x: 105, y: 82, z: 205 } })
})

test('pillar stages are ordered by height and every step is reachable from its pillar top (eye to face within 4.5)', () => {
  const pst = steps.filter(s => s.stage === 'pillar')
  for (let i = 1; i < pst.length; i++) assert.ok(pst[i].feet >= pst[i - 1].feet, 'feet never go down')
  assert.strictEqual(Math.max(...pst.map(s => s.feet)), 10)
  for (const s of pst) {
    const eye = { x: O.ox + 2.5, y: O.oy + s.feet + 1.62, z: O.oz + 2.5 }
    const f = { x: s.ref.x + 0.5 + s.face.x * 0.5, y: s.ref.y + 0.5 + s.face.y * 0.5, z: s.ref.z + 0.5 + s.face.z * 0.5 }
    const d = Math.hypot(eye.x - f.x, eye.y - f.y, eye.z - f.z)
    assert.ok(d <= 4.5, `${rel(s)} is ${d.toFixed(2)} from the pillar top`)
  }
})

test('foundation: cobblestone under low ground cells, farthest from the centre first, never under the pillar column', () => {
  const ground = (dx, dz) => (dx === 0 && dz === 0) || (dx === 4 && dz === 2) || (dx === 2 && dz === 2) ? O.oy - 2 : O.oy - 1
  const withFound = bp.tower(O, { ground })
  const f = withFound.filter(s => s.stage === 'foundation')
  assert.strictEqual(f.length, 2, 'two low cells (the centre is never filled)')
  assert.deepStrictEqual(f.map(rel), ['0,-1,0', '4,-1,2'])
  assert.ok(f.every(s => s.block === 'cobblestone' && s.refKind === 'ground' && s.ref.y === O.oy - 2))
  assert.deepStrictEqual(withFound.slice(0, 2), f, 'foundation comes first')
  assert.ok(f.every(s => bp.inBox(O, s)))
})
