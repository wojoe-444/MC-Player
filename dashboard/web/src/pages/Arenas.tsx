import { useEffect, useMemo, useRef, useState } from "react"
import { FlaskConicalIcon, SkullIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PageHeader } from "@/components/common"
import { useJson, Stat } from "@/pages/Bases"
import { cn } from "@/lib/utils"

type PerHour = { points: number; deaths: number; stallSeconds: number; stallDaySeconds: number; itemsPickedUp: number; blocksMined: number; itemsCrafted: number; distanceBlocks: number }
type RunSummary = { id: string; arena: string; label: string; startedAt: string; seconds: number; minutes: number; points: number; maxPoints: number; perHour: PerHour; phase: { p1: string; p2: string; p3: string }; totals: { deaths: number; stallPct: number; reconnects: number; deathCauses: string[] }; difficulty: string; code: string; notes: string[] }
type Arena = { id: string; name: string; biome: string | null; note: string; seed: number; size: number; ready: boolean; window: { land: number; trees: number; relief: number; medianY: number } | null; center: number[] | null; spawn: number[] | null; madeAt: string | null; runs: number; bestRun: string | null; bestPointsPerHour: number | null }
type Index = { benchDir: string; exists: boolean; arenas: Arena[]; runs: RunSummary[] }
type Milestone = { t: number | null; done: boolean }
type RunDetail = RunSummary & { milestones: Record<string, Milestone>; pointsAt: Record<string, number>; structures: Record<string, number>; path: [number, number, number][]; events: { t: number; kind: string; pos: number[] }[]; hp: [number, number | null][]; blockDelta: Record<string, number> }
type Preview = { size: number; x0: number; z0: number; palette: [string, string][]; grid: number[]; height: number[]; spawn: number[]; center: number[]; biome: string | null }

