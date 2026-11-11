import { useEffect, useMemo, useState } from "react"
import { InfoIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ago, useNow } from "@/useDashboard"
import type { BotId } from "@/types"

type TNode = { id: string; label?: string; parent?: string | null; entry?: boolean; type?: string }
type TEdge = { from: string; to: string; label?: string }
type Tree = {
  placeholder: boolean
  source: string
  mtime: number
  updatedAt?: string
  machine?: string
  nodes: TNode[]
  transitions: TEdge[]
  active: string[]
  history?: { at: string | null; from: string | null; to: string }[]
}

const W = 132, H = 34, GX = 64, GY = 14, MAXROWS = 8, PAD = 12

function layout(nodes: TNode[], edges: TEdge[]) {
  const ids = new Set(nodes.map((n) => n.id))
  const es = edges.filter((e) => ids.has(e.from) && ids.has(e.to))
  const entry = nodes.find((n) => n.entry) ?? nodes[0]
  const level = new Map<string, number>()
  if (entry) {
    level.set(entry.id, 0)
    const q = [entry.id]
    while (q.length) {
      const cur = q.shift()!
      for (const e of es) if (e.from === cur && !level.has(e.to)) { level.set(e.to, level.get(cur)! + 1); q.push(e.to) }
    }
  }
  const maxL = Math.max(0, ...level.values())
  for (const n of nodes) if (!level.has(n.id)) level.set(n.id, maxL + 1) // unreachable states go in a last column
  const byLevel = new Map<number, TNode[]>()
  for (const n of nodes) byLevel.set(level.get(n.id)!, [...(byLevel.get(level.get(n.id)!) ?? []), n])
  const pos = new Map<string, { x: number; y: number }>()
  let col = 0, height = 0
  for (const l of [...byLevel.keys()].sort((a, b) => a - b)) {
    const group = byLevel.get(l)!
    const sub = Math.ceil(group.length / MAXROWS)
    for (let c = 0; c < sub; c++) {
      group.slice(c * MAXROWS, (c + 1) * MAXROWS).forEach((n, r) => {
        pos.set(n.id, { x: PAD + col * (W + GX), y: PAD + r * (H + GY) })
        height = Math.max(height, PAD + (r + 1) * (H + GY))
      })
      col++
    }
  }
  return { pos, es, width: PAD * 2 + col * (W + GX) - GX, height: height + PAD - GY }
}

