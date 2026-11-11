// The boxes a block is made of, in 16ths of a block: [x0, y0, z0, x1, y1, z1]. Pure; erasable TypeScript only.
// Stairs, slabs, fences, walls, trapdoors, torches, ladders, hoppers and chests are drawn as what they are; everything else is a cube.
import { isPlant } from "./appearance.ts"

export type Box = [number, number, number, number, number, number]
export type Shape = { kind: "boxes" | "cross"; boxes: Box[]; fluid?: "water" | "lava" }
const FULL: Box = [0, 0, 0, 16, 16, 16]
export const CUBE: Shape = { kind: "boxes", boxes: [FULL] }
const FACING: Record<string, number> = { east: 0, south: 1, west: 2, north: 3 }

/** turn a box a quarter turn about the vertical axis, `r` times: east -> south -> west -> north */
function turn(b: Box, r: number): Box {
  let [x0, , z0, x1, , z1] = b
  const y0 = b[1], y1 = b[4]
  for (let i = 0; i < r; i++) { const nx0 = 16 - z1, nx1 = 16 - z0, nz0 = x0, nz1 = x1; x0 = nx0; x1 = nx1; z0 = nz0; z1 = nz1 }
  return [x0, y0, z0, x1, y1, z1]
}
const flipY = (b: Box): Box => [b[0], 16 - b[4], b[2], b[3], 16 - b[1], b[5]]

export const isFence = (n: string) => /_fence$/.test(n) || n === "nether_brick_fence"
export const isWall = (n: string) => /_wall$/.test(n)
export const isPane = (n: string) => /(_pane|iron_bars)$/.test(n)

/**
 * `connects(dx, dz)`: does the neighbour on that side join a fence, wall or pane (same kind of block, or a full solid cube).
 * `above`: the cell above is the same fluid (a fluid column fills the cell).
 */
