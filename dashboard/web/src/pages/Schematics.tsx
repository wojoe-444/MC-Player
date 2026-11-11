import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CameraIcon, Loader2Icon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Slider } from "@/components/ui/slider"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { PageHeader } from "@/components/common"
import { SchematicPicker, useCatalogState } from "@/components/SchematicPicker"
import { SchematicView, type Hover, type SchematicViewHandle } from "@/components/SchematicView"
import { useJson } from "@/pages/Bases"
import { iconOf } from "@/lib/schematic/appearance"
import { build, decodeCells, prepare } from "@/lib/schematic/mesher"
import { displayName } from "@/lib/schematic/names"
import type { BomRow, SchematicDetail, SchematicSummary } from "@/lib/schematic/types"
import { cn } from "@/lib/utils"

const sig = (d: SchematicDetail) => `${d.id}:${d.rle.length}:${d.palette.length}:${d.bom.map((r) => r.cells).join(",")}`
const iconCache = new Map<string, string>()
const icon = (block: string) => { let u = iconCache.get(block); if (u == null) { u = iconOf(block); iconCache.set(block, u) } return u }
const n0 = (n: number) => n.toLocaleString()

function BlockIcon({ block, className }: { block: string; className?: string }) {
  return <img src={icon(block)} alt="" width={20} height={20} className={cn("size-5 shrink-0 rounded-[2px]", className)} style={{ imageRendering: "pixelated" }} />
}
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="flex flex-col gap-2"><h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>{children}</section>
}
function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-primary" />
      {children}
    </label>
  )
}

function Viewer({ item, picker }: { item: SchematicSummary; picker: React.ReactNode }) {
  const { data, state } = useJson<SchematicDetail>(`/api/schematics/${encodeURIComponent(item.id)}`, 120_000, sig)
  if (state === "failed") return <Empty><EmptyHeader><EmptyTitle>Could not load the schematic</EmptyTitle><EmptyDescription>The dashboard server did not answer. It will keep trying.</EmptyDescription></EmptyHeader></Empty>
  if (state === "missing") return <Empty><EmptyHeader><EmptyTitle>No such schematic</EmptyTitle><EmptyDescription>The list changed; pick another one.</EmptyDescription></EmptyHeader></Empty>
  if (!data) return <Card className="flex h-[34rem] items-center justify-center gap-3 text-sm text-muted-foreground" role="status"><Loader2Icon className="size-6 animate-spin" />Loading the schematic…</Card>
  return <Body key={data.id} data={data} picker={picker} />
}

