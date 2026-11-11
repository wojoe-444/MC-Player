export type CastPart = {
  id: string
  kind: "shaft" | "room" | "mobfarm" | "farm" | "tunnel" | "cave"
  label: string
  by: string | null
  at: number | null
  src: string
  detail: string
  cells: number
}
export type CastMarker = { type: string; x: number; y: number; z: number; label: string }
export type CastData = {
  base: { id: string; name: string; x: number; y: number; z: number; radius: number }
  generatedAt: string
  kinds: string[]
  /** x, y, z, part index, recorded (1) or derived (0), repeated; `cellStride` numbers per cell */
  cells: number[]
  cellStride: number
  parts: CastPart[]
  markers: CastMarker[]
  notes: string[]
  stats: { cells: number; recorded: number; derived: number; digsRecorded: number; placedInBase: number; minY: number | null; maxY: number | null; truncated: boolean }
  schematic?: SchematicInfo
  sources: { registry: boolean; placed: boolean; dugLog: boolean; world: { save: string; savedAt: number; chunks: number; openCells: number } | null }
}
export type BaseSummary = { id: string; name: string; x: number; y: number; z: number; radius: number; source: string }
export type SchematicLegend = { index: number; role: string; label: string; needs: string; cells: number; sources: { block: string; cells: number }[] }
export type SchematicInfo = { id: string; name: string; kind: string; purpose: string; size: number[]; origin: number[]; source: { world?: string; capturedAt?: string; by?: string }; legend: SchematicLegend[] }
export type SchematicSummary = { id: string; name: string; kind: string; purpose: string; size: number[]; origin: number[]; world: string | null; capturedAt: string | null; by: string | null }
