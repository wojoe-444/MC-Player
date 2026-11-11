import { useState } from "react"
import { PlayIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { PageHeader } from "@/components/common"
import { NeedsApp } from "@/components/common"
import { useApp, type BotReview } from "@/botapp"

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "never")
// reviews are stored as 2026-11-11T02-05-18-000Z; turn the file-name stamp back into an ISO time
const stamp = (at: string) => at.replace(/^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d+Z)$/, "$1:$2:$3.$4")
const SEV = { high: "destructive", med: "warning", low: "secondary" } as const

function BotCard({ b }: { b: BotReview }) {
  const f = b.findings, tel = b.telemetry
  const open = f?.open ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle>{b.name}</CardTitle>
        <CardDescription>{f ? `${f.status} · reviewed ${when(f.updatedAt)}` : "not reviewed yet"}</CardDescription>
        <CardAction><Badge variant={open.some((x) => x.severity === "high") ? "destructive" : open.length ? "warning" : "success"}>{open.length ? `${open.length} open` : "Clear"}</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {tel?.last1min && <p className="rounded-lg bg-muted/60 p-3 font-mono text-xs text-muted-foreground">{`telemetry: ${tel.last1min.jumpsPerMin} jumps/min, ${tel.last1min.blocksWalked} blocks walked, ${tel.last1min.idleSeconds}s idle in the last minute; ${tel.flags.length} detector flag(s) active`}</p>}
        {f?.summary && <p className="text-sm">{f.summary}</p>}
        {open.map((x) => (
          <div key={x.title} className="flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex items-start justify-between gap-3">
              <span className="font-medium">{x.title}</span>
              <Badge variant={SEV[x.severity] ?? "secondary"} className="uppercase">{x.severity}</Badge>
            </div>
            <p className="text-sm whitespace-pre-wrap text-muted-foreground">{x.evidence}</p>
            <p className="rounded-lg bg-primary/5 p-3 text-sm"><span className="mr-2 text-xs font-semibold tracking-wide text-primary uppercase">Suggestion</span>{x.suggestion}</p>
            <span className="text-xs text-muted-foreground">{x.kind}, seen {x.seenRuns}x since {when(x.firstSeen)}</span>
          </div>
        ))}
        {f && !open.length && f.status !== "offline" && <p className="text-sm text-muted-foreground">No open findings.</p>}
      </CardContent>
    </Card>
  )
}

export function Reviews() {
  const app = useApp()
  const { state, reviewer: r, reviewerRunning, reviewNow, installReviewer, removeReviewer, setTrigger, runTrigger } = app
  const [minutes, setMinutes] = useState(10)
  const [busy, setBusy] = useState(false)
  if (!app.available) return <NeedsApp title="Claude reviews" />
  const t = r?.task
  const install = async () => {
    setBusy(true)
    const err = await installReviewer(minutes)
    setBusy(false)
    if (err) alert("Could not install: " + err)
  }
  return (
    <>
      <PageHeader title="Claude reviews" description={state ? `Headless runs: claude -p --model ${state.claude.model} (your Claude subscription). Dashboard ${state.dashboard.attached ? "attached to" : "started at"} ${state.dashboard.url}.` : "Headless Claude runs that watch the bots."}>
        <Button onClick={reviewNow} disabled={reviewerRunning || !r?.available}><PlayIcon />{reviewerRunning ? "Reviewing…" : "Review now"}</Button>
      </PageHeader>

      <section className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Behavior reviewer</CardTitle>
              <CardDescription>
                {!r ? "Loading…" : !r.available ? "The reviewer folder was not found next to the app."
                  : t?.installed ? `Task "${r.taskName}": ${t.status || "installed"}, next run ${t.nextRun || "?"}, last run ${t.lastRun || "never"} (result ${t.lastResult ?? "?"}). Runs only while you are logged in, window hidden.`
                    : t?.unsupported ? 'Task Scheduler is Windows-only; "Review now" still works.'
                      : `No scheduled task yet. Install creates one Windows Task Scheduler job named "${r.taskName}" for your user account (no admin, no password) that runs node reviewer/run.js every N minutes. Remove it here any time.`}
              </CardDescription>
              <CardAction><Badge variant={t?.installed ? "success" : "outline"}>{t?.installed ? "Installed" : "Not installed"}</Badge></CardAction>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3 text-sm">
              <span className="font-medium">Haiku 5.5 (xhigh) spectator review</span>
              <span className="flex-1" />
              <label className="flex items-center gap-2 text-muted-foreground">every <Input type="number" min={1} max={120} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="w-20" /> min</label>
              <Button variant="outline" onClick={install} disabled={busy || !r?.available}>{t?.installed ? "Reinstall task" : "Install Task Scheduler job"}</Button>
              <Button variant="outline" onClick={removeReviewer} disabled={!t?.installed}>Remove task</Button>
            </CardContent>
          </Card>
          {r?.bots.map((b) => <BotCard key={b.id} b={b} />)}
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader><CardTitle>Triggers</CardTitle><CardDescription>Headless Claude jobs the app runs on an interval.</CardDescription></CardHeader>
            <CardContent className="flex flex-col divide-y">
              {state?.triggers.map((x) => (
                <div key={x.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <Switch on={x.enabled} onChange={(v) => setTrigger(x.id, { enabled: v })} label={`Enable ${x.title}`} />
                    <span className="flex-1 font-medium">{x.title}</span>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">every <Input type="number" min={1} max={1440} defaultValue={x.intervalMin} key={x.intervalMin} onBlur={(e) => { const n = Number(e.target.value); if (n !== x.intervalMin) setTrigger(x.id, { intervalMin: n }) }} className="h-8 w-16" /> min</label>
                    <Button variant="outline" size="sm" disabled={x.running} onClick={() => runTrigger(x.id)}>{x.running ? "Running…" : "Run now"}</Button>
                  </div>
                  <span className="text-xs text-muted-foreground">last run: {when(x.lastRun)} · next: {x.running ? "running" : when(x.nextRun)}</span>
                  {x.lastResult && <span className={x.lastResult.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>{x.lastResult.ok ? "" : "Failed: "}{x.lastResult.summary}</span>}
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Recent reviews</CardTitle><CardDescription>Plain-language notes from each spectator pass.</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-4">
              {state && state.reviews.length === 0 && <p className="text-sm text-muted-foreground">No reviews yet. The first one runs shortly after startup.</p>}
              {state?.reviews.map((x) => (
                <div key={x.at} className="flex flex-col gap-1 border-l-2 border-primary/30 pl-4">
                  <span className="text-xs font-medium text-muted-foreground">{when(stamp(x.at))}</span>
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
