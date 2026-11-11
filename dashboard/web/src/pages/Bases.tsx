import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CameraIcon, GemIcon, Loader2Icon, MountainSnowIcon, RotateCwIcon, ScanIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Toggle } from "@/components/ui/toggle"
import { PageHeader } from "@/components/common"
import { CastView, type CastColor, type CastViewHandle } from "@/components/CastView"
import type { BaseSummary, CastData, CastPart } from "@/lib/cast/types"
import { cn } from "@/lib/utils"

export function useJson<T>(url: string | null, everyMs: number, sig?: (d: T) => string) {
  const [data, setData] = useState<T | null>(null)
  const [state, setState] = useState<"loading" | "ok" | "failed" | "missing">("loading")
  useEffect(() => {
    if (!url) return
    let live = true
    setState("loading"); setData(null)
    const load = () => fetch(url).then(async (r) => {
      if (r.status === 404) { if (live) setState("missing"); return }
      const d = (await r.json()) as T
      if (live) { setData((old) => (old && sig && sig(old) === sig(d) ? old : d)); setState("ok") }
    }).catch(() => live && setState("failed"))
    load()
    const t = setInterval(load, everyMs)
    return () => { live = false; clearInterval(t) }
  }, [url, everyMs]) // eslint-disable-line react-hooks/exhaustive-deps
  return { data, state }
}

export const KIND_DOT: Record<CastPart["kind"], string> = { shaft: "#d9d9d9", room: "#e8b04a", mobfarm: "#d9625b", farm: "#79b86a", tunnel: "#6fa8dc", cave: "#8d96a0" }

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5" title={hint}>
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
    </div>
  )
}

export function PartRow({ p, active, onPick, tinted }: { p: CastPart; active: boolean; onPick: () => void; tinted: boolean }) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={cn("flex w-full items-start gap-3 rounded-lg border border-transparent px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted", active && "border-border bg-muted")}
    >
      <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: tinted ? KIND_DOT[p.kind] : "#cfd3d8" }} aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate font-medium">{p.label}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{p.cells.toLocaleString()} blocks</span>
        </span>
        <span className="truncate text-xs text-muted-foreground">{[p.detail, p.by].filter(Boolean).join(" · ")}</span>
      </span>
    </button>
  )
}

// the same cast again (the page polls) must not rebuild the mesh
const castSig = (d: CastData) => `${d.stats.cells}:${d.stats.recorded}:${d.stats.digsRecorded}:${d.markers.length}:${d.parts.map((p) => p.id + p.cells).join(",")}`

export function CastLoading() {
  return (
    <Card className="overflow-hidden py-0" role="status" aria-live="polite">
      <div className="dark flex h-[34rem] flex-col items-center justify-center gap-3 bg-zinc-950 text-zinc-400 xl:h-[40rem]">
        <Loader2Icon className="size-8 animate-spin" />
        <div className="text-sm text-zinc-200">Reading the base from the world save…</div>
        <div className="max-w-xs text-center text-xs">The first load takes a few seconds, then the metal is cast in your browser.</div>
      </div>
    </Card>
  )
}

