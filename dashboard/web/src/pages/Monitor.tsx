// Dashboard, Progress, Logs and the per-bot pages. The panels inside are the shipped components, unchanged in behaviour;
// this file only re-composes them (layout, hierarchy, headings) in the new design.
import { useMemo, useState, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { ArrowRightIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { PageHeader, StatCard } from "@/components/common"
import { AcquiredPanel } from "@/components/AcquiredPanel"
import { BehaviorPanel } from "@/components/BehaviorPanel"
import { BagBadges, BotBadges, dayClock, GoalBox, StaleAlert, Vitals } from "@/components/BotParts"
import { InventoryPanel } from "@/components/InventoryPanel"
import { badgeVariant, clean, clock, KEY, LogPanel } from "@/components/LogPanel"
import { ProgressBody, useProgress } from "@/components/ProgressPanel"
import { ReplayPanel } from "@/components/ReplayPanel"
import { MemoryView, StructureView } from "@/components/StructurePanel"
import { Frame, ViewPanel } from "@/components/ViewPanel"
import { fmtOnline, fmtRate, perHour, pooledPerHour, round1 } from "@/lib/rates"
import { useBotSelection } from "@/bot"
import { useData } from "@/DashboardContext"
import { BOT_IDS, type BotId, type BotSnap } from "@/types"

function Loading() {
  return <div className="grid gap-6 xl:grid-cols-2"><Skeleton className="h-96 w-full" /><Skeleton className="h-96 w-full" /></div>
}

// ---------------------------------------------------------------- Dashboard
// The four KPI cards are rates: per player-hour (one bot online for one hour), over the bots' online time that was recorded
// (lib/rates.ts). The raw 7-day total and the online time behind it sit on the card's second line.
type KpiKey = "items" | "active" | "deaths" | "stalled"
const KPIS: { key: KpiKey; label: string; higherIsBetter: boolean; unit: string; total: string }[] = [
  { key: "items", label: "Items picked up per player-hour", higherIsBetter: true, unit: "/h", total: "items" },
  { key: "active", label: "Active min per player-hour", higherIsBetter: true, unit: " min/h", total: "active min" },
  { key: "deaths", label: "Deaths per player-hour", higherIsBetter: false, unit: "/h", total: "deaths" },
  { key: "stalled", label: "Stalled min per player-hour", higherIsBetter: false, unit: " min/h", total: "stalled min" },
]

function useKpis() {
  const { data } = useProgress()
  return useMemo(() => {
    if (!data) return null
    type Day = { online: number } & Record<KpiKey, number>
    const byDate = new Map<string, Day>()
    for (const id of BOT_IDS) for (const d of data.bots[id].days) {
      if (!d.onlineMin) continue                       // no online time recorded: this bot-day is left out of the numerator as well as the denominator
      const e = byDate.get(d.date) ?? { online: 0, items: 0, active: 0, deaths: 0, stalled: 0 }
      e.online += d.onlineMin; e.items += d.items ?? 0; e.active += d.activeMin ?? 0; e.deaths += d.deaths ?? 0; e.stalled += d.stalledMin ?? 0
      byDate.set(d.date, e)
    }
    const days = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-8).map(([, v]) => v)
    if (days.length < 1) return null
    const week = days.slice(-7), today = days[days.length - 1]
    return KPIS.map(({ key, label, higherIsBetter, unit, total }) => {
      const pooled = pooledPerHour(week.map((d) => ({ value: d[key], onlineMin: d.online })))
      const todayRate = perHour(today[key], today.online)
      const series = days.map((d) => perHour(d[key], d.online)).filter((r): r is number => r != null)
      const diff = todayRate != null && pooled.rate != null ? todayRate - pooled.rate : null
      return {
        label: `${label} (7d)`,
        value: pooled.rate == null ? "–" : fmtRate(pooled.rate) + unit,
        delta: diff == null ? "too little online time today" : `${diff >= 0 ? "+" : "-"}${fmtRate(Math.abs(diff))}${unit} today vs 7d`,
        good: diff == null ? true : higherIsBetter ? diff >= 0 : diff <= 0,
        spark: series.length >= 2 ? series : [0, 0],
        note: `${round1(pooled.total)} ${total} in ${fmtOnline(pooled.onlineMin)} online`,
      }
    })
  }, [data])
}

function SummaryCard({ bot }: { bot: BotSnap }) {
  const { logs } = useData()
  const st = bot.status
  const recent = useMemo(() => logs[bot.id].filter((e) => KEY.includes(e.kind) && e.t).slice(-7).reverse(), [logs, bot.id])
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-3 text-lg">
          <span className="flex size-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{bot.name[0]}</span>
          {bot.name}
        </CardTitle>
        <CardDescription>
          {st ? `Day clock ${dayClock(st.time)} · ${st.spawnable ?? "?"} mob-spawnable cells · ${st.torches ?? "?"} torches known` : "Waiting for status"}
        </CardDescription>
        <CardAction className="flex flex-wrap justify-end gap-2"><BotBadges bot={bot} /></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <StaleAlert bot={bot} />
        <Vitals bot={bot} />
        <GoalBox bot={bot} />
        <Frame src={`/img/${bot.id}/top?t=${st?._img?.top ?? 0}`} pixelated alt="Top-down map" />
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Recent events</h3>
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
        {([["live", "Live view"], ["inventory", "Inventory"], ["behavior", "Behavior"], ["structure", "Structure"]] as const).map(([to, label]) => (
          <OpenBot key={to} id={bot.id} to={`/${to}`}>{label}</OpenBot>
        ))}
      </CardFooter>
    </Card>
  )
}

