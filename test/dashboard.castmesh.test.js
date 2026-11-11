// dashboard/web/src/lib/cast/mesh.ts: the smooth surface of the cast. Plain TypeScript with erasable types only, so node loads it as is.
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { pathToFileURL } = require('url')
const MESH = pathToFileURL(path.join(__dirname, '..', 'dashboard', 'web', 'src', 'lib', 'cast', 'mesh.ts')).href

const room = (cells, x0, x1, y0, y1, z0, z1, part) => { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) cells.push(x, y, z, part, 0) }

test('a room and a one-block shaft make one closed, outward-facing surface; thin rods do not vanish', async () => {
  const { buildMesh } = await import(MESH)
  const cells = []
  room(cells, 0, 4, 0, 3, 0, 3, 0)
  for (let y = 4; y < 30; y++) cells.push(2, y, 2, 1, 1)
  const m = buildMesh({ cells, cellStride: 5 })
  assert.ok(m && m.positions.length > 0)
  assert.deepStrictEqual(m.min, [0, 0, 0]); assert.deepStrictEqual(m.max, [4, 29, 3])
  // the rod reaches the top: vertices up near y 29
  let top = -Infinity; for (let i = 1; i < m.positions.length; i += 3) top = Math.max(top, m.positions[i])
  assert.ok(top > 28, 'the shaft is drawn all the way up, got ' + top)
  // closed: every edge shared by exactly two triangles (vertices at a tile seam are duplicated, so weld by position first)
  const weld = new Map(), W = (i) => { const k = [0, 1, 2].map(a => Math.round(m.positions[i * 3 + a] * 1e3)).join(','); if (!weld.has(k)) weld.set(k, weld.size); return weld.get(k) }
  const edges = new Map()
  for (let i = 0; i < m.indices.length; i += 3) for (const [u, v] of [[0, 1], [1, 2], [2, 0]]) {
    const a = W(m.indices[i + u]), b = W(m.indices[i + v]), k = a < b ? a + '_' + b : b + '_' + a
    edges.set(k, (edges.get(k) || 0) + 1)
  }
  assert.strictEqual([...edges.values()].filter(n => n !== 2).length, 0)
  // outward: the signed volume is positive
  const P = m.positions; let vol = 0
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = m.indices[i] * 3, b = m.indices[i + 1] * 3, c = m.indices[i + 2] * 3
    vol += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6
  }
  assert.ok(vol > 60 && vol < 400, 'volume ' + vol)
  // normals point out of the metal: on the roof of the room (away from the shaft) they point up
  let sum = 0, cnt = 0
  for (let i = 0; i < m.positions.length / 3; i++) { const x = m.positions[i * 3], y = m.positions[i * 3 + 1]; if (y > 3.2 && y < 3.8 && Math.abs(x - 2) > 1.4) { sum += m.normals[i * 3 + 1]; cnt++ } }
  assert.ok(cnt > 0 && sum / cnt > 0.5, `roof normals: mean y ${sum / cnt} over ${cnt}`)
  // parts and recorded flags travel to the vertices: both parts are present
  assert.ok(m.part.includes(1) && m.part.includes(2))
  assert.ok(m.recorded.includes(1) && m.recorded.includes(0))
})

test('nothing in, nothing out; one cell is still a small blob; far-apart cells cost tiles, not one grid over the whole box', async () => {
  const { buildMesh } = await import(MESH)
  assert.strictEqual(buildMesh({ cells: [], cellStride: 5 }), null)
  const one = buildMesh({ cells: [10, 10, 10, 0, 0], cellStride: 5 })
  assert.ok(one.positions.length > 0 && one.scale === 3)
  const t0 = Date.now()
  const far = buildMesh({ cells: [0, 0, 0, 0, 0, 400, 150, 400, 0, 0], cellStride: 5 })      // a 400 x 150 x 400 box with two blocks in it
  assert.ok(far.scale === 3 && far.positions.length > 0 && far.positions.length < one.positions.length * 3 * 2.2)
  assert.ok(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0) + ' ms')
})
