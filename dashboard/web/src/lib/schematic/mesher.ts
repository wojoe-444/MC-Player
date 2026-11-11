// A schematic as triangles for the viewer. Pure: no three.js, no DOM (the page turns the arrays into buffers), erasable TypeScript only so a test can load it.
//
//   prepare(model)         once per schematic: the style of every palette entry and the texture atlas
//   build(prep, filter)    every time the slicer, the isolate or a toggle changes: which cells show, and their faces
//
// Cells the filter hides are not dropped: with "ghost hidden blocks" they come out as a faint shell (`ghost`), so the whole build stays readable while a layer or one block
// type is picked out. Faces between two solid cubes are never emitted.
import { makeAtlas, styleOf, type Atlas, type Spec, type Style } from "./appearance.ts"
import { CUBE, isFence, isPane, isWall, shapeOf, type Box, type Shape } from "./shapes.ts"
import type { PaletteEntry } from "./types.ts"

export type Model = { size: number[]; cells: Uint16Array; palette: PaletteEntry[] }
export type Filter = {
  minLayer: number
  maxLayer: number
  /** palette indices to isolate (every other block is hidden), or null */
  isolate: ReadonlySet<number> | null
  scenery: boolean
  ghost: boolean
}
export type MeshData = { positions: Float32Array; uvs: Float32Array; colors: Float32Array; indices: Uint32Array; quadCell: Int32Array }
export type Built = { opaque: MeshData; trans: MeshData; ghost: MeshData; visible: number; total: number }
type Info = { block: string; props: Record<string, string>; style: Style | null; shape: Shape | null; occludes: boolean; drawn: boolean; fixed: boolean }
export type Prepared = { model: Model; atlas: Atlas; info: Info[] }

/** the run-length cells of a schematic as one array (x fastest, then z, then y) */
export function decodeCells(rle: number[], size: number[]): Uint16Array {
  const total = size[0] * size[1] * size[2], out = new Uint16Array(total)
  let p = 0
  for (let i = 0; i < rle.length; i += 2) { out.fill(rle[i], p, p + rle[i + 1]); p += rle[i + 1] }
  if (p !== total) throw new Error(`the cells add up to ${p}, not ${total}`)
  return out
}

export function prepare(model: Model): Prepared {
  const specs: Spec[] = []
  const info: Info[] = model.palette.map((e) => {
    if (e.role === "any" || e.role === "air" || !e.block) return { block: "", props: {}, style: null, shape: null, occludes: false, drawn: false, fixed: true }
    const style = styleOf(e.block), props = e.props || { level: e.level ?? "0" }
    const n = e.block.replace(/^minecraft:/, "")
    const fixed = !(isFence(n) || isWall(n) || isPane(n)) && e.role !== "water" && e.role !== "lava"
    const shape = shapeOf(e.block, props)
    specs.push(style.top, style.side, style.bottom)
    return { block: n, props, style, shape, occludes: shape === CUBE || (shape.kind === "boxes" && !shape.fluid && !style.translucent && shape.boxes.length === 1 && shape.boxes[0].every((v, i) => v === CUBE.boxes[0][i])), drawn: true, fixed }
  })
  return { model, atlas: makeAtlas(specs), info }
}

class Out {
  pos: number[] = []; uv: number[] = []; col: number[] = []; idx: number[] = []; cell: number[] = []
  quad(c: number, p: number[], uvs: number[], shade: number) {
    const base = this.pos.length / 3
    for (let k = 0; k < 4; k++) { this.pos.push(p[k * 3], p[k * 3 + 1], p[k * 3 + 2]); this.uv.push(uvs[k * 2], uvs[k * 2 + 1]); this.col.push(shade, shade, shade) }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    this.cell.push(c)
  }
  done(): MeshData { return { positions: new Float32Array(this.pos), uvs: new Float32Array(this.uv), colors: new Float32Array(this.col), indices: new Uint32Array(this.idx), quadCell: new Int32Array(this.cell) } }
}

