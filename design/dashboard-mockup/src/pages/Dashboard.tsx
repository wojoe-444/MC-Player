import { CompassIcon, DrumstickIcon, HeartIcon, SwordsIcon, TargetIcon, SkullIcon, HammerIcon, PickaxeIcon, AlertTriangleIcon, FlaskConicalIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Meter, PageHeader, StatCard } from "@/components/common"
import { BOTS, EVENTS, KPIS, VITALS, type BotId, type Ev } from "@/data"
import { cn } from "@/lib/utils"

const KIND: Record<Ev["kind"], { icon: typeof PickaxeIcon; tone: string }> = {
  mine: { icon: PickaxeIcon, tone: "bg-info/12 text-info" },
  build: { icon: HammerIcon, tone: "bg-primary/12 text-primary" },
  alert: { icon: AlertTriangleIcon, tone: "bg-warning/15 text-warning-foreground dark:text-warning" },
  death: { icon: SkullIcon, tone: "bg-destructive/12 text-destructive" },
  craft: { icon: FlaskConicalIcon, tone: "bg-success/12 text-success" },
  fight: { icon: SwordsIcon, tone: "bg-chart-5/15 text-chart-5" },
  goal: { icon: TargetIcon, tone: "bg-accent text-accent-foreground" },
}

function BotCard({ id }: { id: BotId }) {
  const b = BOTS[id], v = VITALS[id]
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3 text-lg">
          <span className="flex size-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{b.name[0]}</span>
          <span className="flex flex-col leading-tight">{b.name}<span className="text-xs font-normal text-muted-foreground">{b.role} · {v.dim} · {v.clock}</span></span>
        </CardTitle>
        <CardAction><Badge variant="success">Online</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm"><span className="flex items-center gap-2 text-muted-foreground"><HeartIcon className="size-4 text-destructive" />Health</span><span className="font-medium tabular-nums">{v.hp} / 20</span></div>
            <Meter value={v.hp} max={20} tone="danger" />
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm"><span className="flex items-center gap-2 text-muted-foreground"><DrumstickIcon className="size-4 text-warning" />Food</span><span className="font-medium tabular-nums">{v.food} / 20</span></div>
            <Meter value={v.food} max={20} tone="warning" />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 rounded-lg bg-muted/60 p-4 text-sm">
          <div className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">Position</span><span className="font-mono text-xs tabular-nums">{v.pos.join(", ")}</span></div>
          <div className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">Step</span><span className="font-mono text-xs">{v.step}</span></div>
          <div className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">Holding</span><span className="text-xs">{v.held}</span></div>
        </div>
        <div className="flex gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4">
          <TargetIcon className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="flex flex-col gap-1"><span className="text-xs font-semibold tracking-wide text-primary uppercase">Current goal</span><p className="text-sm leading-relaxed">{v.goal}</p></div>
        </div>
      </CardContent>
    </Card>
  )
}

export function Dashboard() {
  return (
    <>
      <PageHeader title="Dashboard" description="Both bots at a glance: what they are doing, how they are doing, and what happened in the last hour.">
        <Button variant="outline"><CompassIcon />Open map</Button>
        <Button>Send command</Button>
      </PageHeader>
      <section className="grid gap-6 sm:grid-cols-2 xl:grid-cols-4">{KPIS.map((k) => <StatCard key={k.label} {...k} />)}</section>
      <section className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_24rem]">
        <BotCard id="ozo" />
        <BotCard id="smeo" />
        <Card className="xl:row-span-1">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>Key events from both bots, newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="relative flex flex-col gap-4 before:absolute before:top-2 before:bottom-2 before:left-4 before:w-px before:bg-border">
              {EVENTS.map((e, i) => {
                const k = KIND[e.kind]
                return (
                  <li key={i} className="relative flex gap-4">
                    <span className={cn("z-[1] flex size-8 shrink-0 items-center justify-center rounded-full ring-4 ring-card", k.tone)}><k.icon className="size-4" /></span>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <p className="text-sm leading-snug">{e.text}</p>
                      <span className="text-xs text-muted-foreground">{BOTS[e.bot].name} · {e.t}</span>
                    </div>
                  </li>
                )
              })}
            </ol>
          </CardContent>
        </Card>
      </section>
    </>
  )
}
