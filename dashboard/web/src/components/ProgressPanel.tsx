import { useEffect, useState } from "react"
import { ChevronRightIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ago } from "@/useDashboard"
import type { BotProgress, BuildRow, GameDay, Progress, RealDay, RoadmapPhase } from "@/types"

export function useProgress() {
  const [data, setData] = useState<Progress | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    const load = () => fetch("/api/progress").then((r) => r.json()).then((d: Progress) => { if (live) { setData(d); setFailed(false) } }).catch(() => live && setFailed(true))
    load()
    const t = setInterval(load, 20_000)
    return () => { live = false; clearInterval(t) }
  }, [])
  return { data, failed }
}

const dash = <span className="text-muted-foreground">–</span>
const num = (n: number | null | undefined, digits = 0) => (n == null ? dash : n === 0 ? <span className="text-muted-foreground">0</span> : n.toFixed(digits))
const since = (iso: string | null | undefined) => (iso ? ago(Date.now() - Date.parse(iso)) : "never")

// ---------------------------------------------------------------- roadmap
// One stacked bar per phase: done, open (measured, no evidence yet) and not measured (nothing records it yet). A missing record is never drawn as done or as failed.
function PhaseBar({ p }: { p: RoadmapPhase }) {
  const open = p.measured - p.done, unmeasured = p.total - p.measured
  const w = (n: number) => (p.total ? `${(100 * n) / p.total}%` : "0%")
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${p.done} done, ${open} open, ${unmeasured} not measured of ${p.total}`}>
      <div className="h-full bg-primary" style={{ width: w(p.done) }} />
      <div className="h-full bg-muted-foreground/40" style={{ width: w(open) }} />
    </div>
  )
}

const STATUS_LABEL = { done: "Done", open: "Open", unmeasured: "Not measured" } as const

function PhaseRow({ p }: { p: RoadmapPhase }) {
  const [openRow, setOpenRow] = useState(false)
  const open = p.measured - p.done, unmeasured = p.total - p.measured
  return (
    <Collapsible open={openRow} onOpenChange={setOpenRow} className="rounded-lg border">
      <CollapsibleTrigger className="flex w-full items-center gap-3 px-3 py-3 text-left" disabled={p.total === 0}>
        <ChevronRightIcon className={`size-4 shrink-0 text-muted-foreground transition-transform ${openRow ? "rotate-90" : ""} ${p.total === 0 ? "opacity-30" : ""}`} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="font-medium">Phase {p.id}: {p.name}</span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {p.total === 0 ? "nothing measures this phase yet" : `${p.done} done · ${open} open · ${unmeasured} not measured`}
            </span>
          </div>
          <PhaseBar p={p} />
          <span className="text-xs text-muted-foreground">{p.blurb}</span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col divide-y border-t">
          {p.items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <Badge variant={i.status === "done" ? "default" : i.status === "open" ? "secondary" : "outline"} className="mt-0.5 w-24">{STATUS_LABEL[i.status]}</Badge>
              <span className="min-w-0 flex-1">
                <span className="mr-2 font-mono text-xs text-muted-foreground">{i.id}</span>{i.title}
                {i.needs && <span className="block text-xs text-muted-foreground">Needs a record: {i.needs}</span>}
              </span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function RoadmapCard({ bot }: { bot: BotProgress }) {
  const rm = bot.roadmap
  const measured = rm ? rm.phases.reduce((n, p) => n + p.measured, 0) : 0
  const total = rm ? rm.phases.reduce((n, p) => n + p.total, 0) : 0
  const done = rm ? rm.phases.reduce((n, p) => n + p.done, 0) : 0
  return (
    <Card>
      <CardHeader>
        <CardTitle>Roadmap</CardTitle>
        <CardDescription>
          {rm
            ? `${done} of ${measured} measured items done. ${total - measured} of ${total} items have no record to measure yet, so they count neither way. ${
                rm.source === "bot" ? `Written by the bot ${since(rm.at)}.` : rm.source === "live" ? "Worked out just now from the bot's saved records (its roadmap module has not written a file yet)." : `The bot's last file is old (${since(rm.at)}).`}`
            : "No roadmap file and no records to work it out from yet."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rm ? rm.phases.map((p) => <PhaseRow key={p.id} p={p} />) : (
          <Empty><EmptyHeader><EmptyTitle>Nothing to show</EmptyTitle><EmptyDescription>The bot writes roadmap.json under brain/state every 10 minutes once it runs a version with the roadmap module.</EmptyDescription></EmptyHeader></Empty>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------- builds
const pos = (p: number[] | null) => (p ? p.join(", ") : "–")
function statusBadge(b: BuildRow) {
  switch (b.status) {
    case "passes": return <Badge variant="secondary">Passes inspection</Badge>
    case "faults": return <Badge variant="destructive">{b.inspection?.faults ?? "?"} fault{b.inspection?.faults === 1 ? "" : "s"}</Badge>
    case "unchecked": return <Badge variant="outline">Not inspected</Badge>
    case "working": return <Badge variant="secondary">Working</Badge>
    case "digging": return <Badge variant="outline">In progress</Badge>
    default: return <Badge variant="outline">Built</Badge>
  }
}

export function BuildsCard({ shared, own, registryFound }: { shared: BuildRow[]; own: BuildRow[]; registryFound: boolean }) {
  const rows = [...shared, ...own]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Built structures</CardTitle>
        <CardDescription>Shafts and rooms from the registry both bots share, with the verdict of the bot's own look at its blocks (only the mob farm is inspected so far), plus the farms this bot records itself.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty><EmptyHeader><EmptyTitle>No structures recorded</EmptyTitle><EmptyDescription>{registryFound ? "The registry has no shafts or rooms yet." : "No registry file found next to the bot folders (set BOT_REGISTRY to point at it)."}</EmptyDescription></EmptyHeader></Empty>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow><TableHead>Structure</TableHead><TableHead>Where (x, y, z)</TableHead><TableHead>Health</TableHead><TableHead className="hidden md:table-cell">Details</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="align-top">
                      <div className="font-medium">{b.label}</div>
                      <div className="text-xs text-muted-foreground">{b.kind}{b.by ? ` · by ${b.by}` : ""}{b.at ? ` · ${since(b.at)}` : ""}</div>
                    </TableCell>
                    <TableCell className="align-top font-mono text-xs tabular-nums">{pos(b.pos)}</TableCell>
                    <TableCell className="align-top">
                      {statusBadge(b)}
                      {b.inspection && b.inspection.headline.length > 0 && b.status === "faults" && (
                        <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">{b.inspection.headline.map((h) => <li key={h}>{h}</li>)}</ul>
                      )}
                      {b.inspection && b.inspection.warns > 0 && <div className="mt-1 text-xs text-muted-foreground">{b.inspection.warns} warning{b.inspection.warns === 1 ? "" : "s"}</div>}
                    </TableCell>
                    <TableCell className="hidden align-top text-xs text-muted-foreground md:table-cell">
                      {[b.depth != null ? `${b.depth} deep` : null, b.chests != null ? `${b.chests} chest${b.chests === 1 ? "" : "s"}` : null, b.hasReset ? "reset-gear chest" : null, b.detail || null].filter(Boolean).join(" · ") || "–"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ---------------------------------------------------------------- per-day numbers
function Bar({ value, max, label }: { value: number | null; max: number; label?: string }) {
  if (value == null) return dash
  return (
    <span className="flex items-center justify-end gap-2" title={label}>
      <span className="hidden h-2 w-20 overflow-hidden rounded-full bg-muted sm:block"><span className="block h-full rounded-full bg-primary" style={{ width: `${max ? (100 * value) / max : 0}%` }} /></span>
      <span className="w-7 text-right tabular-nums">{value}</span>
    </span>
  )
}

export function GameDaysCard({ days }: { days: GameDay[] | null }) {
  const rows = (days ?? []).slice().reverse()
  const maxIron = Math.max(1, ...rows.map((d) => d.iron)), maxIng = Math.max(1, ...rows.map((d) => d.ingots))
  const total = (k: "iron" | "ingots" | "deaths" | "tunnels") => rows.filter((d) => d.done).reduce((n, d) => n + d[k], 0)
  const finished = rows.filter((d) => d.done).length
  return (
    <Card>
      <CardHeader>
        <CardTitle>Per in-game day</CardTitle>
        <CardDescription>
          Iron mined, ingots smelted, tunnels dug and deaths, as the bot counts them itself (a game day is about 20 real minutes).
          {finished > 0 ? ` Over the last ${finished} finished days: ${total("iron")} iron, ${total("ingots")} ingots, ${total("deaths")} deaths, an average of ${(total("iron") / finished).toFixed(1)} iron a day.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty><EmptyHeader><EmptyTitle>No days counted yet</EmptyTitle><EmptyDescription>The bot adds a row to autopilot-state.json at the end of each in-game day.</EmptyDescription></EmptyHeader></Empty>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow><TableHead>Day</TableHead><TableHead className="text-right">Iron</TableHead><TableHead className="text-right">Ingots</TableHead><TableHead className="text-right">Tunnels</TableHead><TableHead className="text-right">Deaths</TableHead><TableHead className="hidden md:table-cell">Armor</TableHead><TableHead className="hidden lg:table-cell">Commit</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((d) => (
                  <TableRow key={d.day}>
                    <TableCell className="font-medium">{d.day}{!d.done && <span className="ml-2 text-xs font-normal text-muted-foreground">in progress</span>}</TableCell>
                    <TableCell><Bar value={d.iron} max={maxIron} /></TableCell>
                    <TableCell><Bar value={d.ingots} max={maxIng} /></TableCell>
                    <TableCell className="text-right tabular-nums">{num(d.tunnels)}</TableCell>
                    <TableCell className={`text-right tabular-nums ${d.deaths ? "font-medium text-destructive" : ""}`}>{num(d.deaths)}</TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{d.armor ?? "–"}</TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">{d.commits.length ? d.commits.join(" → ") : "–"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function RealDaysCard({ days, hasJournal }: { days: RealDay[]; hasJournal: boolean }) {
  const rows = days.slice().reverse()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Per real day</CardTitle>
        <CardDescription>
          Deaths, stalled minutes and the items picked up, per calendar day (UTC), from the bot's journal. Days before the journal started show only what the pickup log proves, and a dash where nothing was recorded.
          {!hasJournal && " The journal starts once the bot restarts on the code that writes it."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty><EmptyHeader><EmptyTitle>No daily records yet</EmptyTitle><EmptyDescription>Nothing in the journal or the pickup log for this bot.</EmptyDescription></EmptyHeader></Empty>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead><TableHead className="text-right">Deaths</TableHead><TableHead className="text-right" title="Minutes the watchdog counted as stalled">Stalled min</TableHead>
                  <TableHead className="text-right">Alarms</TableHead><TableHead className="text-right" title="High-severity detector flags">High flags</TableHead>
                  <TableHead className="text-right">Iron</TableHead><TableHead className="text-right">Ingots</TableHead><TableHead className="text-right">Diamonds</TableHead>
                  <TableHead className="hidden lg:table-cell">Most time on</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((d) => (
                  <TableRow key={d.date}>
                    <TableCell className="font-medium">{d.date}{!d.journal && <span className="ml-2 text-xs font-normal text-muted-foreground">pickups only</span>}</TableCell>
                    <TableCell className={`text-right tabular-nums ${d.deaths ? "font-medium text-destructive" : ""}`}>{num(d.deaths)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(d.stalledMin, 1)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(d.alarms)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(d.flagsHigh)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(d.iron)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(d.ingots)}</TableCell>
                    <TableCell className="text-right tabular-nums">{num(d.diamonds)}</TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">{d.topSteps.length ? d.topSteps.slice(0, 3).map((s) => `${s.id} ${Math.round(s.minutes)}m`).join(", ") : "–"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function ProgressBody({ id }: { id: "ozo" | "smeo" }) {
  const { data, failed } = useProgress()
  if (!data) return failed ? <p className="text-sm text-muted-foreground">Could not load progress from the dashboard server.</p> : <div className="flex flex-col gap-6"><Skeleton className="h-80 w-full" /><Skeleton className="h-60 w-full" /></div>
  const bot = data.bots[id]
  return (
    <div className="flex flex-col gap-6">
      <RoadmapCard bot={bot} />
      <BuildsCard shared={data.builds} own={bot.ownBuilds} registryFound={data.registry.found} />
      <GameDaysCard days={bot.gameDays} />
      <RealDaysCard days={bot.days} hasJournal={bot.hasJournal} />
    </div>
  )
}