function CastBody({ base }: { base: BaseSummary }) {
  const { data, state } = useJson<CastData>(`/api/bases/${encodeURIComponent(base.id)}`, 60_000, castSig)
  const [color, setColor] = useState<CastColor>("metal")
  const [selected, setSelected] = useState<string | null>(null)
  const [markers, setMarkers] = useState(true)
  const [caves, setCaves] = useState(true)
  const [spin, setSpin] = useState(true)
  const view = useRef<CastViewHandle>(null)
  const shot = useCallback(() => {
    const url = view.current?.screenshot()
    if (!url) return
    const a = document.createElement("a"); a.href = url; a.download = `${base.name.toLowerCase().replace(/\W+/g, "-")}-cast.png`; a.click()
  }, [base.name])

  // "Natural caves" off: the cast without the untouched caves joined to the base (part indices stay the same)
  const shown = useMemo(() => {
    if (!data || caves) return data
    const st = data.cellStride, drop = new Set(data.parts.map((p, i) => (p.kind === "cave" ? i : -1)).filter((i) => i >= 0)), cells: number[] = []
    for (let i = 0; i < data.cells.length; i += st) if (!drop.has(data.cells[i + 3])) for (let k = 0; k < st; k++) cells.push(data.cells[i + k])
    return { ...data, cells }
  }, [data, caves])
  if (state === "failed") return <Empty><EmptyHeader><EmptyTitle>Could not load the base</EmptyTitle><EmptyDescription>The dashboard server did not answer. It will keep trying.</EmptyDescription></EmptyHeader></Empty>
  if (state === "missing") return <Empty><EmptyHeader><EmptyTitle>No such base</EmptyTitle><EmptyDescription>The base list changed; pick another one.</EmptyDescription></EmptyHeader></Empty>
  if (!data || !shown) return <CastLoading />
  const s = data.stats
  const empty = s.cells === 0
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <Card className="self-start overflow-hidden py-0">
        <div className="dark relative h-[34rem] bg-zinc-950 text-foreground xl:h-[40rem]">
          {empty
            ? <div className="flex h-full items-center justify-center p-8 text-center text-sm text-zinc-400">Nothing recorded under this base yet.</div>
            : <CastView ref={view} data={shown} color={color} selected={selected} showMarkers={markers} spin={spin} className="absolute inset-0" />}
          <div className="absolute top-3 left-3 flex flex-wrap items-center gap-2">
            <ToggleGroup type="single" value={color} onValueChange={(v) => v && setColor(v as CastColor)} variant="outline" size="sm" className="bg-zinc-950/70 backdrop-blur">
              <ToggleGroupItem value="metal">Metal</ToggleGroupItem>
              <ToggleGroupItem value="parts">By part</ToggleGroupItem>
              <ToggleGroupItem value="digs">Recorded digs</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="absolute top-3 right-3 flex items-center gap-1.5">
            {data.parts.some((p) => p.kind === "cave") && <Toggle variant="outline" size="sm" pressed={caves} onPressedChange={setCaves} aria-label="Show natural caves joined to the base" className="bg-zinc-950/70 backdrop-blur"><MountainSnowIcon />Caves</Toggle>}
            <Toggle variant="outline" size="sm" pressed={markers} onPressedChange={setMarkers} aria-label="Show chests and workstations" className="bg-zinc-950/70 backdrop-blur"><GemIcon />Things</Toggle>
            <Toggle variant="outline" size="sm" pressed={spin} onPressedChange={setSpin} aria-label="Turn slowly" className="bg-zinc-950/70 backdrop-blur"><RotateCwIcon />Turn</Toggle>
            <Button variant="outline" size="icon-sm" onClick={() => view.current?.resetView()} aria-label="Reset the view" className="bg-zinc-950/70 backdrop-blur"><ScanIcon /></Button>
            <Button variant="outline" size="icon-sm" onClick={shot} aria-label="Save a picture" className="bg-zinc-950/70 backdrop-blur"><CameraIcon /></Button>
          </div>
          <div className="pointer-events-none absolute bottom-3 left-3 text-xs text-zinc-400">Drag to turn, scroll to zoom, right-drag to move.</div>
        </div>
      </Card>

      <div className="flex flex-col gap-6">
        <Card size="sm">
          <CardHeader>
            <CardTitle>{data.base.name}</CardTitle>
            <CardDescription>{data.base.x}, {data.base.y}, {data.base.z} · everything within {data.base.radius} blocks</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <Stat label="Blocks of space" value={s.cells.toLocaleString()} hint="Cells the cast is made of" />
            <Stat label="Depth" value={s.minY != null && s.maxY != null ? `${s.maxY - s.minY + 1}` : "–"} hint={s.minY != null ? `y ${s.minY} to ${s.maxY}` : undefined} />
            <Stat label="Recorded digs" value={s.digsRecorded.toLocaleString()} hint="Blocks a bot was seen digging in this base since the dug-block log started" />
            <Stat label="Placed blocks" value={s.placedInBase.toLocaleString()} hint="Blocks the players placed here and have not removed" />
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>What is in the cast</CardTitle>
            <CardDescription>Click a part to pick it out.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {data.parts.length === 0 && <p className="text-sm text-muted-foreground">No parts recorded.</p>}
            {data.parts.map((p) => <PartRow key={p.id} p={p} active={selected === p.id} tinted={color === "parts"} onPick={() => setSelected(selected === p.id ? null : p.id)} />)}
            {data.markers.length > 0 && <p className="px-2.5 pt-2 text-xs text-muted-foreground">{data.markers.length} chests and workstations shown as gold marks.</p>}
          </CardContent>
        </Card>

        {data.notes.length > 0 && (
          <Card size="sm">
            <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
              {data.notes.map((n) => <p key={n}>{n}</p>)}
              <p className="flex items-center gap-2 text-xs"><Badge variant="secondary">from records</Badge>The cast uses only what the bots recorded; nothing is read through walls.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

export function Bases() {
  const { data, state } = useJson<{ bases: BaseSummary[] }>("/api/bases", 60_000)
  const [pick, setPick] = useState<string | null>(null)
  const bases = data?.bases ?? []
  const current = bases.find((b) => b.id === pick) ?? bases[0] ?? null
  return (
    <>
      <PageHeader title="Bases" description="A base as a metal cast: the space the bots dug and built, with the solid world taken away, like casting metal into an ant colony. A base is a waypoint.">
        {bases.length > 0 && (
          <Select value={current?.id} onValueChange={setPick}>
            <SelectTrigger className="w-56" aria-label="Choose a base"><SelectValue placeholder="Choose a base" /></SelectTrigger>
            <SelectContent>{bases.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
          </Select>
        )}
      </PageHeader>
      {state === "loading" && <CastLoading />}
      {state === "failed" && <Empty><EmptyHeader><EmptyTitle>Could not load the bases</EmptyTitle><EmptyDescription>The dashboard server did not answer. It will keep trying.</EmptyDescription></EmptyHeader></Empty>}
      {state === "ok" && !current && <Empty><EmptyHeader><EmptyTitle>No bases recorded yet</EmptyTitle><EmptyDescription>A base is a waypoint named in brain/bases/config.json. The bot records it, and what it digs there, once it runs with the bases module.</EmptyDescription></EmptyHeader></Empty>}
      {current && <CastBody key={current.id} base={current} />}
    </>
  )
}
