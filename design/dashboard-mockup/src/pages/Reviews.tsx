import { useState } from "react"
import { PlayIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { PageHeader } from "@/components/common"
import { FINDINGS, RECENT_REVIEWS, REVIEW_TRIGGERS } from "@/data"
import { cn } from "@/lib/utils"

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)} className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:ring-3 focus-visible:ring-ring/50", on ? "bg-primary" : "bg-input")}>
      <span className={cn("absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform", on && "translate-x-5")} />
    </button>
  )
}

const SEV = { high: "destructive", med: "warning", low: "secondary" } as const

export function Reviews() {
  const [triggers, setTriggers] = useState(REVIEW_TRIGGERS)
  return (
    <>
      <PageHeader title="Claude reviews" description="Headless Claude runs on your subscription: a spectator that watches both bots, plus other scheduled jobs. Findings stay open until the bot stops doing the thing.">
        <Button><PlayIcon />Review now</Button>
      </PageHeader>

      <section className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Open findings</CardTitle>
              <CardDescription>3 open across both bots, ranked by severity.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {FINDINGS.map((f) => (
                <div key={f.title} className="flex flex-col gap-3 rounded-xl border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-1"><span className="font-medium">{f.title}</span><span className="text-xs text-muted-foreground">{f.bot} · {f.kind} · seen {f.seen}× since {f.since}</span></div>
                    <Badge variant={SEV[f.sev]} className="uppercase">{f.sev}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">{f.evidence}</p>
                  <p className="rounded-lg bg-primary/5 p-3 text-sm"><span className="mr-2 text-xs font-semibold tracking-wide text-primary uppercase">Suggestion</span>{f.suggestion}</p>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Recent reviews</CardTitle><CardDescription>Plain-language notes from each spectator pass.</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-4">
              {RECENT_REVIEWS.map((r) => (
                <div key={r.at} className="flex flex-col gap-1 border-l-2 border-primary/30 pl-4"><span className="text-xs font-medium text-muted-foreground">{r.at}</span><p className="text-sm leading-relaxed">{r.text}</p></div>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Behavior reviewer</CardTitle>
              <CardDescription>Haiku 5.5 spectator review, runs through Windows Task Scheduler while you are logged in.</CardDescription>
              <CardAction><Badge variant="success">Installed</Badge></CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-4 text-sm">
              <div className="grid grid-cols-2 gap-4 rounded-lg bg-muted/60 p-4">
                <div className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">Last run</span><span className="font-medium">2 min ago · ok</span></div>
                <div className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">Next run</span><span className="font-medium">in 8 min</span></div>
              </div>
              <div className="flex items-center gap-3"><span className="text-muted-foreground">Every</span><Input type="number" defaultValue={10} className="w-20" /><span className="text-muted-foreground">minutes</span><span className="flex-1" /><Button variant="outline" size="sm">Remove task</Button></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Triggers</CardTitle><CardDescription>Headless Claude jobs the app runs on an interval.</CardDescription></CardHeader>
            <CardContent className="flex flex-col divide-y">
              {triggers.map((t, i) => (
                <div key={t.id} className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-3">
                    <Switch on={t.enabled} onChange={(v) => setTriggers((ts) => ts.map((x, j) => (j === i ? { ...x, enabled: v } : x)))} />
                    <span className="flex-1 font-medium">{t.title}</span>
                    <span className="text-xs text-muted-foreground">every {t.every} min</span>
                    <Button variant="outline" size="sm" disabled={!t.enabled}>Run now</Button>
                  </div>
                  <span className="pl-14 text-xs text-muted-foreground">last {t.last} · next {t.enabled ? t.next : "off"}</span>
                  {t.summary && <span className="pl-14 text-xs">{t.summary}</span>}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </section>
    </>
  )
}
