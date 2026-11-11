// Turns the base's cells into a smooth "poured metal" surface. Pure: no three.js, no DOM, so it can run in a test.
//
//   1. the cells are bucketed into tiles of TILE blocks (with a HALO of neighbouring blocks around each), so a base with a hundred blocks of cave
//      costs memory per tile instead of one grid over the whole bounding box
//   2. per tile, each block becomes scale^3 sub-cells of density 1, and a 3-tap box blur per axis (two passes at scale 3) rounds every edge off:
//      a block-wide shaft becomes a thin rod, a room a rounded blob
//   3. surface nets (one vertex per grid cube that straddles the iso level) pulls the surface out of the density; a tile emits only the quads whose
//      edge lies inside its own TILE, so neighbouring tiles meet without overlap or gap (the halo makes the density at the seam identical)
//   4. normals come from the density gradient (not from the faces), so they agree across tile seams; each vertex takes the part (shaft, room, ...)
//      of the strongest cell around it, so the page can tint or highlight by part
import type { CastData } from "./types"

export type CastMesh = {
  positions: Float32Array         // block units, a block's centre at its integer coordinates
  normals: Float32Array
  part: Uint16Array               // per vertex: part index + 1 (0 = none)
  recorded: Uint8Array            // per vertex: 1 when the nearest cell is a recorded dig
  indices: Uint32Array
  min: [number, number, number]   // block bounds of the cells
  max: [number, number, number]
  scale: number
}

const ISO = 0.36
const TILE = 24
const HALO = 2
const CORNER = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]]
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]