const fmtT = (s: number | null) => (s == null ? "n/a" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`)
const biomeName = (b: string | null) => (b ? b.replace("minecraft:", "").replace(/_/g, " ") : "natural")

// the arena from above: surface colour shaded by height, spawn as a ring, the run's path as a line (green to orange with time), deaths as red dots
function ArenaMap({ pv, run }: { pv: Preview; run: RunDetail | null }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const scale = 5
  useEffect(() => {
    const c = ref.current; if (!c) return
    const ctx = c.getContext("2d")!, n = pv.size
    c.width = n * scale; c.height = n * scale
    const hs = pv.height, lo = Math.min(...hs), hi = Math.max(...hs, lo + 1)
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      const o = z * n + x, col = pv.palette[pv.grid[o]][1], shade = 0.72 + 0.4 * ((hs[o] - lo) / (hi - lo))
      const r = parseInt(col.slice(1, 3), 16), g = parseInt(col.slice(3, 5), 16), b = parseInt(col.slice(5, 7), 16)
      ctx.fillStyle = `rgb(${Math.min(255, r * shade) | 0},${Math.min(255, g * shade) | 0},${Math.min(255, b * shade) | 0})`
      ctx.fillRect(x * scale, z * scale, scale, scale)
    }
    const px = (wx: number) => (wx - pv.x0) * scale, pz = (wz: number) => (wz - pv.z0) * scale
    if (run) {
      const maxT = Math.max(1, run.path.length ? run.path[run.path.length - 1][2] : 1)
      ctx.lineWidth = 2
      for (let i = 1; i < run.path.length; i++) {
        const a = run.path[i - 1], b = run.path[i], f = b[2] / maxT
        ctx.strokeStyle = `hsl(${120 - 105 * f},85%,48%)`
        ctx.beginPath(); ctx.moveTo(px(a[0]), pz(a[1])); ctx.lineTo(px(b[0]), pz(b[1])); ctx.stroke()
      }
      for (const e of run.events) { ctx.fillStyle = "#e11d48"; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(px(e.pos[0]), pz(e.pos[1]), 5, 0, 7); ctx.fill(); ctx.stroke() }
    }
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(px(pv.spawn[0] + 0.5), pz(pv.spawn[2] + 0.5), 7, 0, 7); ctx.stroke()
    ctx.strokeStyle = "#111"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(px(pv.spawn[0] + 0.5), pz(pv.spawn[2] + 0.5), 8.5, 0, 7); ctx.stroke()
  }, [pv, run])
  return <canvas ref={ref} className="aspect-square w-full max-w-[640px] rounded-lg border bg-muted [image-rendering:pixelated]" role="img" aria-label={`Top-down map of the ${biomeName(pv.biome)} arena${run ? " with the run's path" : ""}. The white ring is the spawn.`} />
}

function PointsCurve({ run }: { run: RunDetail }) {
  const ms = Object.entries(run.milestones).filter(([, m]) => m.t != null).map(([k, m]) => ({ k, t: m.t as number })).sort((a, b) => a.t - b.t)
  const w = 560, h = 150, T = Math.max(run.seconds, 60), pad = 28
  const maxPts = run.maxPoints
  const pts = PTS
  let acc = 0
  const steps = ms.map((m) => { acc += pts[m.k] ?? 1; return { ...m, acc } })
  const x = (t: number) => pad + (t / T) * (w - pad - 6), y = (v: number) => h - 22 - (v / maxPts) * (h - 36)
  let d = `M${x(0)},${y(0)}`; let last = 0
  for (const s of steps) { d += ` L${x(s.t)},${y(last)} L${x(s.t)},${y(s.acc)}`; last = s.acc }
  d += ` L${x(T)},${y(last)}`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-xl" role="img" aria-label="Points over the run, one step per milestone first seen in the bag">
      {[0, 0.25, 0.5, 0.75, 1].map((f) => <g key={f}><line x1={pad} x2={w - 6} y1={y(maxPts * f)} y2={y(maxPts * f)} stroke="currentColor" opacity={0.12} /><text x={pad - 4} y={y(maxPts * f) + 3} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.6}>{Math.round(maxPts * f)}</text></g>)}
      {[0, 10, 20, 30, 40, 50, 60].filter((m) => m * 60 <= T + 1).map((m) => <text key={m} x={x(m * 60)} y={h - 8} textAnchor="middle" fontSize={9} fill="currentColor" opacity={0.6}>{m}m</text>)}
      <path d={d} fill="none" stroke="var(--color-primary, #4f46e5)" strokeWidth={2} />
      {steps.map((s) => <circle key={s.k} cx={x(s.t)} cy={y(s.acc)} r={2.5} fill="var(--color-primary, #4f46e5)"><title>{`${s.k.replace(/_/g, " ")} at ${fmtT(s.t)}`}</title></circle>)}
    </svg>
  )
}
// same weights as tools/bench/lib/score.js MILESTONES (the page only needs the curve; the run file has the totals)
const PTS: Record<string, number> = { log: 1, crafting_table: 1, wooden_pickaxe: 1, cobblestone: 1, stone_pickaxe: 2, stone_sword: 1, furnace: 2, coal: 1, torch: 1, food: 2, bed: 3, raw_iron: 2, iron_ingot: 3, bucket: 2, iron_pickaxe: 5, shield: 3, chest: 1, diamond: 6 }
const ORDER = Object.keys(PTS)

function RunDetailView({ id }: { id: string }) {
  const { data: r } = useJson<RunDetail>(`/api/arena-runs/${id}`, 60000)
  if (!r) return <p className="text-sm text-muted-foreground">Loading run…</p>
  const done = ORDER.filter((k) => r.milestones[k]?.done)
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Points" value={`${r.points} / ${r.maxPoints}`} hint="milestones reached, weighted (tools/bench/lib/score.js)" />
        <Stat label="Points per hour" value={String(r.perHour.points)} />
        <Stat label="Deaths per hour" value={String(r.perHour.deaths)} hint={r.totals.deathCauses.join("; ") || "no deaths"} />
        <Stat label="Stalled" value={`${r.totals.stallPct}%`} hint="30 s stretches with no movement and nothing new in the bag" />
        <Stat label="Items picked up / h" value={String(r.perHour.itemsPickedUp)} />
        <Stat label="Blocks mined / h" value={String(r.perHour.blocksMined)} />
        <Stat label="Crafted / h" value={String(r.perHour.itemsCrafted)} />
        <Stat label="Distance / h" value={`${r.perHour.distanceBlocks} blocks`} />
      </div>
      <PointsCurve run={r} />
      <div className="flex flex-wrap gap-1.5">
        {ORDER.map((k) => { const m = r.milestones[k]; return <Badge key={k} variant={m?.done ? "success" : "outline"} title={m?.done ? (m.t != null ? `first in the bag at ${fmtT(m.t)}` : "reached (placed or crafted before it was seen in the bag)") : "not reached"}>{k.replace(/_/g, " ")}{m?.done ? ` ${fmtT(m.t)}` : ""}</Badge> })}
      </div>
      {Object.keys(r.structures).length > 0 && <p className="text-sm text-muted-foreground">Blocks the bot added in the arena: {Object.entries(r.structures).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ")}.</p>}
      {r.totals.deathCauses.length > 0 && <p className="flex items-start gap-2 text-sm text-muted-foreground"><SkullIcon className="mt-0.5 size-4 shrink-0" />{r.totals.deathCauses.join("; ")}</p>}
      {r.notes.length > 0 && <p className="text-sm text-warning-foreground">{r.notes.join("; ")}</p>}
      <p className="text-xs text-muted-foreground">{done.length} of {ORDER.length} milestones · {fmtT(r.seconds)} played · difficulty {r.difficulty} · code {r.code}</p>
    </div>
  )
}

export function Arenas() {
  const { data: idx, state } = useJson<Index>("/api/arenas", 15000, (d) => JSON.stringify([d.runs.length, d.arenas.map((a) => a.ready)]))
  const [arenaId, setArenaId] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const arena = useMemo(() => idx?.arenas.find((a) => a.id === (arenaId ?? idx.arenas.find((x) => x.ready)?.id ?? idx.arenas[0]?.id)) ?? null, [idx, arenaId])
  const { data: pv } = useJson<Preview>(arena?.ready ? `/api/arenas/${arena.id}/preview` : null, 600000)
  const runs = useMemo(() => (idx?.runs ?? []).slice().reverse(), [idx])
  const myRuns = runs.filter((r) => r.arena === arena?.id)
  const activeRun = runId && runs.find((r) => r.id === runId && r.arena === arena?.id) ? runId : myRuns[0]?.id ?? null
  const { data: detail } = useJson<RunDetail>(activeRun ? `/api/arena-runs/${activeRun}` : null, 600000)

  return (
    <>
      <PageHeader title="Test arenas" description="Small bounded worlds (128 by 128 blocks, one forced biome) on a vanilla 1.21.6 server. One bot plays the first hour from the same saved snapshot each time; the score comes from the server, per player-hour." />
      {state === "loading" && !idx && <p className="text-sm text-muted-foreground">Loading…</p>}
      {idx && !idx.exists && <Empty><EmptyHeader><EmptyTitle>No bench data yet</EmptyTitle><EmptyDescription>Make an arena and run it: <code>node tools/bench/bench.js make plains-1</code>, then <code>node tools/bench/bench.js run plains-1</code>. Expected folder: {idx.benchDir}</EmptyDescription></EmptyHeader></Empty>}
      {idx && idx.exists && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {idx.arenas.map((a) => (
              <button key={a.id} type="button" onClick={() => { setArenaId(a.id); setRunId(null) }} aria-pressed={arena?.id === a.id} className={cn("rounded-xl border bg-card p-4 text-left transition-colors hover:bg-muted", arena?.id === a.id && "border-primary ring-2 ring-primary/30")}>
                <div className="flex items-center justify-between gap-2"><span className="font-medium">{a.name}</span><Badge variant={a.ready ? "success" : "outline"}>{a.ready ? "ready" : "not made"}</Badge></div>
                <p className="mt-1 text-xs text-muted-foreground">{biomeName(a.biome)} · seed {a.seed}</p>
                <p className="mt-2 text-sm tabular-nums">{a.runs} run{a.runs === 1 ? "" : "s"}{a.bestPointsPerHour != null && <> · best {a.bestPointsPerHour} pts/h</>}</p>
              </button>
            ))}
          </div>
          {arena && (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,640px)_minmax(0,1fr)]">
              <Card>
                <CardHeader><CardTitle className="flex items-center gap-2"><FlaskConicalIcon className="size-4" />{arena.name}</CardTitle><CardDescription>{arena.note}</CardDescription></CardHeader>
                <CardContent className="flex flex-col gap-3">
                  {pv ? <ArenaMap pv={pv} run={detail && detail.arena === arena.id ? detail : null} /> : <p className="text-sm text-muted-foreground">{arena.ready ? "Loading map…" : "This arena has no snapshot yet."}</p>}
                  {arena.window && <p className="text-xs text-muted-foreground">Land {Math.round(arena.window.land * 100)}%, tree cover {(arena.window.trees * 100).toFixed(1)}%, relief {arena.window.relief} blocks, median ground y {arena.window.medianY}. Spawn ring in white; the path runs green to orange over time; red dots are deaths.</p>}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>{activeRun ? activeRun : "No runs yet"}</CardTitle><CardDescription>{activeRun ? "Pick another run below to see it on the map." : "Nothing has been scored in this arena."}</CardDescription></CardHeader>
                <CardContent>{activeRun && <RunDetailView id={activeRun} />}</CardContent>
              </Card>
            </div>
          )}
          <Card>
            <CardHeader><CardTitle>Runs</CardTitle><CardDescription>Newest first. Per-hour numbers are scaled from the minutes played; a short run is a noisy estimate.</CardDescription></CardHeader>
            <CardContent>
              {runs.length === 0 ? <p className="text-sm text-muted-foreground">No runs yet.</p> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Run</TableHead><TableHead>Label</TableHead><TableHead className="text-right">Min</TableHead><TableHead className="text-right">Points</TableHead><TableHead className="text-right">Pts/h</TableHead><TableHead className="text-right">Deaths/h</TableHead><TableHead className="text-right">Stall</TableHead><TableHead>Phases 1/2/3</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {runs.map((r) => (
                      <TableRow key={r.id} className={cn("cursor-pointer", r.id === activeRun && "bg-muted")} onClick={() => { setArenaId(r.arena); setRunId(r.id) }}>
                        <TableCell className="font-mono text-xs">{r.id}</TableCell>
                        <TableCell className="text-sm">{r.label || "-"}</TableCell>
                        <TableCell className="text-right tabular-nums">{Math.round(r.seconds / 60)}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.points}/{r.maxPoints}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{r.perHour.points}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.perHour.deaths}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.totals.stallPct}%</TableCell>
                        <TableCell className="text-sm tabular-nums">{r.phase.p1} · {r.phase.p2} · {r.phase.p3}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  )
}
