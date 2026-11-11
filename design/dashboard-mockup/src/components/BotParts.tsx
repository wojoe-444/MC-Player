import { HeartIcon, DrumstickIcon, MapPinIcon, EyeIcon, TriangleAlertIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ago, useNow } from "@/useDashboard"
import type { BotSnap } from "@/types"

export function dayClock(t: number) {
  const h = Math.floor((t / 1000 + 6) % 24)
  const m = Math.floor((t % 1000) * 0.06)
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

export function useFresh(bot: BotSnap) {
  const now = useNow()
  const age = bot.status ? now - new Date(bot.status.at).getTime() : Infinity
  return { age, live: age < 150_000 }
}

/** Name plus the status badges. */
export function BotBadges({ bot }: { bot: BotSnap }) {
  const { age, live } = useFresh(bot)
  const st = bot.status
  return (
    <>
      {st?.role && <Badge variant="secondary">{st.role}</Badge>}
      <Badge variant="outline">{(st?.step ?? "no step") + (st?.sleeping ? " (sleeping)" : "")}</Badge>
      {st && <Badge variant={live ? "default" : "destructive"}>{live ? "live" : "stale"} · {ago(age)}</Badge>}
    </>
  )
}

export function StaleAlert({ bot }: { bot: BotSnap }) {
  const { age, live } = useFresh(bot)
  if (live || !bot.status) return null
  return (
    <Alert variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>No fresh status</AlertTitle>
      <AlertDescription>{bot.name} last reported {ago(age)}. It may be offline or between snapshots.</AlertDescription>
    </Alert>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

/** Vitals row: health, food, position, looking at. */
export function Vitals({ bot, cols = "sm:grid-cols-4" }: { bot: BotSnap; cols?: string }) {
  const st = bot.status
  if (!st) return null
  return (
    <div className={`grid grid-cols-2 gap-4 ${cols}`}>
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
  )
}

export function GoalBox({ bot }: { bot: BotSnap }) {
  return (
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
  )
}

export function BagBadges({ bot }: { bot: BotSnap }) {
  const bag = Object.entries(bot.status?.bag ?? {}).sort((a, b) => b[1] - a[1])
  return (
    <div className="flex flex-wrap gap-1.5">
      {bag.map(([k, n]) => <Badge key={k} variant="secondary">{k.replace(/_/g, " ")} {n}</Badge>)}
    </div>
  )
}
