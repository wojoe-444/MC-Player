// Turns the base's cells into a smooth "poured metal" surface. Pure: no three.js, no DOM, so it can run in a test.
//
//   1. the cells go into a grid, each block becoming scale^3 sub-cells with density 1 (scale 3, dropping to 2 and 1 as the base grows)
//   2. a 3-tap box blur per axis (two passes at scale 3) rounds every edge off, so a block-wide shaft becomes a thin rod and a room a rounded blob
//   3. surface nets (naive, one vertex per grid cube that straddles the iso level) pulls the surface out of the density
//   4. each vertex takes the part (shaft, room, ...) of the strongest cell around it, so the page can tint or highlight by part
import type { CastData } from "./types"

export type CastMesh = {
  positions: Float32Array         // world-ish units: one block = 1, centred on the block's middle
  normals: Float32Array
  part: Uint16Array               // per vertex: part index + 1 (0 = none)
  recorded: Uint8Array            // per vertex: 1 when the nearest cell is a recorded dig
  indices: Uint32Array
  min: [number, number, number]   // block bounds of the cells
  max: [number, number, number]
  scale: number
}

const ISO = 0.36
const MAX_SUBCELLS = 7_000_000

export function buildMesh(data: CastData, opts: { scale?: number; passes?: number } = {}): CastMesh | null {
  const st = data.cellStride, n = Math.floor(data.cells.length / st)
  if (!n) return null
  const mn: [number, number, number] = [Infinity, Infinity, Infinity], mx: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { const v = data.cells[i * st + a]; if (v < mn[a]) mn[a] = v; if (v > mx[a]) mx[a] = v }
  const span = [mx[0] - mn[0] + 1, mx[1] - mn[1] + 1, mx[2] - mn[2] + 1]
  const pad = 3
  let scale = opts.scale ?? 3
  const vol = (s: number) => (span[0] * s + 2 * pad) * (span[1] * s + 2 * pad) * (span[2] * s + 2 * pad)
  while (scale > 1 && vol(scale) > MAX_SUBCELLS) scale--
  const passes = opts.passes ?? (scale >= 3 ? 2 : 1)       // a block-wide rod must stay above the iso level after blurring
  const nx = span[0] * scale + 2 * pad, ny = span[1] * scale + 2 * pad, nz = span[2] * scale + 2 * pad
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z)
  let f = new Float32Array(nx * ny * nz)
  const label = new Uint16Array(nx * ny * nz)       // part index + 1
  const rec = new Uint8Array(nx * ny * nz)
  for (let i = 0; i < n; i++) {
    const bx = (data.cells[i * st] - mn[0]) * scale + pad, by = (data.cells[i * st + 1] - mn[1]) * scale + pad, bz = (data.cells[i * st + 2] - mn[2]) * scale + pad
    const p = data.cells[i * st + 3] + 1, r = data.cells[i * st + 4] ? 1 : 0
    for (let dz = 0; dz < scale; dz++) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const k = idx(bx + dx, by + dy, bz + dz); f[k] = 1; label[k] = p; rec[k] = r
    }
  }
  // blur, one axis at a time
  let g = new Float32Array(f.length)
  const axis = (src: Float32Array, dst: Float32Array, stride: number, len: number, outer: (cb: (base: number) => void) => void) => {
    outer((base) => {
      for (let i = 0; i < len; i++) {
        const k = base + i * stride
        const a = i > 0 ? src[k - stride] : 0, c = i < len - 1 ? src[k + stride] : 0
        dst[k] = (a + src[k] + c) / 3
      }
    })
  }
  const overX = (cb: (b: number) => void) => { for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) cb(idx(0, y, z)) }
  const overY = (cb: (b: number) => void) => { for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) cb(idx(x, 0, z)) }
  const overZ = (cb: (b: number) => void) => { for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) cb(idx(x, y, 0)) }
  for (let p = 0; p < passes; p++) {
    axis(f, g, 1, nx, overX); axis(g, f, nx, ny, overY); axis(f, g, nx * ny, nz, overZ); [f, g] = [g, f]
  }

  // surface nets
  const vid = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1)
  const cid = (x: number, y: number, z: number) => x + (nx - 1) * (y + (ny - 1) * z)
  const pos: number[] = [], part: number[] = [], recd: number[] = []
  const CORNER = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]]
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]
  const val = new Float32Array(8)
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    let mask = 0
    for (let c = 0; c < 8; c++) { const v = f[idx(x + CORNER[c][0], y + CORNER[c][1], z + CORNER[c][2])]; val[c] = v; if (v > ISO) mask |= 1 << c }
    if (mask === 0 || mask === 255) continue
    let sx = 0, sy = 0, sz = 0, cnt = 0
    for (const [a, b] of EDGES) {
      const va = val[a], vb = val[b]
      if ((va > ISO) === (vb > ISO)) continue
      const t = (ISO - va) / (vb - va)
      sx += CORNER[a][0] + t * (CORNER[b][0] - CORNER[a][0]); sy += CORNER[a][1] + t * (CORNER[b][1] - CORNER[a][1]); sz += CORNER[a][2] + t * (CORNER[b][2] - CORNER[a][2]); cnt++
    }
    // part: the corner with the highest density that has a label
    let best = -1, bv = 0
    for (let c = 0; c < 8; c++) { const k = idx(x + CORNER[c][0], y + CORNER[c][1], z + CORNER[c][2]); if (label[k] && val[c] > bv) { bv = val[c]; best = k } }
    if (best < 0) {                                         // blur reached past the labelled cells: look one step further
      outer: for (let dz = -1; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy, zz = z + dz
        if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) continue
        const k = idx(xx, yy, zz); if (label[k]) { best = k; break outer }
      }
    }
    vid[cid(x, y, z)] = pos.length / 3
    // grid -> block units: a cell's middle sits at (grid - pad) / scale + min, plus half a block of the centring
    pos.push(((x + sx / cnt - pad + 0.5) / scale + mn[0]) - 0.5, ((y + sy / cnt - pad + 0.5) / scale + mn[1]) - 0.5, ((z + sz / cnt - pad + 0.5) / scale + mn[2]) - 0.5)
    part.push(best >= 0 ? label[best] : 0); recd.push(best >= 0 ? rec[best] : 0)
  }
  const idxs: number[] = []
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return
    if (flip) idxs.push(a, c, b, a, d, c); else idxs.push(a, b, c, a, c, d)
  }
  // one quad per grid edge that crosses the surface, joining the four cubes around it
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const here = f[idx(x, y, z)] > ISO
    if (here !== (f[idx(x + 1, y, z)] > ISO)) quad(vid[cid(x, y - 1, z - 1)], vid[cid(x, y, z - 1)], vid[cid(x, y, z)], vid[cid(x, y - 1, z)], !here)
    if (here !== (f[idx(x, y + 1, z)] > ISO)) quad(vid[cid(x - 1, y, z - 1)], vid[cid(x - 1, y, z)], vid[cid(x, y, z)], vid[cid(x, y, z - 1)], !here)
    if (here !== (f[idx(x, y, z + 1)] > ISO)) quad(vid[cid(x - 1, y - 1, z)], vid[cid(x, y - 1, z)], vid[cid(x, y, z)], vid[cid(x - 1, y, z)], !here)
  }
  const positions = new Float32Array(pos)
  const indices = new Uint32Array(idxs)
  // normals from the faces, smoothed over shared vertices
  const normals = new Float32Array(positions.length)
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2]
    const nxx = uy * vz - uz * vy, nyy = uz * vx - ux * vz, nzz = ux * vy - uy * vx
    for (const o of [a, b, c]) { normals[o] += nxx; normals[o + 1] += nyy; normals[o + 2] += nzz }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1
    normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l
  }
  return { positions, normals, part: Uint16Array.from(part), recorded: Uint8Array.from(recd), indices, min: mn, max: mx, scale }
}
