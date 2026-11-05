import { useEffect, useMemo, useRef, useState } from "react"
import { ScrollTextIcon, SearchIcon, ArrowDownToLineIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { LogEntry } from "@/types"

const KEY = ["GOAL", "PLAN", "DIED", "REFLEX", "ALARM", "IDLE", "KNOWN", "CRAFT_FAIL", "PLACE_FAIL", "chat", "conn"]
const FILTERS: Record<string, { label: string; test: (e: LogEntry) => boolean }> = {
  key: { label: "Key", test: (e) => KEY.includes(e.kind) },
  chat: { label: "Chat", test: (e) => ["chat", "server", "DIED"].includes(e.kind) },
  act: { label: "Actions", test: (e) => ["GOAL", "PLAN", "SCHED", "nav", "combat", "safety"].includes(e.kind) },
  all: { label: "All", test: () => true },
}
const QUIET = ["SCHED", "nav", "safety", "breath", "RELOAD", "router", "lag"]

function badgeVariant(kind: string) {
  if (["DIED", "ALARM", "CRAFT_FAIL", "PLACE_FAIL"].includes(kind)) return "destructive" as const
  if (["GOAL", "PLAN"].includes(kind)) return "default" as const
  if (kind === "chat") return "secondary" as const
  return "outline" as const
}
function clean(e: LogEntry) {
  return e.text
    .replace(/^(autopilot )?(GOAL|PLAN|REFLEX|ALARM|IDLE|KNOWN|CRAFT_FAIL|PLACE_FAIL)\s*/, "")
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, "")
}
function clock(iso: string | null) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : ""
}

export function LogPanel({ entries }: { entries: LogEntry[] }) {
  const [filter, setFilter] = useState("key")
  const [q, setQ] = useState("")
  const [follow, setFollow] = useState(true)
  const wrap = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const test = FILTERS[filter].test
    const needle = q.trim().toLowerCase()
    return entries.filter((e) => test(e) && (!needle || e.text.toLowerCase().includes(needle))).slice(-600)
  }, [entries, filter, q])

  const viewport = () => wrap.current?.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]") ?? null

  useEffect(() => {
    const v = viewport()
    if (follow && v) v.scrollTop = v.scrollHeight
  }, [rows, follow])

  useEffect(() => {
    const v = viewport()
    if (!v) return
    const onScroll = () => {
      const atEnd = v.scrollHeight - v.scrollTop - v.clientHeight < 30
      setFollow((f) => (f === atEnd ? f : atEnd))
    }
    v.addEventListener("scroll", onScroll)
    return () => v.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup type="single" variant="outline" size="sm" value={filter} onValueChange={(v) => v && setFilter(v)}>
          {Object.entries(FILTERS).map(([k, f]) => (
            <ToggleGroupItem key={k} value={k}>{f.label}</ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="relative min-w-32 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search log" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Toggle variant="outline" size="sm" pressed={follow} onPressedChange={(p) => {
          setFollow(p)
          const v = viewport()
          if (p && v) v.scrollTop = v.scrollHeight
        }}>
          <ArrowDownToLineIcon data-icon="inline-start" />
          Follow
        </Toggle>
      </div>
      <div ref={wrap} className="rounded-lg border">
        {rows.length === 0 ? (
          <Empty className="h-80">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ScrollTextIcon /></EmptyMedia>
              <EmptyTitle>No log lines</EmptyTitle>
              <EmptyDescription>Nothing matches this filter yet.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ScrollArea className="h-80">
            <div className="flex flex-col py-1 font-mono text-xs">
              {rows.map((e) => (
                <div key={e.id} className="grid grid-cols-[3.75rem_5.5rem_1fr] items-start gap-2 px-3 py-0.5 hover:bg-muted/50">
                  <span className="text-muted-foreground">{clock(e.t)}</span>
                  <Badge variant={badgeVariant(e.kind)} className="max-w-full justify-self-start"><span className="truncate">{e.kind}</span></Badge>
                  <span className={`break-words whitespace-pre-wrap ${QUIET.includes(e.kind) ? "text-muted-foreground" : ""}`}>{clean(e)}</span>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  )
}
