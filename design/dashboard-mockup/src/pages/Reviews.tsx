import { PlayIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { PageHeader } from "@/components/common"
import { useSim, type BotReview } from "@/sim"

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never")
const SEV = { high: "destructive", med: "warning", low: "secondary" } as const

function BotCard({ b }: { b: BotReview }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{b.name}</CardTitle>
        <CardDescription>{b.updatedAt ? `${b.status} · reviewed ${when(b.updatedAt)}` : "not reviewed yet"}</CardDescription>
        <CardAction><Badge variant={b.open.some((f) => f.severity === "high") ? "destructive" : b.open.length ? "warning" : "success"}>{b.open.length ? `${b.open.length} open` : "Clear"}</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {b.telemetry && <p className="rounded-lg bg-muted/60 p-3 font-mono text-xs text-muted-foreground">{b.telemetry}</p>}
        {b.summary && <p className="text-sm">{b.summary}</p>}
        {b.open.map((f) => (
          <div key={f.title} className="flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex items-start justify-between gap-3">
              <span className="font-medium">{f.title}</span>
              <Badge variant={SEV[f.severity]} className="uppercase">{f.severity}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{f.evidence}</p>
            <p className="rounded-lg bg-primary/5 p-3 text-sm"><span className="mr-2 text-xs font-semibold tracking-wide text-primary uppercase">Suggestion</span>{f.suggestion}</p>
            <span className="text-xs text-muted-foreground">{f.kind}, seen {f.seenRuns}x since {when(f.firstSeen)}</span>
          </div>
        ))}
        {!b.open.length && b.status !== "offline" && <p className="text-sm text-muted-foreground">No open findings.</p>}
      </CardContent>
    </Card>
  )
}

export function Reviews() {
  const { info, reviewer: r, setReviewerInterval, installTask, removeTask, reviewNow, triggers, setTrigger, runTrigger, reviews } = useSim()
  return (
    <>
      <PageHeader title="Claude reviews" description={`Headless runs: claude -p --model ${info.model} (your Claude subscription). Dashboard ${info.attached ? "attached to" : "started at"} ${info.dashboardUrl}.`}>
        <Button onClick={reviewNow} disabled={r.running}><PlayIcon />{r.running ? "Reviewing…" : "Review now"}</Button>
      </PageHeader>

      <section className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Behavior reviewer</CardTitle>
              <CardDescription>
                {r.installed
                  ? `Task "BotBehaviorReviewer": Ready, next run ${when(r.nextRun)}, last run ${when(r.lastRun)} (result ${r.lastResult ?? "?"}). Runs only while you are logged in, window hidden.`
                  : `No scheduled task yet. Install creates one Windows Task Scheduler job named "BotBehaviorReviewer" for your user account (no admin, no password) that runs node reviewer/run.js every N minutes. Remove it here any time.`}
              </CardDescription>
              <CardAction><Badge variant={r.installed ? "success" : "outline"}>{r.installed ? "Installed" : "Not installed"}</Badge></CardAction>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium">Haiku 5.5 (xhigh) spectator review</span>
              <span className="flex-1" />
              <label className="flex items-center gap-2 text-muted-foreground">every <Input type="number" min={1} max={120} value={r.intervalMin} onChange={(e) => setReviewerInterval(Number(e.target.value))} className="w-20" /> min</label>
              <Button variant="outline" onClick={installTask}>{r.installed ? "Reinstall task" : "Install Task Scheduler job"}</Button>
              <Button variant="outline" onClick={removeTask} disabled={!r.installed}>Remove task</Button>
            </CardContent>
          </Card>
          {r.bots.map((b) => <BotCard key={b.name} b={b} />)}
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader><CardTitle>Triggers</CardTitle><CardDescription>Headless Claude jobs the app runs on an interval.</CardDescription></CardHeader>
            <CardContent className="flex flex-col divide-y">
              {triggers.map((t) => (
                <div key={t.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <Switch on={t.enabled} onChange={(v) => setTrigger(t.id, { enabled: v })} label={`Enable ${t.title}`} />
                    <span className="flex-1 font-medium">{t.title}</span>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">every <Input type="number" min={1} max={1440} value={t.intervalMin} onChange={(e) => setTrigger(t.id, { intervalMin: Number(e.target.value) })} className="h-8 w-16" /> min</label>
                    <Button variant="outline" size="sm" disabled={t.running} onClick={() => runTrigger(t.id)}>{t.running ? "Running…" : "Run now"}</Button>
                  </div>
                  <span className="text-xs text-muted-foreground">last run: {when(t.lastRun)} · next: {t.running ? "running" : when(t.nextRun)}</span>
                  {t.lastResult && <span className={t.lastResult.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>{t.lastResult.ok ? "" : "Failed: "}{t.lastResult.summary}</span>}
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Recent reviews</CardTitle><CardDescription>Plain-language notes from each spectator pass.</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-4">
              {reviews.length === 0 && <p className="text-sm text-muted-foreground">No reviews yet. The first one runs shortly after startup.</p>}
              {reviews.map((x) => (
                <div key={x.at} className="flex flex-col gap-1 border-l-2 border-primary/30 pl-4">
                  <span className="text-xs font-medium text-muted-foreground">{when(x.at)}</span>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{x.text}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </section>
    </>
  )
}
