import { useState } from "react"
import { DownloadIcon, RefreshCwIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { PageHeader } from "@/components/common"
import { cn } from "@/lib/utils"

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)} className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:ring-3 focus-visible:ring-ring/50", on ? "bg-primary" : "bg-input")}>
      <span className={cn("absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform", on && "translate-x-5")} />
    </button>
  )
}

function Row({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-0.5"><span className="text-sm font-medium">{title}</span><span className="text-xs text-muted-foreground">{hint}</span></div>
      {children}
    </div>
  )
}

export function Settings() {
  const [s, setS] = useState({ stale: true, deaths: true, review: true, autostart: false })
  const set = (k: keyof typeof s) => (v: boolean) => setS((x) => ({ ...x, [k]: v }))
  return (
    <>
      <PageHeader title="Settings" description="App updates, notifications and where the dashboard looks for the bots." />
      <section className="grid items-start gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Updates</CardTitle>
            <CardDescription>The app checks GitHub releases and installs on restart.</CardDescription>
            <CardAction><Badge variant="success">Up to date</Badge></CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between rounded-lg bg-muted/60 p-4">
              <div className="flex flex-col"><span className="text-sm font-semibold">Version 0.9.4</span><span className="text-xs text-muted-foreground">Checked 3 minutes ago</span></div>
              <div className="flex gap-2"><Button variant="outline"><RefreshCwIcon />Check for updates</Button><Button disabled><DownloadIcon />Update and restart</Button></div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Notifications</CardTitle><CardDescription>What puts a dot on the tab bar.</CardDescription></CardHeader>
          <CardContent className="flex flex-col divide-y">
            <Row title="Bot stalled" hint="A bot has made no progress for 3 minutes."><Switch on={s.stale} onChange={set("stale")} /></Row>
            <Row title="Bot died" hint="Any death, with the cause."><Switch on={s.deaths} onChange={set("deaths")} /></Row>
            <Row title="New high-severity finding" hint="From the spectator review."><Switch on={s.review} onChange={set("review")} /></Row>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Dashboard server</CardTitle><CardDescription>The app attaches to a running dashboard or starts its own.</CardDescription></CardHeader>
          <CardContent className="flex flex-col divide-y">
            <Row title="Address" hint="Where the app finds the dashboard."><Input defaultValue="http://localhost:8765" className="w-64 font-mono text-xs" /></Row>
            <Row title="Bot registry" hint="Shared file for shafts and rooms."><Input defaultValue="..\registry.json" className="w-64 font-mono text-xs" /></Row>
            <Row title="Start with Windows" hint="Open the app when you log in."><Switch on={s.autostart} onChange={set("autostart")} /></Row>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Claude</CardTitle><CardDescription>Headless runs use your Claude subscription.</CardDescription></CardHeader>
          <CardContent className="flex flex-col divide-y">
            <Row title="Model" hint="Used for reviews and triggers."><Badge variant="secondary" className="font-mono">haiku-5-5</Badge></Row>
            <Row title="Effort" hint="How hard the spectator thinks."><Badge variant="secondary" className="font-mono">xhigh</Badge></Row>
          </CardContent>
        </Card>
      </section>
    </>
  )
}