function Graph({ nodes, edges, active }: { nodes: TNode[]; edges: TEdge[]; active: Set<string> }) {
  const { pos, es, width, height } = useMemo(() => layout(nodes, edges), [nodes, edges])
  const showLabels = nodes.length <= 12
  return (
    <div className="overflow-x-auto rounded-lg border">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full min-w-[32rem]" role="img" aria-label="State graph">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" className="fill-muted-foreground" />
          </marker>
        </defs>
        {es.map((e, i) => {
          const a = pos.get(e.from)!, b = pos.get(e.to)!
          const hot = active.has(e.from) && active.has(e.to)
          const forward = b.x > a.x
          const x1 = forward ? a.x + W : a.x + W / 2, y1 = forward ? a.y + H / 2 : a.y + H
          const x2 = forward ? b.x : b.x + W / 2, y2 = forward ? b.y + H / 2 : b.y + H
          const d = forward
            ? `M${x1} ${y1} C${x1 + GX / 2} ${y1} ${x2 - GX / 2} ${y2} ${x2} ${y2}`
            : `M${x1} ${y1} C${x1} ${y1 + 40} ${x2} ${y2 + 40} ${x2} ${y2}`
          return (
            <g key={i}>
              <path d={d} fill="none" strokeWidth={hot ? 2 : 1} markerEnd="url(#arrow)" className={hot ? "stroke-primary" : "stroke-border"} />
              {showLabels && e.label && (
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} textAnchor="middle" className="fill-muted-foreground text-[9px]">{e.label}</text>
              )}
            </g>
          )
        })}
        {nodes.map((n) => {
          const p = pos.get(n.id)!
          const on = active.has(n.id)
          return (
            <g key={n.id}>
              <rect x={p.x} y={p.y} width={W} height={H} rx={8} strokeWidth={on ? 2 : 1} className={on ? "fill-primary stroke-primary" : "fill-card stroke-border"} />
              <text x={p.x + W / 2} y={p.y + H / 2 + 4} textAnchor="middle" className={`text-[12px] font-medium ${on ? "fill-primary-foreground" : "fill-foreground"}`}>
                {(n.label ?? n.id).slice(0, 18)}
              </text>
              {n.entry && <circle cx={p.x + 8} cy={p.y + 8} r={3} className={on ? "fill-primary-foreground" : "fill-muted-foreground"} />}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export function BehaviorPanel({ id }: { id: BotId }) {
  const now = useNow()
  const [t, setT] = useState<Tree | null>(null)
  const [machine, setMachine] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const load = () => fetch(`/api/behavior/${id}`).then((r) => r.json()).then((d) => live && setT(d)).catch(() => {})
    load()
    const i = setInterval(load, 2000)
    return () => { live = false; clearInterval(i) }
  }, [id])

  const machines = useMemo(() => {
    if (!t) return []
    const labelOf = (m: string) => t.nodes.find((n) => n.id === m)?.label ?? m
    const parents = [...new Set(t.nodes.map((n) => n.parent ?? null))]
    return parents.map((p) => ({ key: p ?? "", label: p === null ? (t.machine ?? "root") : labelOf(p) }))
  }, [t])

  const defaultMachine = useMemo(() => {
    if (!t) return ""
    const leaf = [...t.active].reverse().map((a) => t.nodes.find((n) => n.id === a)).find((n) => n && (n.parent ?? null) !== null)
    return leaf ? (leaf.parent ?? "") : ""
  }, [t])

  if (!t) return <Skeleton className="h-64 w-full" />

  const sel = machine !== null && machines.some((m) => m.key === machine) ? machine : defaultMachine
  const nodes = t.nodes.filter((n) => (n.parent ?? "") === sel)
  const active = new Set(t.active)
  const leafNames = t.active.filter((a) => nodes.some((n) => n.id === a) && !t.nodes.some((n) => n.parent === a))

  return (
    <div className="flex flex-col gap-4">
      {t.placeholder && (
        <Alert>
          <InfoIcon />
          <AlertTitle>Placeholder graph</AlertTitle>
          <AlertDescription>
            The state machine is not exposing its graph yet. This shows the autopilot's plan steps and the step it is on now. It switches to the real graph as soon as brain/state/behavior-tree.json exists.
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Active</span>
        {t.active.length === 0 && <Badge variant="outline">none</Badge>}
        {t.active.map((a, i) => <Badge key={a + i} variant={i === t.active.length - 1 ? "default" : "secondary"}>{t.nodes.find((n) => n.id === a)?.label ?? a}</Badge>)}
        {t.mtime > 0 && <span className="text-xs text-muted-foreground">updated {ago(now - t.mtime)}</span>}
      </div>
      {machines.length > 1 && (
        <ToggleGroup type="single" variant="outline" size="sm" value={sel} onValueChange={(v) => setMachine(v)}>
          {machines.map((m) => <ToggleGroupItem key={m.key} value={m.key}>{m.label}</ToggleGroupItem>)}
        </ToggleGroup>
      )}
      <Graph nodes={nodes} edges={t.transitions} active={active} />
      <Separator />
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Recent transitions</h3>
        {(t.history ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">No transitions recorded yet.</p>
        ) : (
          <div className="flex flex-col font-mono text-xs">
            {[...(t.history ?? [])].reverse().slice(0, 12).map((h, i) => (
              <div key={i} className="grid grid-cols-[4.5rem_1fr] gap-2 py-0.5">
                <span className="text-muted-foreground">{h.at ? new Date(h.at).toLocaleTimeString([], { hour12: false }) : ""}</span>
                <span>{h.from ? `${h.from} → ` : ""}<b>{h.to}</b></span>
              </div>
            ))}
          </div>
        )}
        {leafNames.length === 0 && <p className="text-xs text-muted-foreground">No active state in this machine.</p>}
      </div>
      <p className="text-xs text-muted-foreground">Source: {t.source}</p>
    </div>
  )
}
