import { DownloadIcon, RefreshCwIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { PageHeader } from "@/components/common"
import { useSim, type UpdateState } from "@/sim"

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "")

function statusText(u: UpdateState) {
  const checked = u.checkedAt ? ` Last checked ${when(u.checkedAt)}.` : ""
  return ({
    unsupported: "Updates only work in the installed app. This copy runs from source: use git pull and npm start.",
    idle: 'Press "Check for updates" to look for a newer version.',
    checking: "Checking GitHub for a newer version…",
    "up-to-date": `You are up to date.${checked}`,
    available: `Version ${u.latest} is available.${checked}`,
    downloading: `Downloading version ${u.latest}… ${u.progress || 0}%`,
    ready: "Installing and restarting…",
    error: `Update failed: ${u.error || "unknown error"}`,
  } as const)[u.status]
}

export function Settings() {
  const { info, update: u, checkUpdate, installUpdate } = useSim()
  const busy = u.status === "checking" || u.status === "downloading" || u.status === "ready"
  const showInstall = u.status === "available" || (u.status === "error" && !!u.latest)
  const tone = u.status === "error" ? "text-destructive" : u.status === "up-to-date" || u.status === "available" ? "text-success" : "text-muted-foreground"
  return (
    <>
      <PageHeader title="Settings" description={`Settings and reviews are stored in ${info.dataDir}. Dashboard: ${info.dashboardUrl}`} />
      <section className="grid items-start gap-6 xl:grid-cols-[minmax(0,40rem)]">
        <Card>
          <CardHeader>
            <CardTitle>Updates</CardTitle>
            <CardDescription>The app checks GitHub releases and installs on restart. A dot on Settings in the sidebar means an update is available.</CardDescription>
            <CardAction>{u.status === "up-to-date" ? <Badge variant="success">Up to date</Badge> : showInstall ? <Badge variant="warning">Update available</Badge> : null}</CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/60 p-4">
              <span className="text-sm font-semibold">Bot Dashboard {info.version}</span>
              <span className="flex-1" />
              <Button variant="outline" onClick={checkUpdate} disabled={busy || u.status === "unsupported"}><RefreshCwIcon />Check for updates</Button>
              {showInstall && <Button onClick={installUpdate} disabled={busy}><DownloadIcon />{u.status === "error" ? "Retry update and restart" : "Update and restart"}</Button>}
            </div>
            <p className={`text-sm ${tone}`}>{statusText(u)}</p>
            {u.status === "downloading" && <Progress value={u.progress || 0} aria-label="Download progress" />}
            {u.notes && u.status === "available" && <pre className="max-h-40 overflow-auto rounded-lg border bg-muted/40 p-3 font-sans text-xs whitespace-pre-wrap text-muted-foreground">{u.notes}</pre>}
          </CardContent>
        </Card>
      </section>
    </>
  )
}
