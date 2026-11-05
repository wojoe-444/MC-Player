import { useEffect, useMemo, useState } from "react"
import { ChevronsUpDownIcon, FileTextIcon, SearchIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ago, useNow } from "@/useDashboard"
import type { BotId } from "@/types"

type Mod = { name: string; desc: string; files: number; readme: boolean; status: "active" | "loaded" | "disabled"; lastSeen: string | null; lines: number }
type FileRow = { group: "state" | "root"; name: string; size: number; mtime: number; summary: string }
type Structure = {
  mode: { mode: string; since: number | null; role: string | null; safety: string | null; thinkOff: boolean; goals: string[] | null }
  scheduler: { enabled?: Record<string, boolean>; idleAfterMs?: number } | null
  tasks: { name: string; status: string; t: string | null }[]
  modules: Mod[]
  skills: string[]
  steps: string[] | null
  files: FileRow[]
  strategy: string | null
}

function size(n: number) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function FileSheet({ id, file, onClose }: { id: BotId; file: FileRow | null; onClose: () => void }) {
  const [data, setData] = useState<{ text: string; truncated: string | false; size: number } | null>(null)
  useEffect(() => {
    setData(null)
    if (!file) return
    let live = true
    fetch(`/api/file/${id}/${file.group}/${file.name}`).then((r) => r.json()).then((d) => live && setData(d))
    return () => { live = false }
  }, [id, file])
  return (
    <Sheet open={!!file} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle className="font-mono">{file?.name}</SheetTitle>
          <SheetDescription>
            {file ? `${file.group}/ · ${size(file.size)} · read-only view${data?.truncated ? ` · ${data.truncated}` : ""}` : ""}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          {data ? (
            <pre className="p-4 font-mono text-xs break-words whitespace-pre-wrap">{data.text}</pre>
          ) : (
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" />
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

export function StructurePanel({ id }: { id: BotId }) {
  const now = useNow()
  const [s, setS] = useState<Structure | null>(null)
  const [q, setQ] = useState("")
  const [open, setOpen] = useState<FileRow | null>(null)

  useEffect(() => {
    let live = true
    const load = () => fetch(`/api/structure/${id}`).then((r) => r.json()).then((d) => live && setS(d)).catch(() => {})
    load()
    const t = setInterval(load, 10_000)
    return () => { live = false; clearInterval(t) }
  }, [id])

  const files = useMemo(() => {
    if (!s) return []
    const n = q.trim().toLowerCase()
    return s.files
      .filter((f) => !n || f.name.toLowerCase().includes(n) || f.summary.toLowerCase().includes(n))
      .sort((a, b) => b.mtime - a.mtime)
  }, [s, q])

  if (!s) return <div className="flex flex-col gap-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-48 w-full" /></div>

  const enabled = Object.entries(s.scheduler?.enabled ?? {})
  const counts = { active: 0, loaded: 0, disabled: 0 }
  s.modules.forEach((m) => counts[m.status]++)

  return (
    <div className="flex flex-col gap-6">
      <Section title="Mode" hint="autonomous: the autopilot plays on its own goals. task: it follows chat orders and runs routines when idle.">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{s.mode.mode}</Badge>
          {s.mode.role && <Badge variant="secondary">role: {s.mode.role}</Badge>}
          {s.mode.safety && <Badge variant="outline">safety: {s.mode.safety}</Badge>}
          <Badge variant="outline">planner {s.mode.thinkOff ? "off" : "on"}</Badge>
          {(s.mode.goals ?? []).map((g) => <Badge key={g} variant="secondary">goal: {g.replace(/_/g, " ")}</Badge>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Scheduler tasks now</span>
          {s.tasks.length === 0 && <Badge variant="outline">none</Badge>}
          {s.tasks.map((t) => (
            <Badge key={t.name} variant={t.status === "running" ? "default" : t.status === "paused" ? "secondary" : "outline"}>{t.name}: {t.status}</Badge>
          ))}
        </div>
        {enabled.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Routines</span>
            {enabled.map(([k, v]) => <Badge key={k} variant={v ? "secondary" : "outline"}>{k}: {v ? "on" : "off"}</Badge>)}
          </div>
        )}
      </Section>

      {s.steps && (
        <>
          <Separator />
          <Section title="Survival plan" hint="The ordered steps (processes) the autopilot works through, highest priority first.">
            <div className="flex flex-wrap gap-1.5">
              {s.steps.map((x, i) => <Badge key={x} variant="outline">{i + 1}. {x}</Badge>)}
            </div>
          </Section>
        </>
      )}

      <Separator />
      <Section title={`Modules (${counts.active} active, ${counts.loaded} loaded, ${counts.disabled} disabled)`}
        hint="Brain modules from brain/index.js. Active means it logged within the last 10 minutes; disabled comes from this bot's disabled-modules.json.">
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>What it does</TableHead>
                <TableHead className="text-right">Last log</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {s.modules.map((m) => (
                <TableRow key={m.name}>
                  <TableCell className="font-mono">{m.name}</TableCell>
                  <TableCell><Badge variant={m.status === "active" ? "default" : m.status === "loaded" ? "secondary" : "outline"}>{m.status}</Badge></TableCell>
                  <TableCell className="max-w-72 whitespace-normal text-muted-foreground">{m.desc || "-"}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{m.lastSeen ? ago(now - new Date(m.lastSeen).getTime()) : "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>

      <Separator />
      <Section title={`Skills (${s.skills.length})`} hint="The body skills the autopilot builds on (walk, dig, craft, place, ...), from autopilot/skills.js. Shared by both bots.">
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm">Show all skills<ChevronsUpDownIcon data-icon="inline-end" /></Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <div className="flex flex-wrap gap-1.5">
              {s.skills.map((k) => <Badge key={k} variant="secondary" className="font-mono">{k}</Badge>)}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Section>

      <Separator />
      <Section title={`Saved memory and data (${files.length})`} hint="This bot's own files: brain/state plus world data in its folder. Newest first. Click a file to read it.">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Filter files" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Contents</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((f) => (
                <TableRow key={f.group + f.name}>
                  <TableCell>
                    <Button variant="link" size="sm" className="h-auto p-0 font-mono" onClick={() => setOpen(f)}>
                      <FileTextIcon data-icon="inline-start" />{f.name}
                    </Button>
                    {f.group === "root" && <Badge variant="outline" className="ml-2">world</Badge>}
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground">{f.summary}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{size(f.size)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{ago(now - f.mtime)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Section>

      {s.strategy && (
        <>
          <Separator />
          <Section title="Strategy notes" hint="strategy.md, written and revised by the bot.">
            <pre className="rounded-lg border p-3 font-mono text-xs break-words whitespace-pre-wrap">{s.strategy}</pre>
          </Section>
        </>
      )}
      <FileSheet id={id} file={open} onClose={() => setOpen(null)} />
    </div>
  )
}