// MC-like face shading
const SHADE = { top: 1, bottom: 0.5, ns: 0.8, ew: 0.62 }

export function build(prep: Prepared, f: Filter): Built {
  const { model, atlas, info } = prep
  const [W, H, D] = model.size, cells = model.cells
  const total = W * H * D
  const at = (x: number, y: number, z: number) => x + W * (z + D * y)
  // 0 not there, 1 shown, 2 hidden by the filter (a ghost)
  const vis = new Uint8Array(total)
  let visible = 0, totalBuild = 0
  for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const i = at(x, y, z), p = cells[i], e = model.palette[p]
    if (!e || !info[p].drawn) continue
    if (e.scenery) { if (f.scenery && y >= f.minLayer && y <= f.maxLayer && !f.isolate) vis[i] = 1; continue }
    totalBuild++
    if (y >= f.minLayer && y <= f.maxLayer && (!f.isolate || f.isolate.has(p))) { vis[i] = 1; visible++ } else if (f.ghost) vis[i] = 2
  }
  const opaque = new Out(), trans = new Out(), ghost = new Out()
  const ox = -W / 2, oz = -D / 2
  const shapeCache = new Map<number, Shape>()
  // does a solid cube stand behind a face? A shown face is only hidden by a shown cube; a ghost face by a shown or a ghost one
  const occ = (x: number, y: number, z: number, shown: boolean) => x >= 0 && y >= 0 && z >= 0 && x < W && y < H && z < D && (shown ? vis[at(x, y, z)] === 1 : vis[at(x, y, z)] >= 1) && info[cells[at(x, y, z)]].occludes

  const face = (out: Out, c: number, d: number, b: Box, x: number, y: number, z: number, uvr: [number, number, number, number] | null, tint: number) => {
    const [x0, y0, z0, x1, y1, z1] = b.map((v) => v / 16)
    const X0 = ox + x + x0, X1 = ox + x + x1, Y0 = y + y0, Y1 = y + y1, Z0 = oz + z + z0, Z1 = oz + z + z1
    const [u0, v0, u1, v1] = uvr || [0, 0, 0, 0]
    const U = (u: number) => u0 + u * (u1 - u0), V = (v: number) => v0 + v * (v1 - v0)
    switch (d) {
      case 0: out.quad(c, [X1, Y0, Z1, X1, Y0, Z0, X1, Y1, Z0, X1, Y1, Z1], [U(1 - z0), V(y0), U(1 - z1), V(y0), U(1 - z1), V(y1), U(1 - z0), V(y1)], SHADE.ew * tint); break    // +x
      case 1: out.quad(c, [X0, Y0, Z0, X0, Y0, Z1, X0, Y1, Z1, X0, Y1, Z0], [U(z0), V(y0), U(z1), V(y0), U(z1), V(y1), U(z0), V(y1)], SHADE.ew * tint); break                                              // -x
      case 2: out.quad(c, [X0, Y1, Z1, X1, Y1, Z1, X1, Y1, Z0, X0, Y1, Z0], [U(x0), V(1 - z1), U(x1), V(1 - z1), U(x1), V(1 - z0), U(x0), V(1 - z0)], SHADE.top * tint); break                                  // +y
      case 3: out.quad(c, [X0, Y0, Z0, X1, Y0, Z0, X1, Y0, Z1, X0, Y0, Z1], [U(x0), V(z0), U(x1), V(z0), U(x1), V(z1), U(x0), V(z1)], SHADE.bottom * tint); break                                              // -y
      case 4: out.quad(c, [X0, Y0, Z1, X1, Y0, Z1, X1, Y1, Z1, X0, Y1, Z1], [U(x0), V(y0), U(x1), V(y0), U(x1), V(y1), U(x0), V(y1)], SHADE.ns * tint); break                                                  // +z
      default: out.quad(c, [X1, Y0, Z0, X0, Y0, Z0, X0, Y1, Z0, X1, Y1, Z0], [U(1 - x0), V(y0), U(1 - x1), V(y0), U(1 - x1), V(y1), U(1 - x0), V(y1)], SHADE.ns * tint)                                          // -z
    }
  }
  // the uv rect of a face direction of a style
  const tileOf = (st: Style, d: number): [number, number, number, number] => atlas.uv(d === 2 ? st.top : d === 3 ? st.bottom : st.side)
  const NB = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]

  for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    const i = at(x, y, z), v = vis[i]
    if (!v) continue
    const p = cells[i], inf = info[p], st = inf.style as Style
    // the shape: the same for every cell of a palette entry, except fences, walls and panes (they join their neighbours) and fluids (a column fills its cell)
    let shape: Shape
    if (inf.shape && inf.shape.fluid) {
      const ai = y + 1 < H ? at(x, y + 1, z) : -1
      shape = shapeOf(inf.block, inf.props, undefined, ai >= 0 && info[cells[ai]].block === inf.block)
    } else if (inf.fixed) { shape = shapeCache.get(p) as Shape; if (!shape) { shape = inf.shape as Shape; shapeCache.set(p, shape) } } else {
      const same = (dx: number, dz: number) => {
        const nx = x + dx, nz = z + dz
        if (nx < 0 || nz < 0 || nx >= W || nz >= D) return false
        const o = info[cells[at(nx, y, nz)]]
        if (!o.drawn) return false
        return o.occludes || (isFence(inf.block) && (isFence(o.block) || /_fence_gate$/.test(o.block))) || (isWall(inf.block) && isWall(o.block)) || (isPane(inf.block) && isPane(o.block))
      }
      shape = shapeOf(inf.block, inf.props, same)
    }
    const tint = model.palette[p].scenery ? 0.78 : 1              // the surroundings are a little duller than the build
    const out = v === 2 ? ghost : st.translucent || inf.shape?.fluid ? trans : opaque
    if (shape.kind === "cross") {
      if (v === 2) continue
      const [u0, v0, u1, v1] = atlas.uv(st.side), X0 = ox + x, X1 = ox + x + 1, Z0 = oz + z, Z1 = oz + z + 1
      for (const [a, b] of [[[X0, Z0], [X1, Z1]], [[X1, Z0], [X0, Z1]]]) {
        const q = [a[0], y, a[1], b[0], y, b[1], b[0], y + 1, b[1], a[0], y + 1, a[1]]
        out.quad(i, q, [u0, v0, u1, v0, u1, v1, u0, v1], 0.9 * tint)
        out.quad(i, [q[9], q[10], q[11], q[6], q[7], q[8], q[3], q[4], q[5], q[0], q[1], q[2]], [u0, v1, u1, v1, u1, v0, u0, v0], 0.9 * tint)
      }
      continue
    }
    for (const b of shape.boxes) {
      for (let d = 0; d < 6; d++) {
        // a face flush with the cell's edge is hidden by a solid cube behind it
        const flush = d === 0 ? b[3] === 16 : d === 1 ? b[0] === 0 : d === 2 ? b[4] === 16 : d === 3 ? b[1] === 0 : d === 4 ? b[5] === 16 : b[2] === 0
        if (flush) {
          const [dx, dy, dz] = NB[d], nx = x + dx, ny = y + dy, nz = z + dz
          if (occ(nx, ny, nz, v === 1)) continue
          if (v === 1 && (st.translucent || shape.fluid) && nx >= 0 && ny >= 0 && nz >= 0 && nx < W && ny < H && nz < D) {
            const ni = at(nx, ny, nz)
            if (vis[ni] === 1 && info[cells[ni]].block === inf.block) continue   // water against water, glass against glass
          }
        }
        face(out, i, d, b, x, y, z, v === 2 ? null : tileOf(st, d), tint)
      }
    }
  }
  return { opaque: opaque.done(), trans: trans.done(), ghost: ghost.done(), visible, total: totalBuild }
}
