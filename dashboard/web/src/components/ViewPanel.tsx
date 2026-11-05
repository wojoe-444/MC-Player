import { useEffect, useState } from "react"
import { ImageOffIcon, ExternalLinkIcon } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Slider } from "@/components/ui/slider"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ago, useNow } from "@/useDashboard"
import type { BotId, BotSnap } from "@/types"

function Frame({ src, pixelated, alt }: { src: string; pixelated?: boolean; alt: string }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading")
  useEffect(() => setState("loading"), [src])
  return (
    <div className="relative aspect-video overflow-hidden rounded-lg border bg-muted">
      {state === "loading" && <Skeleton className="absolute inset-0 rounded-none" />}
      {state === "error" ? (
        <Empty className="h-full">
          <EmptyHeader>
            <EmptyMedia variant="icon"><ImageOffIcon /></EmptyMedia>
            <EmptyTitle>No image yet</EmptyTitle>
            <EmptyDescription>The bot has not written this view.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <img
          src={src}
          alt={alt}
          onLoad={() => setState("ok")}
          onError={() => setState("error")}
          className={`size-full object-contain ${pixelated ? "[image-rendering:pixelated]" : ""}`}
        />
      )}
    </div>
  )
}

function Meta({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">{children}</div>
}

function History({ id }: { id: BotId }) {
  const [kind, setKind] = useState<"pov" | "top">("pov")
  const [files, setFiles] = useState<string[] | null>(null)
  const [idx, setIdx] = useState(0)

  useEffect(() => {
    let live = true
    setFiles(null)
    fetch(`/api/history/${id}/${kind}`).then((r) => r.json()).then((f: string[]) => {
      if (!live) return
      setFiles(f)
      setIdx(Math.max(0, f.length - 1))
    })
    return () => { live = false }
  }, [id, kind])

  if (!files) return <Skeleton className="aspect-video w-full" />
  if (!files.length) {
    return (
      <Empty className="aspect-video rounded-lg border">
        <EmptyHeader>
          <EmptyMedia variant="icon"><ImageOffIcon /></EmptyMedia>
          <EmptyTitle>No history</EmptyTitle>
          <EmptyDescription>No timestamped frames are stored yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const file = files[idx]
  const m = file.match(/(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)-(\d\d)/)
  const when = m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`).toLocaleTimeString([], { hour12: false }) : file
  return (
    <div className="flex flex-col gap-3">
      <Frame src={`/img/${id}/h/${file}`} pixelated={kind === "top"} alt="history frame" />
      <Slider min={0} max={files.length - 1} step={1} value={[idx]} onValueChange={(v) => setIdx(v[0])} />
      <Meta>
        <span>{when} · frame {idx + 1}/{files.length}</span>
        <ToggleGroup type="single" variant="outline" size="sm" value={kind} onValueChange={(v) => v && setKind(v as "pov" | "top")}>
          <ToggleGroupItem value="pov">First-person</ToggleGroupItem>
          <ToggleGroupItem value="top">Top-down</ToggleGroupItem>
        </ToggleGroup>
      </Meta>
    </div>
  )
}

export function ViewPanel({ bot }: { bot: BotSnap }) {
  const now = useNow()
  const [tab, setTab] = useState("top")
  const img = bot.status?._img ?? {}
  const age = (t?: number) => (t ? ago(now - t) : "n/a")
  const host = typeof location !== "undefined" ? location.hostname : "localhost"
  const viewer = `http://${host}:${bot.viewerPort}/`

  return (
    <Tabs value={tab} onValueChange={setTab} className="gap-3">
      <TabsList>
        <TabsTrigger value="top">Top-down</TabsTrigger>
        <TabsTrigger value="pov">First-person</TabsTrigger>
        <TabsTrigger value="3d">3D live</TabsTrigger>
        <TabsTrigger value="hist">History</TabsTrigger>
      </TabsList>
      <TabsContent value="top" className="flex flex-col gap-2">
        <Frame src={`/img/${bot.id}/top?t=${img.top ?? 0}`} pixelated alt="Top-down map" />
        <Meta><span>Purple marks mob-spawnable cells</span><span>updated {age(img.top)}</span></Meta>
      </TabsContent>
      <TabsContent value="pov" className="flex flex-col gap-2">
        <Frame src={`/img/${bot.id}/pov?t=${img.pov ?? 0}`} alt="First-person view" />
        <Meta><span>Four-way first-person sheet</span><span>updated {age(img.pov)}</span></Meta>
      </TabsContent>
      <TabsContent value="3d" className="flex flex-col gap-2">
        {tab === "3d" && (
          <div className="aspect-video overflow-hidden rounded-lg border bg-muted">
            <iframe src={viewer} title={`${bot.name} prismarine viewer`} className="size-full border-0" />
          </div>
        )}
        <Meta>
          <span>Prismarine viewer on port {bot.viewerPort}; may stay black on 1.21.6</span>
          <Button variant="outline" size="sm" asChild>
            <a href={viewer} target="_blank" rel="noreferrer">Open<ExternalLinkIcon data-icon="inline-end" /></a>
          </Button>
        </Meta>
      </TabsContent>
      <TabsContent value="hist">{tab === "hist" && <History id={bot.id} />}</TabsContent>
    </Tabs>
  )
}
