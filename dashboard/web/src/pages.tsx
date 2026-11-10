import { useMemo, useState } from "react"
import { Link, Navigate, Outlet, useOutletContext, useParams } from "react-router-dom"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { BagBadges, BotBadges, dayClock, GoalBox, StaleAlert, Vitals } from "@/components/BotParts"
import { BehaviorPanel } from "@/components/BehaviorPanel"
import { AcquiredPanel } from "@/components/AcquiredPanel"
import { InventoryPanel } from "@/components/InventoryPanel"
import { badgeVariant, clean, clock, KEY, LogPanel } from "@/components/LogPanel"
import { ReplayPanel } from "@/components/ReplayPanel"
import { MemoryView, StructureView } from "@/components/StructurePanel"
import { Frame, ViewPanel } from "@/components/ViewPanel"
import { useData } from "@/DashboardContext"
import { BOT_IDS, type BotId, type BotSnap } from "@/types"

export function PageTitle({ title, description, children }: { title: string; description?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  )
}

function Loading() {
  return <div className="grid gap-6 xl:grid-cols-2"><Skeleton className="h-96 w-full" /><Skeleton className="h-96 w-full" /></div>
}

// ---------- Overview ----------
function SummaryCard({ bot }: { bot: BotSnap }) {
  const { logs } = useData()
  const st = bot.status
  const recent = useMemo(() => logs[bot.id].filter((e) => KEY.includes(e.kind) && e.t).slice(-7).reverse(), [logs, bot.id])
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">{bot.name}<BotBadges bot={bot} /></CardTitle>
        <CardDescription>
          {st ? `Day clock ${dayClock(st.time)} · ${st.spawnable ?? "?"} mob-spawnable cells · ${st.torches ?? "?"} torches known` : "Waiting for status"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <StaleAlert bot={bot} />
        <Vitals bot={bot} />
        <GoalBox bot={bot} />
        <Frame src={`/img/${bot.id}/top?t=${st?._img?.top ?? 0}`} pixelated alt="Top-down map" />
        <div className="flex flex-col gap-1">
          <h3 className="mb-1 text-sm font-semibold">Recent events</h3>
          {recent.length === 0 && <p className="text-xs text-muted-foreground">Nothing yet.</p>}
          {recent.map((e) => (
            <div key={e.id} className="grid grid-cols-[3.75rem_5.5rem_1fr] items-start gap-2 font-mono text-xs">
              <span className="text-muted-foreground">{clock(e.t)}</span>
              <Badge variant={badgeVariant(e.kind)} className="max-w-full justify-self-start"><span className="truncate">{e.kind}</span></Badge>
              <span className="break-words">{clean(e)}</span>
            </div>
          ))}
        </div>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" asChild><Link to={`/bot/${bot.id}/live`}>Live view</Link></Button>
        <Button variant="outline" size="sm" asChild><Link to={`/bot/${bot.id}/inventory`}>Inventory</Link></Button>
        <Button variant="outline" size="sm" asChild><Link to={`/bot/${bot.id}/behavior`}>Behavior</Link></Button>
        <Button variant="outline" size="sm" asChild><Link to={`/bot/${bot.id}/structure`}>Structure</Link></Button>
      </CardFooter>
    </Card>
  )
}

export function Overview() {
  const { ready, snap } = useData()
  return (
    <div className="flex flex-col gap-6">
      <PageTitle title="Overview" description="Both bots at a glance. Open a bot from the sidebar for its full views." />
      {!ready || !snap ? <Loading /> : <div className="grid items-start gap-6 xl:grid-cols-2 [&>*]:min-w-0">{BOT_IDS.map((id) => <SummaryCard key={id} bot={snap[id]} />)}</div>}
    </div>
  )
}

// ---------- per-bot pages ----------
type BotCtx = { bot: BotSnap }
const useBot = () => useOutletContext<BotCtx>().bot

export function BotLayout() {
  const { id } = useParams()
  const { ready, snap } = useData()
  if (id !== "ozo" && id !== "smeo") return <Navigate to="/" replace />
  if (!ready || !snap) return <Loading />
  const bot = snap[id as BotId]
  return <Outlet context={{ bot } satisfies BotCtx} />
}

function BotTitle({ page, description }: { page: string; description: string }) {
  const bot = useBot()
  return (
    <PageTitle title={`${bot.name} · ${page}`} description={description}>
      <div className="flex flex-wrap items-center gap-2"><BotBadges bot={bot} /></div>
    </PageTitle>
  )
}