function OpenBot({ id, to, children }: { id: BotId; to: string; children: ReactNode }) {
  const { setBot } = useBotSelection()
  return <Button variant="outline" size="sm" asChild><Link to={to} onClick={() => setBot(id)}>{children}<ArrowRightIcon data-icon="inline-end" /></Link></Button>
}

export function Dashboard() {
  const { ready, snap } = useData()
  const kpis = useKpis()
  return (
    <>
      <PageHeader title="Dashboard" description="Both bots at a glance: what they are doing, how they are doing, and what happened recently. Open a bot's full views from its card or the sidebar." />
      {kpis && <section className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">{kpis.map((k) => <StatCard key={k.label} {...k} />)}</section>}
      {!ready || !snap ? <Loading /> : <section className="grid items-start gap-6 xl:grid-cols-2 [&>*]:min-w-0">{BOT_IDS.map((id) => <SummaryCard key={id} bot={snap[id]} />)}</section>}
    </>
  )
}

// ---------------------------------------------------------------- Progress, Logs
export function Progress() {
  const { bot } = useBotSelection()
  return (
    <>
      <PageHeader title="Progress" description="How far the bot is along the roadmap, what it has built and how its days go, from the bot's own records. Choose the bot in the top bar." />
      <ProgressBody key={bot} id={bot} />
    </>
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
    <>
      <PageHeader title="Logs" description="Everything the bots are logging, live.">
        <ToggleGroup type="single" variant="outline" value={which} onValueChange={(v) => v && setWhich(v)}>
          <ToggleGroupItem value="both">Both</ToggleGroupItem>
          <ToggleGroupItem value="ozo">OzoGo444</ToggleGroupItem>
          <ToggleGroupItem value="smeo">Smeo444</ToggleGroupItem>
        </ToggleGroup>
      </PageHeader>
      {ready ? <Card><CardContent><LogPanel entries={entries} height="h-[calc(100svh-22rem)] min-h-96" showBot={which === "both"} /></CardContent></Card> : <Skeleton className="h-96 w-full" />}
    </>
  )
}

// ---------------------------------------------------------------- selected-bot pages
function useSelected() {
  const { ready, snap } = useData()
  const { bot: id } = useBotSelection()
  return { bot: ready && snap ? snap[id] : null, id }
}

function BotPage({ page, description, children }: { page: string; description: string; children: (bot: BotSnap) => ReactNode }) {
  const { bot } = useSelected()
  if (!bot) return <Loading />
  return (
    <>
      <PageHeader title={`${bot.name} · ${page}`} description={description}>
        <BotBadges bot={bot} />
      </PageHeader>
      {children(bot)}
    </>
  )
}

export function Live() {
  const { logs } = useData()
  return (
    <BotPage page="Live view" description="Current view, vitals and the latest activity.">
      {(bot) => (
        <>
          <StaleAlert bot={bot} />
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] [&>*]:min-w-0">
            <Card><CardContent><ViewPanel bot={bot} /></CardContent></Card>
            <Card>
              <CardHeader><CardTitle>Vitals</CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-6">
                <Vitals bot={bot} cols="sm:grid-cols-2" />
                <GoalBox bot={bot} />
                <BagBadges bot={bot} />
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle>Live log</CardTitle><CardDescription>Streams as it happens. Switch filters or search below.</CardDescription></CardHeader>
            <CardContent><LogPanel entries={logs[bot.id]} height="h-96" /></CardContent>
          </Card>
        </>
      )}
    </BotPage>
  )
}

export function Inventory() {
  return (
    <BotPage page="Inventory" description="Hotbar, main grid, armor and offhand as of the latest snapshot, and the items both bots have picked up.">
      {(bot) => (
        <>
          <Card>
            <CardHeader><CardTitle>Carried items</CardTitle><CardDescription>What the bot is holding right now.</CardDescription></CardHeader>
            <CardContent>
              {bot.status ? <InventoryPanel status={bot.status} /> : <Empty><EmptyHeader><EmptyTitle>No data</EmptyTitle><EmptyDescription>No status yet.</EmptyDescription></EmptyHeader></Empty>}
            </CardContent>
          </Card>
          <Card><CardContent><AcquiredPanel id={bot.id} /></CardContent></Card>
        </>
      )}
    </BotPage>
  )
}

export const Replay = () => (
  <BotPage page="Replay" description="Dashcam clips: the last seconds before a death or big hit, animated top-down.">
    {(bot) => <Card><CardContent><ReplayPanel id={bot.id} /></CardContent></Card>}
  </BotPage>
)
export const Behavior = () => (
  <BotPage page="Behavior" description="State graph with the active state highlighted.">
    {(bot) => <Card><CardContent><BehaviorPanel id={bot.id} /></CardContent></Card>}
  </BotPage>
)
export const Structure = () => (
  <BotPage page="Structure" description="Mode, modules, skills and standing strategy.">
    {(bot) => <Card><CardContent><StructureView id={bot.id} /></CardContent></Card>}
  </BotPage>
)
export function Memory() {
  const { id } = useSelected()
  return (
    <>
      <PageHeader title="Memory and data" description="The bot's saved state and world files. Click a file to read it." />
      <Card><CardContent><MemoryView key={id} id={id} /></CardContent></Card>
    </>
  )
}
