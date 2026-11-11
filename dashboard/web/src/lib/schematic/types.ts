// The Schematics page's data: what /api/schematics/:id returns (dashboard/schematiccast.js).
export type PaletteEntry = {
  role: "any" | "air" | "solid" | "block" | "water" | "lava"
  /** the specific block this cell shows (not on `any` and `air`) */
  block?: string
  props?: Record<string, string>
  level?: string
  /** other blocks accepted in its place (role block) */
  alt?: string[]
  /** the natural world around the build, drawn for the picture, never checked */
  scenery?: boolean
}
export type BomRow = { key: string; block: string; name: string; cells: number; indices: number[]; role: string; subs: string | null; fluid: boolean }
export type RawLine = { id: string; label: string; verb: string; amount: number; stacks: number }
export type SchematicSummary = { id: string; name: string; kind: string; category: string; tags: string[]; mode: string; purpose: string; size: number[]; origin: number[]; world: string | null; capturedAt: string | null; by: string | null }
export type SchematicDetail = SchematicSummary & {
  v: number
  source: { world?: string; capturedAt?: string; by?: string }
  notes: string[]
  palette: PaletteEntry[]
  /** run-length cells: index, run, index, run ...; x fastest, then z, then y */
  rle: number[]
  counts: Record<string, number>
  bom: BomRow[]
  raw: { lines: RawLine[]; other: { name: string; amount: number }[]; note: string }
}