export function buildMesh(data: CastData, opts: { scale?: number; passes?: number } = {}): CastMesh | null {
  const st = data.cellStride, n = Math.floor(data.cells.length / st)
  if (!n) return null
  const mn: [number, number, number] = [Infinity, Infinity, Infinity], mx: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const v = data.cells[i * st + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v }
  const scale = opts.scale ?? (n > 20000 ? 2 : 3)               // a cave-sized cast would be a million triangles at 3
  const passes = opts.passes ?? (scale >= 3 ? 2 : 1)       // a block-wide rod must stay above the iso level after blurring

  // bucket the cells into tiles; a cell also goes to the neighbouring tiles whose halo it falls in
  const tiles = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    const c = [data.cells[i * st], data.cells[i * st + 1], data.cells[i * st + 2]]
    const r = c.map((v, a) => [Math.floor((v - HALO - mn[a]) / TILE), Math.floor((v + HALO - mn[a]) / TILE)])
    for (let tz = r[2][0]; tz <= r[2][1]; tz++) for (let ty = r[1][0]; ty <= r[1][1]; ty++) for (let tx = r[0][0]; tx <= r[0][1]; tx++) {
      const k = tx + "," + ty + "," + tz
      let a = tiles.get(k); if (!a) tiles.set(k, a = [])
      a.push(i)
    }
  }
  const pos: number[] = [], nor: number[] = [], part: number[] = [], recd: number[] = [], idxs: number[] = []
  const span = (TILE + 2 * HALO) * scale
  const N = span
  const f0 = new Float32Array(N * N * N), f1 = new Float32Array(N * N * N)
  const label = new Uint16Array(N * N * N), rec = new Uint8Array(N * N * N)
  const idx = (x: number, y: number, z: number) => x + N * (y + N * z)
  const vid = new Int32Array((N - 1) ** 3)
  const cid = (x: number, y: number, z: number) => x + (N - 1) * (y + (N - 1) * z)
  const val = new Float32Array(8)

  for (const [key, list] of tiles) {
    const [tx, ty, tz] = key.split(",").map(Number)
    const ox = mn[0] + tx * TILE - HALO, oy = mn[1] + ty * TILE - HALO, oz = mn[2] + tz * TILE - HALO     // block coordinate of grid block 0
    let f = f0, g = f1
    f.fill(0); label.fill(0); rec.fill(0)
    for (const i of list) {
      const bx = (data.cells[i * st] - ox) * scale, by = (data.cells[i * st + 1] - oy) * scale, bz = (data.cells[i * st + 2] - oz) * scale
      const p = data.cells[i * st + 3] + 1, r = data.cells[i * st + 4] ? 1 : 0
      for (let dz = 0; dz < scale; dz++) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const k = idx(bx + dx, by + dy, bz + dz); f[k] = 1; label[k] = p; rec[k] = r
      }
    }
    for (let p = 0; p < passes; p++) {
      for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) { const b = idx(0, y, z); for (let x = 0; x < N; x++) g[b + x] = ((x > 0 ? f[b + x - 1] : 0) + f[b + x] + (x < N - 1 ? f[b + x + 1] : 0)) / 3 }
      for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) { const b = idx(x, 0, z); for (let y = 0; y < N; y++) { const k = b + y * N; f[k] = ((y > 0 ? g[k - N] : 0) + g[k] + (y < N - 1 ? g[k + N] : 0)) / 3 } }
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const b = idx(x, y, 0); for (let z = 0; z < N; z++) { const k = b + z * N * N; g[k] = ((z > 0 ? f[k - N * N] : 0) + f[k] + (z < N - 1 ? f[k + N * N] : 0)) / 3 } }
      ;[f, g] = [g, f]
    }
    vid.fill(-1)
    const lo = HALO * scale, hi = (HALO + TILE) * scale                          // this tile's own range of grid points: [lo, hi)
    const vertex = (x: number, y: number, z: number): number => {
      const c = cid(x, y, z)
      if (vid[c] >= 0) return vid[c]
      let sx = 0, sy = 0, sz = 0, cnt = 0
      for (let ci = 0; ci < 8; ci++) val[ci] = f[idx(x + CORNER[ci][0], y + CORNER[ci][1], z + CORNER[ci][2])]
      for (const [a, b] of EDGES) {
        const va = val[a], vb = val[b]
        if ((va > ISO) === (vb > ISO)) continue
        const t = (ISO - va) / (vb - va)
        sx += CORNER[a][0] + t * (CORNER[b][0] - CORNER[a][0]); sy += CORNER[a][1] + t * (CORNER[b][1] - CORNER[a][1]); sz += CORNER[a][2] + t * (CORNER[b][2] - CORNER[a][2]); cnt++
      }
      let best = -1, bv = 0
      for (let ci = 0; ci < 8; ci++) { const k = idx(x + CORNER[ci][0], y + CORNER[ci][1], z + CORNER[ci][2]); if (label[k] && val[ci] > bv) { bv = val[ci]; best = k } }
      if (best < 0) {                                       // the blur reached past the labelled cells: look a step further
        outer: for (let dz = -1; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy, zz = z + dz
          if (xx < 0 || yy < 0 || zz < 0 || xx >= N || yy >= N || zz >= N) continue
          const k = idx(xx, yy, zz); if (label[k]) { best = k; break outer }
        }
      }
      // gradient of the trilinear field at the cube's middle; the normal points towards lower density (out of the metal)
      const gx = (val[1] + val[3] + val[5] + val[7] - val[0] - val[2] - val[4] - val[6]) / 4
      const gy = (val[2] + val[3] + val[6] + val[7] - val[0] - val[1] - val[4] - val[5]) / 4
      const gz = (val[4] + val[5] + val[6] + val[7] - val[0] - val[1] - val[2] - val[3]) / 4
      const l = Math.hypot(gx, gy, gz) || 1
      const id = pos.length / 3
      vid[c] = id
      pos.push(ox - 0.5 + (x + sx / cnt + 0.5) / scale, oy - 0.5 + (y + sy / cnt + 0.5) / scale, oz - 0.5 + (z + sz / cnt + 0.5) / scale)
      nor.push(-gx / l, -gy / l, -gz / l)
      part.push(best >= 0 ? label[best] : 0); recd.push(best >= 0 ? rec[best] : 0)
      return id
    }
    const quad = (a: number, b: number, c: number, d: number, flip: boolean) => { if (flip) idxs.push(a, c, b, a, d, c); else idxs.push(a, b, c, a, c, d) }
    // one quad per grid edge that crosses the surface and starts in this tile, joining the four cubes around it
    for (let z = lo; z < hi; z++) for (let y = lo; y < hi; y++) for (let x = lo; x < hi; x++) {
      const here = f[idx(x, y, z)] > ISO
      if (here !== (f[idx(x + 1, y, z)] > ISO)) quad(vertex(x, y - 1, z - 1), vertex(x, y, z - 1), vertex(x, y, z), vertex(x, y - 1, z), !here)
      if (here !== (f[idx(x, y + 1, z)] > ISO)) quad(vertex(x - 1, y, z - 1), vertex(x - 1, y, z), vertex(x, y, z), vertex(x, y, z - 1), !here)
      if (here !== (f[idx(x, y, z + 1)] > ISO)) quad(vertex(x - 1, y - 1, z), vertex(x, y - 1, z), vertex(x, y, z), vertex(x - 1, y, z), !here)
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), part: Uint16Array.from(part), recorded: Uint8Array.from(recd), indices: Uint32Array.from(idxs), min: mn, max: mx, scale }
}