export function BotLive() {
  const bot = useBot()
  const { logs } = useData()
  return (
    <div className="flex flex-col gap-6">
      <BotTitle page="Live" description="Current view, vitals and the latest activity." />
      <StaleAlert bot={bot} />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] [&>*]:min-w-0">
        <Card>
          <CardContent><ViewPanel bot={bot} /></CardContent>
        </Card>
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader><CardTitle>Vitals</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-5">
              <Vitals bot={bot} cols="sm:grid-cols-2" />
              <GoalBox bot={bot} />
              <BagBadges bot={bot} />
            </CardContent>
          </Card>
        </div>
      </div>
      <Card>
        <CardHeader><CardTitle>Live log</CardTitle><CardDescription>Streams as it happens. Switch filters or search below.</CardDescription></CardHeader>
        <CardContent><LogPanel entries={logs[bot.id]} height="h-96" /></CardContent>
      </Card>
    </div>
  )
}

export function BotInventory() {
  const bot = useBot()
  return (
    <div className="flex flex-col gap-6">
      <BotTitle page="Inventory" description="Hotbar, main grid, armor and offhand as of the latest snapshot, and the items both bots have picked up." />
      <Card>
        <CardContent>
          {bot.status ? <InventoryPanel status={bot.status} /> : <Empty><EmptyHeader><EmptyTitle>No data</EmptyTitle><EmptyDescription>No status yet.</EmptyDescription></EmptyHeader></Empty>}
        </CardContent>
      </Card>
      <Card><CardContent><AcquiredPanel id={bot.id} /></CardContent></Card>
    </div>
  )
}

export function BotBehavior() {
  const bot = useBot()
  return (
    <div className="flex flex-col gap-6">
      <BotTitle page="Behavior" description="State graph with the active state highlighted." />
      <Card><CardContent><BehaviorPanel id={bot.id} /></CardContent></Card>
    </div>
  )
}

export function BotReplay() {
  const bot = useBot()
  return (
    <div className="flex flex-col gap-6">
      <BotTitle page="Replay" description="Dashcam clips: the last seconds before a death or big hit, animated top-down." />
      <Card><CardContent><ReplayPanel id={bot.id} /></CardContent></Card>
    </div>
  )
}

export function BotStructure() {
  const bot = useBot()
  return (
    <div className="flex flex-col gap-6">
      <BotTitle page="Structure" description="Mode, modules, skills and standing strategy." />
      <Card><CardContent><StructureView id={bot.id} /></CardContent></Card>
    </div>
  )
}

// ---------- cross-bot pages ----------
function BotPicker({ value, onChange, both = false }: { value: string; onChange: (v: string) => void; both?: boolean }) {
  return (
    <ToggleGroup type="single" variant="outline" size="sm" value={value} onValueChange={(v) => v && onChange(v)}>
      {both && <ToggleGroupItem value="both">Both</ToggleGroupItem>}
      <ToggleGroupItem value="ozo">OzoGo444</ToggleGroupItem>
      <ToggleGroupItem value="smeo">Smeo444</ToggleGroupItem>
    </ToggleGroup>
  )
}

export function Logs() {
  const { ready, logs } = useData()
  const [which, setWhich] = useState("both")
  const entries = useMemo(() => {
    if (which !== "both") return logs[which as BotId]
    return [...logs.ozo, ...logs.smeo].sort((a, b) => (a.t ?? "").localeCompare(b.t ?? "") || a.id - b.id)
  }, [logs, which])
  return (
    <div className="flex flex-col gap-6">
      <PageTitle title="Logs" description="Everything the bots are logging, live.">
        <BotPicker value={which} onChange={setWhich} both />
      </PageTitle>
      {ready ? <Card><CardContent><LogPanel entries={entries} height="h-[calc(100svh-18rem)]" showBot={which === "both"} /></CardContent></Card> : <Skeleton className="h-96 w-full" />}
    </div>
  )
}

export function Memory() {
  const [which, setWhich] = useState<BotId>("ozo")
  return (
    <div className="flex flex-col gap-6">
      <PageTitle title="Memory and data" description="Each bot's saved state and world files. Click a file to read it.">
        <BotPicker value={which} onChange={(v) => setWhich(v as BotId)} />
      </PageTitle>
      <Card><CardContent><MemoryView key={which} id={which} /></CardContent></Card>
    </div>
  )
}
