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
export type VariantInfo = { id: string; name: string; description: string; size: number[]; mode: string }
export type SchematicSummary = { variants: VariantInfo[]; defaultVariant: string; id: string; name: string; kind: string; category: string; tags: string[]; mode: string; purpose: string; size: number[]; origin: number[]; world: string | null; capturedAt: string | null; by: string | null }
export type SchematicDetail = SchematicSummary & {
  v: number
  /** the variant these cells are (a schematic with one build has the variant Main) */
  variant: string
  variantName: string
  variantDescription: string
  source: { world?: string; capturedAt?: string; by?: string }
  notes: string[]
  palette: PaletteEntry[]
  /** run-length cells: index, run, index, run ...; x fastest, then z, then y */
  rle: number[]
  counts: Record<string, number>
  bom: BomRow[]
  raw: { lines: RawLine[]; other: { name: string; amount: number }[]; note: string }
}

/** The schematic agent (dashboard/schematicagent.js, /api/schematic-agent) */
export type AgentRequest = {
  id: string; createdAt: string; startedAt?: string; finishedAt?: string; source: "user" | "bot"; by: string; prompt: string
  kind: "new" | "edit" | "variant"; target: { id: string; variant: string | null } | null; model: string; effort: string
  status: "queued" | "running" | "cancelling" | "done" | "failed" | "cancelled"; error?: string; costUsd?: number; calls: number; lastCall: { tool: string } | null
  result?: { schematicId: string; variantId: string; name: string; size: number[]; cells: number; summary?: string; issues?: string[] }
}
export type AgentInfo = {
  available: boolean; unavailableWhy: string | null; running: string | null
  models: { id: string; label: string }[]; efforts: string[]; defaults: { model: string; effort: string }
  config: { botDailyCap: number; botMaxPending: number; botModel: string; botEffort: string }
  quota: { date: string; used: number; cap: number; remaining: number; byBot: Record<string, number> }
  requests: AgentRequest[]
}
