import { HeartIcon, DrumstickIcon, MapPinIcon, EyeIcon, TriangleAlertIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ViewPanel } from "@/components/ViewPanel"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { BehaviorPanel } from "@/components/BehaviorPanel"
import { StructurePanel } from "@/components/StructurePanel"
import { LogPanel } from "@/components/LogPanel"
import { ago, useNow } from "@/useDashboard"
import type { BotSnap, LogEntry } from "@/types"

function dayClock(t: number) {
  const h = Math.floor((t / 1000 + 6) % 24)
  const m = Math.floor((t % 1000) * 0.06)
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

export function BotCard({ bot, logs }: { bot: BotSnap; logs: LogEntry[] }) {
  const now = useNow()
  const st = bot.status

  if (!st) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{bot.name}</CardTitle>
          <CardDescription>Waiting for status</CardDescription>
        </CardHeader>
        <CardContent>
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No data</EmptyTitle>
              <EmptyDescription>latest.json has not been written yet.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    )
  }

  const age = now - new Date(st.at).getTime()
  const live = age < 150_000
  const bag = Object.entries(st.bag ?? {}).sort((a, b) => b[1] - a[1])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {bot.name}
          {st.role && <Badge variant="secondary">{st.role}</Badge>}
          <Badge variant="outline">{(st.step ?? "no step") + (st.sleeping ? " (sleeping)" : "")}</Badge>
          <Badge variant={live ? "default" : "destructive"}>{live ? "live" : "stale"} · {ago(age)}</Badge>
        </CardTitle>
        <CardDescription>
          Day clock {dayClock(st.time)} · {st.spawnable ?? "?"} mob-spawnable cells · {st.torches ?? "?"} torches known
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!live && (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>No fresh status</AlertTitle>
            <AlertDescription>{bot.name} last reported {ago(age)}. It may be offline or between snapshots.</AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Health">
            <span className="flex items-center gap-1.5 text-sm font-medium tabular-nums"><HeartIcon />{st.hp} / 20</span>
            <Progress value={Math.min(100, st.hp * 5)} />
          </Stat>
          <Stat label="Food">
            <span className="flex items-center gap-1.5 text-sm font-medium tabular-nums"><DrumstickIcon />{st.food} / 20</span>
            <Progress value={Math.min(100, st.food * 5)} />
          </Stat>
          <Stat label="Position">
            <span className="flex items-center gap-1.5 font-mono text-sm"><MapPinIcon />{st.me ? st.me.join(", ") : "?"}</span>
          </Stat>
          <Stat label="Looking at">
            <span className="flex items-center gap-1.5 truncate text-sm"><EyeIcon />{st.lookingAt ? `${st.lookingAt.block} (${st.lookingAt.dist}m)` : "nothing"}</span>
          </Stat>
        </div>

        <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
          <p><span className="mr-2 text-muted-foreground">Goal</span>{bot.goal ?? "-"}</p>
          {bot.plan && (
            <Tooltip>
              <TooltipTrigger asChild>
                <p className="line-clamp-2 text-left"><span className="mr-2 text-muted-foreground">Plan</span>{bot.plan}</p>
              </TooltipTrigger>
              <TooltipContent className="max-w-md">{bot.plan}</TooltipContent>
            </Tooltip>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {bag.map(([k, n]) => (
            <Badge key={k} variant="secondary">{k.replace(/_/g, " ")} {n}</Badge>
          ))}
          {(st.armor ?? []).map((a, i) => (
            <Badge key={i} variant="outline">{typeof a === "string" ? a : (a.name ?? "?")}</Badge>
          ))}
        </div>

        <Tabs defaultValue="live" className="gap-4">
          <TabsList>
            <TabsTrigger value="live">Live</TabsTrigger>
            <TabsTrigger value="behavior">Behavior</TabsTrigger>
            <TabsTrigger value="structure">Structure</TabsTrigger>
          </TabsList>
          <TabsContent value="live" className="flex flex-col gap-4">
            <ViewPanel bot={bot} />
            <Separator />
            <LogPanel entries={logs} />
          </TabsContent>
          <TabsContent value="behavior">
            <BehaviorPanel id={bot.id} />
          </TabsContent>
          <TabsContent value="structure">
            <StructurePanel id={bot.id} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}
