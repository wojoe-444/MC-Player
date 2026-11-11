import { useCallback, useMemo, useRef, useState } from "react"
import { CameraIcon, GemIcon, RotateCwIcon, ScanIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Toggle } from "@/components/ui/toggle"
import { PageHeader } from "@/components/common"
import { CastView, type CastColor, type CastViewHandle } from "@/components/CastView"
import { CastLoading, PartRow, Stat, useJson } from "@/pages/Bases"
import type { CastData, SchematicSummary } from "@/lib/cast/types"

const sig = (d: CastData) => `${d.stats.cells}:${d.markers.length}:${d.parts.map((p) => p.id + p.cells).join(",")}`

function Body({ item }: { item: SchematicSummary }) {
  const { data, state } = useJson<CastData>(`/api/schematics/${encodeURIComponent(item.id)}`, 120_000, sig)
  const [color, setColor] = useState<CastColor>("parts")
  const [selected, setSelected] = useState<string | null>(null)
  const [markers, setMarkers] = useState(true)
  const [spin, setSpin] = useState(true)
  const view = useRef<CastViewHandle>(null)
  const shot = useCallback(() => {
    const url = view.current?.screenshot(); if (!url) return
    const a = document.createElement("a"); a.href = url; a.download = `${item.id}-schematic.png`; a.click()
  }, [item.id])
  const info = data?.schematic
  const roles = useMemo(() => (info ? info.legend.filter((l) => l.role === "solid") : []), [info])
  if (state === "failed") return <Empty><EmptyHeader><EmptyTitle>Could not load the schematic</EmptyTitle><EmptyDescription>The dashboard server did not answer. It will keep trying.</EmptyDescription></EmptyHeader></Empty>
  if (state === "missing") return <Empty><EmptyHeader><EmptyTitle>No such schematic</EmptyTitle><EmptyDescription>The list changed; pick another one.</EmptyDescription></EmptyHeader></Empty>
  if (!data || !info) return <CastLoading />
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <Card className="self-start overflow-hidden py-0">
        <div className="dark relative h-[34rem] bg-zinc-950 text-foreground xl:h-[40rem]">
          <CastView ref={view} data={data} color={color} selected={selected} showMarkers={markers} spin={spin} className="absolute inset-0" />
          <div className="absolute top-3 left-3">
            <ToggleGroup type="single" value={color} onValueChange={(v) => v && setColor(v as CastColor)} variant="outline" size="sm" className="bg-zinc-950/70 backdrop-blur">
              <ToggleGroupItem value="parts">By piece</ToggleGroupItem>
              <ToggleGroupItem value="metal">Metal</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="absolute top-3 right-3 flex items-center gap-1.5">
            <Toggle variant="outline" size="sm" pressed={markers} onPressedChange={setMarkers} aria-label="Show chests and hoppers" className="bg-zinc-950/70 backdrop-blur"><GemIcon />Things</Toggle>
            <Toggle variant="outline" size="sm" pressed={spin} onPressedChange={setSpin} aria-label="Turn slowly" className="bg-zinc-950/70 backdrop-blur"><RotateCwIcon />Turn</Toggle>
            <Button variant="outline" size="icon-sm" onClick={() => view.current?.resetView()} aria-label="Reset the view" className="bg-zinc-950/70 backdrop-blur"><ScanIcon /></Button>
            <Button variant="outline" size="icon-sm" onClick={shot} aria-label="Save a picture" className="bg-zinc-950/70 backdrop-blur"><CameraIcon /></Button>
          </div>
          <div className="pointer-events-none absolute bottom-3 left-3 text-xs text-zinc-400">Drag to turn, scroll to zoom, right-drag to move. The walls are taken away: only the space inside and what stands in it is drawn.</div>
        </div>
      </Card>

      <div className="flex flex-col gap-6">
        <Card size="sm">
          <CardHeader>
            <CardTitle>{info.name}</CardTitle>
            <CardDescription>{info.purpose || info.kind}</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-4">
            <Stat label="Size" value={info.size.join("×")} hint="x × y × z blocks" />
            <Stat label="Open cells" value={data.stats.cells.toLocaleString()} />
            <Stat label="Kind" value={info.kind} />
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>What must be built</CardTitle>
            <CardDescription>Walls, floors and roofs are described by what they must do, not by one block. Everything outside the build is not checked.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {roles.length === 0 && <p className="text-sm text-muted-foreground">No wall requirements recorded.</p>}
            {roles.map((l) => (
              <div key={l.index} className="flex flex-col gap-1 text-sm">
                <div className="flex items-baseline justify-between gap-2"><span className="font-medium">Wall block</span><span className="text-xs text-muted-foreground tabular-nums">{l.cells.toLocaleString()} cells</span></div>
                <span className="text-muted-foreground">Needs {l.needs}</span>
                {l.sources.length > 0 && <span className="text-xs text-muted-foreground">Was: {l.sources.map((x) => `${x.block.replace(/^minecraft:/, "").replace(/_/g, " ")} ${x.cells.toLocaleString()}`).join(", ")}</span>}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle>Pieces inside</CardTitle>
            <CardDescription>Click one to pick it out. Exact blocks are only where the design needs them.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1">
            {data.parts.map((p) => <PartRow key={p.id} p={p} active={selected === p.id} tinted={color === "parts"} onPick={() => setSelected(selected === p.id ? null : p.id)} />)}
          </CardContent>
        </Card>

        {(data.notes.length > 0 || info.source.world) && (
          <Card size="sm">
            <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
              {data.notes.map((n) => <p key={n}>{n}</p>)}
              {info.source.world && <p className="flex flex-wrap items-center gap-2 text-xs"><Badge variant="secondary">captured</Badge>from {info.source.world}{info.source.by ? ` by ${info.source.by}` : ""}{info.source.capturedAt ? `, ${info.source.capturedAt.slice(0, 10)}` : ""}</p>}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

export function Schematics() {
  const { data, state } = useJson<{ schematics: SchematicSummary[] }>("/api/schematics", 120_000, (d) => d.schematics.map((s) => s.id).join())
  const [pick, setPick] = useState<string | null>(null)
  const list = data?.schematics ?? []
  const current = list.find((s) => s.id === pick) ?? list[0] ?? null
  return (
    <>
      <PageHeader title="Schematics" description="What the bots consider a build to be, block by block but as generic as possible: walls are 'a solid, light-blocking, non-flammable block', water and pieces are exact. Shown as the space inside, like the Bases cast.">
        {list.length > 0 && (
          <Select value={current?.id} onValueChange={setPick}>
            <SelectTrigger className="w-64" aria-label="Choose a schematic"><SelectValue placeholder="Choose a schematic" /></SelectTrigger>
            <SelectContent>{list.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
        )}
      </PageHeader>
      {state === "loading" && <CastLoading />}
      {state === "failed" && <Empty><EmptyHeader><EmptyTitle>Could not load the schematics</EmptyTitle><EmptyDescription>The dashboard server did not answer. It will keep trying.</EmptyDescription></EmptyHeader></Empty>}
      {state === "ok" && !current && <Empty><EmptyHeader><EmptyTitle>No schematics saved yet</EmptyTitle><EmptyDescription>A bot saves one with the save_schematic skill, or run tools/schematic.js on a world save.</EmptyDescription></EmptyHeader></Empty>}
      {current && <Body key={current.id} item={current} />}
    </>
  )
}
