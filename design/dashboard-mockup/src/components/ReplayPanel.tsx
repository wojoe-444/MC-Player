import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FilmIcon, PauseIcon, PlayIcon, SkipBackIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Slider } from "@/components/ui/slider"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ago, useNow } from "@/useDashboard"
import type { BotId } from "@/types"

type ClipInfo = { name: string; reason: string; savedAt: string | null; durationMs: number; minHp: number | null; events: Record<string, number> }
type Sample = { t: number; x: number; y: number; z: number; yaw: number; pit: number; hp: number; fd: number; h: string | null; a: string; m: [string, number, number, number, number][] }
type Ev = { t: number; src: string; kind: string; [k: string]: unknown }
type Clip = {
  v: number; bot: string; reason: string; savedAt: string; hz: number; t0: number; t1: number; pos: { x: number; y: number; z: number }
  map: { x0: number; z0: number; size: number; y0: number; palette: string[]; cells: number[] } | null
  samples: Sample[]; events: Ev[]
}

// ---- drawing helpers ----
function blockColor(name: string): [number, number, number] {
  const n = name
  if (/water|kelp|seagrass|ice/.test(n)) return [58, 100, 200]
  if (/lava|magma|fire/.test(n)) return [230, 110, 30]
  if (/sand|sandstone/.test(n)) return [219, 207, 140]
  if (/grass|moss|fern|leaves|azalea|vine|bush|crop|wheat|carrot|potato|beetroot|melon|pumpkin/.test(n)) return [86, 140, 62]
  if (/snow|powder/.test(n)) return [240, 245, 250]
  if (/dirt|mud|podzol|farmland|path|clay/.test(n)) return [134, 96, 67]
  if (/log|wood|plank|stem|fence|door|ladder|chest|barrel|bookshelf|crafting|table/.test(n)) return [150, 110, 60]
  if (/coal/.test(n)) return [50, 50, 50]
  if (/iron|copper|gold|diamond|redstone|lapis|emerald|ore/.test(n)) return [190, 165, 140]
  if (/obsidian|deepslate|basalt|blackstone|bedrock/.test(n)) return [60, 55, 70]
  if (/netherrack|nether|crimson|warped/.test(n)) return [120, 50, 50]
  if (/torch|lantern|glowstone|shroomlight/.test(n)) return [250, 210, 90]
  if (/stone|cobble|andesite|diorite|granite|tuff|gravel|brick|furnace|dripstone|calcite/.test(n)) return [128, 128, 128]
  return [150, 150, 150]
}
const rgb = (c: number[], k = 1) => `rgb(${Math.min(255, Math.round(c[0] * k))},${Math.min(255, Math.round(c[1] * k))},${Math.min(255, Math.round(c[2] * k))})`
const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}.${Math.floor((ms % 1000) / 100)}`

function sampleAt(clip: Clip, t: number) {
  const hz = clip.hz || 10
  const i = Math.max(0, Math.min(clip.samples.length - 1, Math.round(t / (1000 / hz))))
  return { i, s: clip.samples[i] }
}

function evText(e: Ev) {
  if (e.kind === "damage") return `${Number(e.amount ?? 0).toFixed(1)} hp from ${String(e.cause ?? "?")}${e.by ? ` (${String(e.by)})` : ""}`
  if (e.kind === "chat") return `${String(e.user ?? "")}: ${String(e.text ?? "")}`
  if (e.kind === "task") return `${String(e.event ?? "")} ${String(e.name ?? "")}`
  if (e.kind === "death") return "died"
  return e.kind
}
const evVariant = (k: string) => (k === "death" || k === "damage" ? ("destructive" as const) : k === "chat" ? ("secondary" as const) : ("outline" as const))

function draw(canvas: HTMLCanvasElement, clip: Clip, t: number) {
  const ctx = canvas.getContext("2d"); if (!ctx) return
  const { s, i } = sampleAt(clip, t)
  // world bounds: the terrain map, widened to include every position in the clip
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  const grow = (x: number, z: number) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z) }
  if (clip.map) { grow(clip.map.x0, clip.map.z0); grow(clip.map.x0 + clip.map.size, clip.map.z0 + clip.map.size) }
  for (const p of clip.samples) { grow(p.x - 3, p.z - 3); grow(p.x + 3, p.z + 3); for (const m of p.m) grow(m[1], m[3]) }
  if (!isFinite(minX)) return
  const bw = maxX - minX, bh = maxZ - minZ
  const W = canvas.width, H = canvas.height
  const sc = Math.min(W / bw, H / bh)
  const ox = (W - bw * sc) / 2, oz = (H - bh * sc) / 2
  const X = (x: number) => ox + (x - minX) * sc, Z = (z: number) => oz + (z - minZ) * sc

  ctx.fillStyle = "#0b0b0e"; ctx.fillRect(0, 0, W, H)
  if (clip.map) {
    const m = clip.map
    const pal = m.palette.map(blockColor)
    for (let dz = 0; dz < m.size; dz++) for (let dx = 0; dx < m.size; dx++) {
      const c = m.cells[dz * m.size + dx]
      if (c < 0) { ctx.fillStyle = "#15151a" } else {
        const p = Math.floor(c / 64), h = c % 64
        const rel = (m.y0 + h) - clip.pos.y // blocks above (+) or below (-) where the clip ended
        ctx.fillStyle = rgb(pal[p] ?? [150, 150, 150], Math.max(0.55, Math.min(1.25, 1 + rel * 0.04)))
      }
      ctx.fillRect(X(m.x0 + dx), Z(m.z0 + dz), sc + 0.5, sc + 0.5)
    }
  }
  // trail: faded past, bright up to now
  ctx.lineWidth = 2; ctx.lineJoin = "round"
  ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.beginPath()
  clip.samples.forEach((p, k) => (k ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z)))); ctx.stroke()
  ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.beginPath()
  clip.samples.slice(0, i + 1).forEach((p, k) => (k ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z)))); ctx.stroke()

  // damage flash and death marker
  const recent = clip.events.filter((e) => (e.kind === "damage" || e.kind === "death") && t >= e.t && t - e.t < 700)
  if (recent.length) {
    const k = 1 - (t - recent[recent.length - 1].t) / 700
    ctx.strokeStyle = `rgba(239,68,68,${k})`; ctx.lineWidth = 4
    ctx.beginPath(); ctx.arc(X(s.x), Z(s.z), (0.8 + (1 - k) * 2.2) * sc, 0, Math.PI * 2); ctx.stroke()
  }
  for (const e of clip.events) if (e.kind === "death" && t >= e.t) {
    const d = sampleAt(clip, e.t).s
    ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 3; const r = sc * 0.7
    ctx.beginPath(); ctx.moveTo(X(d.x) - r, Z(d.z) - r); ctx.lineTo(X(d.x) + r, Z(d.z) + r); ctx.moveTo(X(d.x) + r, Z(d.z) - r); ctx.lineTo(X(d.x) - r, Z(d.z) + r); ctx.stroke()
  }

  // mobs and players
  ctx.font = `${Math.max(10, Math.round(sc * 0.9))}px ui-monospace, monospace`; ctx.textAlign = "left"
  for (const [name, mx, , mz] of s.m) {
    const isPlayer = /^[A-Za-z0-9_]{3,16}$/.test(name) && !/^(zombie|skeleton|creeper|spider|enderman|witch|drowned|husk|stray|phantom|pillager|slime|blaze)/.test(name)
    ctx.fillStyle = isPlayer ? "#60a5fa" : "#ef4444"
    ctx.beginPath(); ctx.arc(X(mx), Z(mz), Math.max(3, sc * 0.45), 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillText(name, X(mx) + sc * 0.7, Z(mz) - sc * 0.3)
  }

  // the bot: dot with a facing arrow (mineflayer yaw 0 faces -z; x = -sin, z = -cos)
  const dx = -Math.sin(s.yaw), dz = -Math.cos(s.yaw)
  const bx = X(s.x), bz = Z(s.z), r = Math.max(4, sc * 0.55)
  ctx.fillStyle = "#fafafa"; ctx.beginPath(); ctx.arc(bx, bz, r, 0, Math.PI * 2); ctx.fill()
  ctx.strokeStyle = "#fafafa"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(bx, bz); ctx.lineTo(bx + dx * r * 3, bz + dz * r * 3); ctx.stroke()
}

function Sparkline({ clip, t }: { clip: Clip; t: number }) {
  const W = 600, H = 56
  const total = Math.max(1, clip.samples[clip.samples.length - 1]?.t ?? 1)
  const pts = (key: "hp" | "fd") => clip.samples.map((p) => `${(p.t / total) * W},${H - (Math.min(20, p[key]) / 20) * (H - 4) - 2}`).join(" ")
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full" preserveAspectRatio="none" role="img" aria-label="Health and food over the clip">
      <polyline points={pts("fd")} fill="none" strokeWidth={1.5} className="stroke-muted-foreground" vectorEffect="non-scaling-stroke" />
      <polyline points={pts("hp")} fill="none" strokeWidth={2} className="stroke-destructive" vectorEffect="non-scaling-stroke" />
      {clip.events.filter((e) => e.kind === "damage" || e.kind === "death").map((e, k) => (
        <line key={k} x1={(e.t / total) * W} x2={(e.t / total) * W} y1={0} y2={H} strokeWidth={1} className="stroke-destructive" opacity={0.4} vectorEffect="non-scaling-stroke" />
      ))}
      <line x1={(t / total) * W} x2={(t / total) * W} y1={0} y2={H} strokeWidth={2} className="stroke-primary" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function ReplayPanel({ id }: { id: BotId }) {
  const now = useNow(15000)
  const [clips, setClips] = useState<ClipInfo[] | null>(null)
  const [sel, setSel] = useState<string>("")
  const [clip, setClip] = useState<Clip | null>(null)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState("1")
  const canvas = useRef<HTMLCanvasElement>(null)
  const tRef = useRef(0)

  useEffect(() => {
    let live = true
    const load = () => fetch(`/api/clips/${id}`).then((r) => r.json()).then((d: ClipInfo[]) => {
      if (!live) return
      setClips(d)
      setSel((s) => s || d[0]?.name || "")
    }).catch(() => {})
    load()
    const i = setInterval(load, 15000)
    return () => { live = false; clearInterval(i) }
  }, [id])

  useEffect(() => {
    if (!sel) return
    let live = true
    setClip(null); setPlaying(false)
    fetch(`/api/clip/${id}/${sel}`).then((r) => r.json()).then((c: Clip) => { if (live) { setClip(c); setT(0); tRef.current = 0; setPlaying(true) } })
    return () => { live = false }
  }, [id, sel])

  const total = clip?.samples.length ? clip.samples[clip.samples.length - 1].t : 0

  // animation loop
  useEffect(() => {
    if (!playing || !clip) return
    let raf = 0, last = performance.now()
    const step = (nowT: number) => {
      const dt = (nowT - last) * Number(speed); last = nowT
      tRef.current = Math.min(total, tRef.current + dt)
      setT(tRef.current)
      if (tRef.current >= total) { setPlaying(false); return }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, clip, speed, total])

  const render = useCallback(() => { if (canvas.current && clip) draw(canvas.current, clip, t) }, [clip, t])
  useEffect(render, [render])

  const seek = (v: number) => { tRef.current = v; setT(v) }
  const cur = useMemo(() => (clip ? sampleAt(clip, t).s : null), [clip, t])
  const evs = clip?.events ?? []
  const activeEv = evs.filter((e) => e.t <= t).length - 1

  if (!clips) return <Skeleton className="h-96 w-full" />
  if (clips.length === 0) {
    return (
      <Empty className="rounded-lg border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><FilmIcon /></EmptyMedia>
          <EmptyTitle>No dashcam clips yet</EmptyTitle>
          <EmptyDescription>
            Clips are written to brain/state/clips/ when the bot dies, takes a big hit, drops to low health, or saves one on request. The pilot-kit module has to be loaded first. They appear here on their own.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={sel} onValueChange={setSel}>
          <SelectTrigger className="w-full max-w-md"><SelectValue placeholder="Pick a clip" /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {clips.map((c) => (
                <SelectItem key={c.name} value={c.name}>
                  {c.savedAt ? ago(now - new Date(c.savedAt).getTime()) : c.name} · {c.reason}{c.minHp !== null ? ` · low ${c.minHp} hp` : ""}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">{clips.length} clips kept, newest first</span>
      </div>

      {!clip ? <Skeleton className="aspect-square w-full max-w-3xl" /> : (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] [&>*]:min-w-0">
          <div className="flex flex-col gap-3">
            <div className="overflow-hidden rounded-lg border bg-muted">
              <canvas ref={canvas} width={720} height={720} className="mx-auto aspect-square w-full max-w-[720px] [image-rendering:pixelated]" />
            </div>
            {!clip.map && <p className="text-xs text-muted-foreground">This clip has no terrain map, so only the path and mobs are drawn.</p>}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="icon-sm" aria-label="Restart" onClick={() => { seek(0); setPlaying(true) }}><SkipBackIcon /></Button>
              <Button variant="outline" size="icon-sm" aria-label={playing ? "Pause" : "Play"} onClick={() => { if (!playing && tRef.current >= total) seek(0); setPlaying((p) => !p) }}>
                {playing ? <PauseIcon /> : <PlayIcon />}
              </Button>
              <ToggleGroup type="single" variant="outline" size="sm" value={speed} onValueChange={(v) => v && setSpeed(v)}>
                {["0.25", "0.5", "1", "2", "4"].map((s) => <ToggleGroupItem key={s} value={s}>{s}×</ToggleGroupItem>)}
              </ToggleGroup>
              <span className="ml-auto font-mono text-sm tabular-nums">{fmt(t)} / {fmt(total)}</span>
            </div>
            <Slider min={0} max={Math.max(1, total)} step={50} value={[t]} onValueChange={(v) => { setPlaying(false); seek(v[0]) }} />
            <Sparkline clip={clip} t={t} />
            <p className="text-xs text-muted-foreground">Health (red) and food (grey) over the clip. Red lines mark damage and death.</p>
          </div>

          <div className="flex flex-col gap-4">
            {cur && (
              <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap gap-2">
                  <Badge variant={cur.hp <= 6 ? "destructive" : "secondary"}>hp {cur.hp}</Badge>
                  <Badge variant="secondary">food {cur.fd}</Badge>
                  <Badge variant="outline">{cur.h ?? "empty hand"}</Badge>
                </div>
                <p className="break-words"><span className="mr-2 text-muted-foreground">Doing</span>{cur.a}</p>
                <p className="font-mono text-xs text-muted-foreground">{cur.x.toFixed(1)}, {cur.y.toFixed(1)}, {cur.z.toFixed(1)} · {cur.m.length} mobs in range</p>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Events ({evs.length})</h3>
              {evs.length === 0 ? <p className="text-xs text-muted-foreground">No events in this clip.</p> : (
                <ScrollArea className="h-72 rounded-lg border [&>[data-slot=scroll-area-viewport]>div]:!block">
                  <div className="flex flex-col p-1">
                    {evs.map((e, k) => (
                      <button key={k} onClick={() => { setPlaying(false); seek(e.t) }}
                        className={`grid grid-cols-[3.25rem_5rem_1fr] items-start gap-2 rounded-md px-2 py-1 text-left font-mono text-xs hover:bg-muted ${k === activeEv ? "bg-muted" : ""}`}>
                        <span className="text-muted-foreground">{fmt(e.t)}</span>
                        <Badge variant={evVariant(e.kind)} className="justify-self-start"><span className="truncate">{e.kind}</span></Badge>
                        <span className="break-words">{evText(e)}</span>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