function Body({ data, picker }: { data: SchematicDetail; picker: React.ReactNode }) {
  const [W, H, D] = data.size
  const prep = useMemo(() => prepare({ size: data.size, cells: decodeCells(data.rle, data.size), palette: data.palette }), [data])
  const [mode, setMode] = useState<"up" | "single">("up")
  const [layer, setLayer] = useState(H - 1)
  const [ghost, setGhost] = useState(true)
  // a yard around a house is part of the picture; the rock around a captured farm hides it, so that starts off
  const [surroundings, setSurroundings] = useState(data.mode === "aesthetic")
  const [spin, setSpin] = useState(false)
  const [isolate, setIsolate] = useState<string | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  const [broken, setBroken] = useState(false)
  const view = useRef<SchematicViewHandle>(null)

  const isolateSet = useMemo(() => { const r = isolate ? data.bom.find((b) => b.key === isolate) : null; return r ? new Set(r.indices) : null }, [isolate, data.bom])
  const built = useMemo(
    () => build(prep, { minLayer: mode === "single" ? layer : 0, maxLayer: layer, isolate: isolateSet, scenery: surroundings, ghost }),
    [prep, mode, layer, isolateSet, surroundings, ghost],
  )

  // arrow keys step the layer, unless the keys are doing something in a control
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [role="slider"], [role="combobox"], [role="listbox"], [role="tab"]')) return
      e.preventDefault()
      setLayer((l) => Math.max(0, Math.min(H - 1, l + (e.key === "ArrowUp" ? 1 : -1))))
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [H])

  const shot = useCallback(() => {
    const url = view.current?.screenshot(); if (!url) return
    const a = document.createElement("a"); a.href = url; a.download = `${data.id}-schematic.png`; a.click()
  }, [data.id])

  const hovered = hover ? { entry: data.palette[prep.model.cells[hover.cell]], hover } : null
  const rowOf = (e: SchematicDetail["palette"][number] | undefined): BomRow | undefined => (e && !e.scenery ? data.bom.find((b) => b.block === (e.role === "water" || e.role === "lava" ? e.role : e.block?.replace(/^(soul_)?wall_torch$/, "$1torch"))) : undefined)

  return (
    <div className="grid gap-4 lg:grid-cols-[21rem_minmax(0,1fr)]">
      <Card className="gap-5 self-start overflow-y-auto p-4 lg:max-h-[calc(100vh-15rem)]">
        {picker}
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold tracking-tight">{data.name}</h2>
          <p className="text-sm text-muted-foreground">{W} × {D} footprint · {H} layers tall</p>
          {data.purpose && <p className="text-xs text-muted-foreground">{data.purpose}</p>}
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Badge variant="secondary" className="capitalize">{data.kind}</Badge>
            <Badge variant="outline" title={data.mode === "aesthetic" ? "Every block is exactly the one drawn" : "Walls accept any solid, light-blocking, non-flammable block"}>{data.mode === "aesthetic" ? "Exact blocks" : "Functional"}</Badge>
          </div>
        </div>

        <Section title="View">
          <div className="grid grid-cols-3 gap-2">
            {([["iso", "Isometric"], ["front", "Front"], ["top", "Top"]] as const).map(([v, label]) => <Button key={v} variant="outline" size="sm" onClick={() => view.current?.setView(v)}>{label}</Button>)}
          </div>
        </Section>

        <Section title="Layer slicer">
          <ToggleGroup type="single" value={mode} onValueChange={(v) => v && setMode(v as "up" | "single")} variant="outline" className="grid w-full grid-cols-2" spacing={0}>
            <ToggleGroupItem value="up">Up to layer</ToggleGroupItem>
            <ToggleGroupItem value="single">Single layer</ToggleGroupItem>
          </ToggleGroup>
          <Slider min={0} max={Math.max(0, H - 1)} step={1} value={[layer]} onValueChange={(v) => setLayer(v[0])} aria-label="Layer" disabled={H < 2} />
          <div className="flex items-baseline justify-between text-sm"><span className="text-muted-foreground">Layers shown</span><span className="font-semibold tabular-nums">{mode === "single" ? layer : `0 – ${layer}`}</span></div>
          <Check checked={ghost} onChange={setGhost}>Ghost hidden blocks</Check>
          <Check checked={surroundings} onChange={setSurroundings}>Show surroundings</Check>
          <Check checked={spin} onChange={setSpin}>Auto-rotate</Check>
        </Section>

        <Section title="Raw materials">
          {data.raw.lines.length === 0 && data.raw.other.length === 0 && <p className="text-sm text-muted-foreground">Nothing to gather.</p>}
          <dl className="flex flex-col gap-1 text-sm">
            {data.raw.lines.map((l) => (
              <div key={l.id} className="flex items-baseline justify-between gap-3">
                <dt>{l.label}{l.verb ? ` ${l.verb}` : ""}</dt>
                <dd className="tabular-nums"><span className="font-semibold">{n0(l.amount)}</span>{l.verb && l.amount >= 64 ? <span className="ml-1 text-xs text-muted-foreground">({l.stacks} stacks)</span> : null}</dd>
              </div>
            ))}
            {data.raw.other.length > 0 && <div className="pt-1 text-xs font-medium text-muted-foreground">Other</div>}
            {data.raw.other.map((o) => <div key={o.name} className="flex items-baseline justify-between gap-3"><dt>{o.name}</dt><dd className="font-semibold tabular-nums">{n0(o.amount)}</dd></div>)}
          </dl>
          {data.raw.note && <p className="text-xs text-muted-foreground">{data.raw.note}</p>}
        </Section>

        <Section title="Bill of materials">
          <div className="flex items-baseline justify-between text-sm"><span className="text-muted-foreground">Blocks visible / total</span><span className="font-semibold tabular-nums">{n0(built.visible)} / {n0(built.total)}</span></div>
          <p className="text-xs text-muted-foreground">Click a row to isolate that block type. {isolate && <button className="underline underline-offset-2 hover:text-foreground" onClick={() => setIsolate(null)}>Clear</button>}</p>
          <ul className="-mx-1 flex flex-col">
            {data.bom.map((r) => (
              <li key={r.key}>
                <button onClick={() => setIsolate(isolate === r.key ? null : r.key)} aria-pressed={isolate === r.key} title={r.subs ?? undefined}
                  className={cn("flex w-full items-center gap-2.5 rounded-md px-1 py-1 text-left text-sm hover:bg-accent", isolate === r.key && "bg-accent ring-1 ring-ring")}>
                  <BlockIcon block={r.block} />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight"><span className="truncate">{r.name}</span>{r.role === "solid" && <span className="truncate text-[11px] text-muted-foreground">or any solid block</span>}</span>
                  <span className="font-semibold tabular-nums">{n0(r.cells)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Section>

        {(data.notes.length > 0 || data.source.world) && (
          <div className="flex flex-col gap-1.5 border-t pt-3 text-xs text-muted-foreground">
            {data.notes.map((n) => <p key={n}>{n}</p>)}
            {data.source.world && <p>Captured from {data.source.world}{data.source.by ? ` by ${data.source.by}` : ""}{data.source.capturedAt ? `, ${data.source.capturedAt.slice(0, 10)}` : ""}.</p>}
          </div>
        )}
      </Card>

      <Card className="relative h-[34rem] overflow-hidden py-0 lg:h-[calc(100vh-15rem)] lg:min-h-[34rem]">
        {broken
          ? <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">This window cannot draw 3D (WebGL is off). The bill of materials still works.</div>
          : <SchematicView ref={view} prep={prep} built={built} spin={spin} ground={surroundings} onHover={setHover} onUnavailable={() => setBroken(true)} className="absolute inset-0" />}
        <div className="absolute top-3 right-3"><Button variant="outline" size="icon-sm" onClick={shot} aria-label="Save a picture" className="bg-background/80 backdrop-blur"><CameraIcon /></Button></div>
        {hovered && (
          <div className="pointer-events-none absolute z-10 max-w-64 rounded-lg border bg-popover/95 p-2.5 text-xs text-popover-foreground shadow-md backdrop-blur"
            style={{ left: Math.min(hovered.hover.px + 14, 9999), top: hovered.hover.py + 14 }}>
            <div className="flex items-center gap-2 text-sm font-medium">
              {hovered.entry?.block && <BlockIcon block={hovered.entry.block} />}
              {hovered.entry ? displayName(hovered.entry.role === "water" || hovered.entry.role === "lava" ? hovered.entry.role : hovered.entry.block ?? "") : ""}
            </div>
            <div className="mt-1 text-muted-foreground tabular-nums">x {data.origin[0] + hovered.hover.x}, y {data.origin[1] + hovered.hover.y}, z {data.origin[2] + hovered.hover.z} · layer {hovered.hover.y}</div>
            {(hovered.entry?.props || hovered.entry?.level != null) && (
              <div className="mt-1 text-muted-foreground">{Object.entries(hovered.entry.props ?? { level: hovered.entry.level ?? "" }).map(([k, v]) => `${k} ${v}`).join(" · ")}</div>
            )}
            <div className="mt-1.5">
              {hovered.entry?.scenery ? "Surroundings: not part of the build, never checked."
                : hovered.entry?.role === "solid" ? (rowOf(hovered.entry)?.subs ?? "Any solid block works here.")
                : hovered.entry?.alt?.length ? `Exactly this block, or ${hovered.entry.alt.map(displayName).join(", ")}.`
                : "Exactly this block."}
            </div>
          </div>
        )}
        <div className="pointer-events-none absolute right-3 bottom-3 rounded-md bg-background/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur">Drag to orbit · right-drag to pan · scroll to zoom · ↑/↓ step layers · hover a block to inspect</div>
      </Card>
    </div>
  )
}

export function Schematics() {
  const { data, state } = useJson<{ schematics: SchematicSummary[] }>("/api/schematics", 120_000, (d) => d.schematics.map((s) => s.id + s.name + s.category + s.mode).join())
  const [pick, setPick] = useState<string | null>(null)
  const list = data?.schematics ?? []
  const current = list.find((s) => s.id === pick) ?? list[0] ?? null
  // one build needs no catalog; with more, a searchable list grouped by category
  const catalog = useCatalogState()
  const picker = list.length > 1 ? <SchematicPicker list={list} currentId={current?.id ?? null} onPick={setPick} state={catalog} /> : null
  return (
    <>
      <PageHeader title="Schematics" description="What the bots consider a build to be, block by block. Every cell shows a specific block; its role says what else may stand there (a wall accepts any solid, light-blocking, non-flammable block)." />
      {state === "loading" && <Card className="flex h-40 items-center justify-center gap-3 text-sm text-muted-foreground" role="status"><Loader2Icon className="size-6 animate-spin" />Loading the schematics…</Card>}
      {state === "failed" && <Empty><EmptyHeader><EmptyTitle>Could not load the schematics</EmptyTitle><EmptyDescription>The dashboard server did not answer. It will keep trying.</EmptyDescription></EmptyHeader></Empty>}
      {state === "ok" && !current && <Empty><EmptyHeader><EmptyTitle>No schematics saved yet</EmptyTitle><EmptyDescription>A bot saves one with the save_schematic skill, or run tools/schematic.js on a world save.</EmptyDescription></EmptyHeader></Empty>}
      {current && <Viewer key={current.id} item={current} picker={picker} />}
    </>
  )
}