export function shapeOf(name: string, props: Record<string, string> = {}, connects: (dx: number, dz: number) => boolean = () => false, above = false): Shape {
  const n = String(name || "").replace(/^minecraft:/, "")
  const p = props || {}
  const r = FACING[p.facing] ?? 0
  if (n === "water" || n === "lava") {
    const lvl = Number(p.level ?? 0), h = above || lvl >= 8 ? 16 : Math.max(2, Math.round(14 - lvl * 1.6))
    return { kind: "boxes", boxes: [[0, 0, 0, 16, h, 16]], fluid: n }
  }
  if (/_slab$/.test(n)) {
    const t = p.type || "bottom"
    return { kind: "boxes", boxes: [t === "double" ? FULL : t === "top" ? [0, 8, 0, 16, 16, 16] : [0, 0, 0, 16, 8, 16]] }
  }
  if (/_stairs$/.test(n)) {
    const shape = p.shape || "straight"
    let up: Box[] = [[8, 8, 0, 16, 16, 16]]
    if (shape === "outer_right") up = [[8, 8, 8, 16, 16, 16]]
    else if (shape === "outer_left") up = [[8, 8, 0, 16, 16, 8]]
    else if (shape === "inner_right") up = [[8, 8, 0, 16, 16, 16], [0, 8, 8, 8, 16, 16]]
    else if (shape === "inner_left") up = [[8, 8, 0, 16, 16, 16], [0, 8, 0, 8, 16, 8]]
    const boxes = ([[0, 0, 0, 16, 8, 16]] as Box[]).concat(up).map((b) => turn(b, r)).map((b) => (p.half === "top" ? flipY(b) : b))
    return { kind: "boxes", boxes }
  }
  if (/_trapdoor$/.test(n)) {
    if (p.open === "true") return { kind: "boxes", boxes: [turn([0, 0, 0, 3, 16, 16], r)] }
    return { kind: "boxes", boxes: [p.half === "top" ? [0, 13, 0, 16, 16, 16] : [0, 0, 0, 16, 3, 16]] }
  }
  if (/_door$/.test(n)) return { kind: "boxes", boxes: [turn([0, 0, 0, 3, 16, 16], r)] }
  if (/_fence_gate$/.test(n)) {
    const ns = p.facing === "east" || p.facing === "west" ? 1 : 0
    return { kind: "boxes", boxes: ([[0, 5, 7, 2, 16, 9], [14, 5, 7, 16, 16, 9], [2, 6, 7, 14, 9, 9], [2, 12, 7, 14, 15, 9]] as Box[]).map((b) => turn(b, ns)) }
  }
  if (isFence(n)) {
    const b: Box[] = [[6, 0, 6, 10, 16, 10]]
    if (connects(0, -1)) b.push([7, 6, 0, 9, 9, 6], [7, 12, 0, 9, 15, 6])
    if (connects(0, 1)) b.push([7, 6, 10, 9, 9, 16], [7, 12, 10, 9, 15, 16])
    if (connects(1, 0)) b.push([10, 6, 7, 16, 9, 9], [10, 12, 7, 16, 15, 9])
    if (connects(-1, 0)) b.push([0, 6, 7, 6, 9, 9], [0, 12, 7, 6, 15, 9])
    return { kind: "boxes", boxes: b }
  }
  if (isWall(n)) {
    const b: Box[] = [[4, 0, 4, 12, 16, 12]]
    if (connects(0, -1)) b.push([5, 0, 0, 11, 14, 5])
    if (connects(0, 1)) b.push([5, 0, 11, 11, 14, 16])
    if (connects(1, 0)) b.push([11, 0, 5, 16, 14, 11])
    if (connects(-1, 0)) b.push([0, 0, 5, 5, 14, 11])
    return { kind: "boxes", boxes: b }
  }
  if (isPane(n)) {
    const b: Box[] = [[7, 0, 7, 9, 16, 9]]
    if (connects(0, -1)) b.push([7, 0, 0, 9, 16, 7])
    if (connects(0, 1)) b.push([7, 0, 9, 9, 16, 16])
    if (connects(1, 0)) b.push([9, 0, 7, 16, 16, 9])
    if (connects(-1, 0)) b.push([0, 0, 7, 7, 16, 9])
    return { kind: "boxes", boxes: b }
  }
  if (n === "torch" || n === "soul_torch") return { kind: "boxes", boxes: [[7, 0, 7, 9, 10, 9]] }
  if (n === "wall_torch" || n === "soul_wall_torch") return { kind: "boxes", boxes: [turn([1, 4, 7, 3, 14, 9], r)] }
  if (n === "ladder") return { kind: "boxes", boxes: [turn([0, 0, 0, 1, 16, 16], r)] }
  if (n === "hopper") return { kind: "boxes", boxes: [[0, 10, 0, 16, 16, 16], [4, 4, 4, 12, 10, 12], [6, 0, 6, 10, 4, 10]] }
  if (n === "chest" || n === "trapped_chest") {
    const b: Box = [1, 0, 1, 15, 14, 15], t = p.type
    if (t === "left" || t === "right") {
      // the partner sits to the viewer's right (left half) or left (right half); south: +x, north: -x, east: -z, west: +z
      const right = ({ south: [1, 0], north: [-1, 0], east: [0, -1], west: [0, 1] } as Record<string, number[]>)[p.facing || "south"] || [1, 0]
      const d = t === "left" ? right : [-right[0], -right[1]]
      if (d[0] > 0) b[3] = 16; else if (d[0] < 0) b[0] = 0
      if (d[1] > 0) b[5] = 16; else if (d[1] < 0) b[2] = 0
    }
    return { kind: "boxes", boxes: [b] }
  }
  if (/_carpet$/.test(n)) return { kind: "boxes", boxes: [[0, 0, 0, 16, 1, 16]] }
  if (/_bed$/.test(n)) return { kind: "boxes", boxes: [[0, 3, 0, 16, 9, 16]] }
  if (isPlant(n)) return { kind: "cross", boxes: [FULL] }
  return CUBE
}
