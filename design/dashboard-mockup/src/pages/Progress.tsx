import { useState } from "react"
import { CheckCircle2Icon, ChevronRightIcon, CircleDashedIcon, CircleDotIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { PageHeader } from "@/components/common"
import { BUILDS, GAME_DAYS, ROADMAP, type Build, type Phase } from "@/data"
import { cn } from "@/lib/utils"

function PhaseBar({ p }: { p: Phase }) {
  const total = p.done + p.open + p.unmeasured
  const w = (n: number) => `${(100 * n) / total}%`
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full bg-success" style={{ width: w(p.done) }} />
      <div className="h-full bg-primary/50" style={{ width: w(p.open) }} />
    </div>
  )
}

const ICON = {
  done: <CheckCircle2Icon className="size-4 text-success" />,
  open: <CircleDotIcon className="size-4 text-primary" />,
  unmeasured: <CircleDashedIcon className="size-4 text-muted-foreground" />,
}

function PhaseRow({ p, defaultOpen }: { p: Phase; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen)
  const total = p.done + p.open + p.unmeasured
  const pct = Math.round((100 * p.done) / total)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border bg-card">
      <CollapsibleTrigger disabled={!p.items.length} className="flex w-full items-center gap-4 p-4 text-left">
        <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-lg text-sm font-semibold", pct === 100 ? "bg-success/12 text-success" : "bg-accent text-accent-foreground")}>{p.id}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <span className="font-medium">{p.name}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{p.done} done · {p.open} open · {p.unmeasured} not measured</span>
          </div>
          <PhaseBar p={p} />
          <span className="text-xs text-muted-foreground">{p.blurb}</span>
        </div>
        <span className="w-12 text-right text-lg font-semibold tabular-nums">{pct}%</span>
        <ChevronRightIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90", !p.items.length && "opacity-30")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col divide-y border-t">
          {p.items.map((i) => (
            <li key={i.id} className="flex items-start gap-3 px-4 py-3 text-sm">
              <span className="mt-0.5">{ICON[i.status]}</span>
              <span className="w-10 font-mono text-xs text-muted-foreground">{i.id}</span>
              <span className="flex-1">{i.title}{i.needs && <span className="block text-xs text-muted-foreground">Needs a record: {i.needs}</span>}</span>
              <Badge variant={i.status === "done" ? "success" : i.status === "open" ? "info" : "outline"}>{i.status === "unmeasured" ? "Not measured" : i.status === "done" ? "Done" : "Open"}</Badge>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

function BuildBadge({ b }: { b: Build }) {
  switch (b.status) {
    case "passes": return <Badge variant="success">Passes inspection</Badge>
    case "faults": return <Badge variant="destructive">{b.faults?.length ?? 0} faults</Badge>
    case "working": return <Badge variant="info">Working</Badge>
    case "unchecked": return <Badge variant="outline">Not inspected</Badge>
    default: return <Badge variant="secondary">Built</Badge>
  }
}

export function Progress() {
  const [bot, setBot] = useState("ozo")
  const done = ROADMAP.reduce((n, p) => n + p.done, 0), all = ROADMAP.reduce((n, p) => n + p.done + p.open + p.unmeasured, 0)
  const maxIron = Math.max(...GAME_DAYS.map((d) => d.iron))
  return (
    <>
      <PageHeader title="Progress" description="Where the bot is on the roadmap, what it has built, and how each in-game day went. A missing record is never drawn as done or as failed.">
        <ToggleGroup type="single" variant="outline" value={bot} onValueChange={(v) => v && setBot(v)}>
          <ToggleGroupItem value="ozo">OzoGo444</ToggleGroupItem>
          <ToggleGroupItem value="smeo">Smeo444</ToggleGroupItem>
        </ToggleGroup>
      </PageHeader>

      <section className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Roadmap</CardTitle>
            <CardDescription>{done} of {all} items done. Written by the bot 4 minutes ago.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="mb-2 flex items-center gap-6 text-xs text-muted-foreground">
              <span className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-success" />Done</span>
              <span className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-primary/50" />Open</span>
              <span className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-muted-foreground/30" />Not measured</span>
            </div>
            {ROADMAP.map((p, i) => <PhaseRow key={p.id} p={p} defaultOpen={i === 1} />)}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Built structures</CardTitle>
              <CardDescription>Verdicts come from the bot's own look at its blocks.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {BUILDS.map((b) => (
                <div key={b.label} className="flex flex-col gap-2 rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-0.5"><span className="font-medium">{b.label}</span><span className="text-xs text-muted-foreground">{b.kind} · {b.by} · {b.when}</span></div>
                    <BuildBadge b={b} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 text-xs text-muted-foreground"><span className="font-mono tabular-nums">{b.pos.join(", ")}</span><span>{b.detail}</span></div>
                  {b.faults && <ul className="list-disc pl-5 text-xs text-destructive">{b.faults.map((f) => <li key={f}>{f}</li>)}</ul>}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Per in-game day</CardTitle>
          <CardDescription>Iron mined, ingots smelted, tunnels dug and deaths as the bot counts them. A game day is about 20 real minutes.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow><TableHead className="pl-4">Day</TableHead><TableHead>Iron</TableHead><TableHead className="text-right">Ingots</TableHead><TableHead className="text-right">Tunnels</TableHead><TableHead className="text-right">Deaths</TableHead><TableHead>Armor</TableHead><TableHead className="pr-4 text-right">Commit</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {GAME_DAYS.map((d) => (
                  <TableRow key={d.day}>
                    <TableCell className="pl-4 font-medium">Day {d.day}{!d.done && <Badge variant="info" className="ml-2">In progress</Badge>}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-3"><span className="h-2 w-32 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-chart-1" style={{ width: `${(100 * d.iron) / maxIron}%` }} /></span><span className="w-6 tabular-nums">{d.iron}</span></span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{d.ingots}</TableCell>
                    <TableCell className="text-right tabular-nums">{d.tunnels}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", d.deaths ? "font-semibold text-destructive" : "text-muted-foreground")}>{d.deaths}</TableCell>
                    <TableCell><Badge variant="secondary">{d.armor}</Badge></TableCell>
                    <TableCell className="pr-4 text-right font-mono text-xs text-muted-foreground">{d.commit}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </>
  )
}
