import { useCallback, useEffect, useMemo, useState } from "react"
import { CheckIcon, ChevronDownIcon, Loader2Icon, PlusIcon, SparklesIcon, XIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { AgentInfo, AgentRequest, SchematicSummary } from "@/lib/schematic/types"
import { cn } from "@/lib/utils"

const BASE = "/api/schematic-agent"
async function post<T>(url: string, body: unknown): Promise<T & { ok?: boolean; why?: string }> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  return r.json().catch(() => ({ ok: false, why: `The dashboard server answered ${r.status}.` }))
}

/** The agent's state: its queue, the bots' daily cap and the model choices. Polls quickly while something is queued or running. */
export function useAgent() {
  const [info, setInfo] = useState<AgentInfo | null>(null)
  const [failed, setFailed] = useState(false)
  const load = useCallback(() => fetch(BASE).then((r) => r.json() as Promise<AgentInfo>).then((d) => { setInfo(d); setFailed(false) }).catch(() => setFailed(true)), [])
  const busy = !!info?.requests.some((r) => r.status === "queued" || r.status === "running" || r.status === "cancelling")
  useEffect(() => {
    load()
    const t = setInterval(load, busy ? 2500 : 15000)
    return () => clearInterval(t)
  }, [load, busy])
  return { info, failed, reload: load }
}

const ago = (iso?: string) => {
  if (!iso) return ""
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`
}
const modelLabel = (info: AgentInfo, id: string) => info.models.find((m) => m.id === id)?.label ?? id
const effortLabel = (e: string) => (e === "xhigh" ? "XHigh" : e[0].toUpperCase() + e.slice(1))

function StatusBadge({ s }: { s: AgentRequest["status"] }) {
  if (s === "running" || s === "cancelling") return <Badge className="gap-1"><Loader2Icon className="size-3 animate-spin" />{s === "cancelling" ? "Stopping" : "Building"}</Badge>
  if (s === "queued") return <Badge variant="secondary">Queued</Badge>
  if (s === "done") return <Badge variant="outline" className="gap-1"><CheckIcon className="size-3" />Done</Badge>
  if (s === "failed") return <Badge variant="destructive">Failed</Badge>
  return <Badge variant="outline">Cancelled</Badge>
}

const KIND_TEXT = { new: "New schematic", variant: "New variant", edit: "Edit" } as const

function RequestRow({ r, info, onOpen, reload }: { r: AgentRequest; info: AgentInfo; onOpen: (id: string, variant: string) => void; reload: () => void }) {
  const [cancelling, setCancelling] = useState(false)
  const active = r.status === "queued" || r.status === "running"
  return (
    <li className="flex flex-col gap-1 rounded-lg border p-2.5">
      <div className="flex items-start gap-2">
        <StatusBadge s={r.status} />
        <p className="min-w-0 flex-1 text-sm leading-snug [overflow-wrap:anywhere]" title={r.prompt}><span className="line-clamp-3">{r.prompt}</span></p>
        {active && <Button variant="ghost" size="icon-sm" aria-label="Cancel this request" disabled={cancelling} onClick={() => { setCancelling(true); post(`${BASE}/requests/${r.id}/cancel`, {}).finally(() => { setCancelling(false); reload() }) }}><XIcon /></Button>}
      </div>
      <p className="text-xs text-muted-foreground">
        {r.source === "bot" ? r.by : "You"} · {KIND_TEXT[r.kind]}{r.target ? ` of ${r.target.id}` : ""} · {modelLabel(info, r.model)}, {effortLabel(r.effort)} · {ago(r.finishedAt ?? r.startedAt ?? r.createdAt)}
        {r.costUsd != null && r.costUsd > 0 ? ` · $${r.costUsd.toFixed(2)}` : ""}
        {r.status === "running" && r.calls > 0 ? ` · ${r.calls} steps${r.lastCall ? `, ${r.lastCall.tool.replace(/_/g, " ")}` : ""}` : ""}
      </p>
      {r.status === "queued" && !info.running && <p className="text-xs text-muted-foreground">Starting in a moment.</p>}
      {r.status === "queued" && info.running && <p className="text-xs text-muted-foreground">Waiting for the one that is building (one runs at a time).</p>}
      {r.status === "failed" && r.error && <p className="text-xs text-destructive [overflow-wrap:anywhere]">{r.error}</p>}
      {r.status === "done" && r.result && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Button variant="outline" size="xs" onClick={() => onOpen(r.result!.schematicId, r.result!.variantId)}>Open {r.result.name}{r.result.variantId !== "main" ? ` · ${r.result.variantId}` : ""}</Button>
          <span className="text-muted-foreground">{r.result.size.join(" × ")} · {r.result.cells.toLocaleString()} blocks</span>
          {r.result.summary && <span className="basis-full text-muted-foreground [overflow-wrap:anywhere]">{r.result.summary}</span>}
          {r.result.issues && r.result.issues.length > 0 && <span className="basis-full text-muted-foreground [overflow-wrap:anywhere]">Left over: {r.result.issues[0]}</span>}
        </div>
      )}
    </li>
  )
}

/** The agent's bar above the catalog: the New schematic button, what is running, the bots' use of their daily cap, the recent requests, and the bots' settings. */
export function AgentPanel({ agent, onNew, onOpen }: { agent: ReturnType<typeof useAgent>; onNew: () => void; onOpen: (id: string, variant: string) => void }) {
  const { info, failed, reload } = agent
  const [open, setOpen] = useState(false)
  const [all, setAll] = useState(false)
  const [cap, setCap] = useState<string | null>(null)
  if (!info) return failed ? <Card className="p-3 text-sm text-muted-foreground">The schematic agent is not answering (the dashboard server may be an older version).</Card> : null
  const active = info.requests.filter((r) => r.status === "queued" || r.status === "running" || r.status === "cancelling")
  const shown = all ? info.requests : info.requests.slice(0, 2)
  const saveConfig = (patch: Partial<AgentInfo["config"]>) => post(`${BASE}/config`, patch).finally(() => { setCap(null); reload() })
  return (
    <Card className="@container gap-3 p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold"><SparklesIcon className="size-4" />Schematic agent</h2>
          <p className="text-xs text-muted-foreground">
            Describe a build and a model designs it straight into the catalog the bots build from.{" "}
            {active.length ? `${active.length} request${active.length === 1 ? "" : "s"} in progress.` : "Nothing in progress."}{" "}
            Bots asked <span className="font-medium text-foreground tabular-nums">{info.quota.used} of {info.quota.cap}</span> times today.
          </p>
        </div>
        <Button onClick={onNew} disabled={!info.available}><PlusIcon />New schematic</Button>
      </div>
      {!info.available && <p className="text-xs text-destructive">{info.unavailableWhy ?? "The agent is not available in this dashboard."}</p>}
      {info.requests.length > 0 && (
        <ul className="grid gap-2 @3xl:grid-cols-2">
          {shown.map((r) => <RequestRow key={r.id} r={r} info={info} onOpen={onOpen} reload={reload} />)}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {info.requests.length > 2 && <button onClick={() => setAll(!all)} className="text-muted-foreground underline underline-offset-2 hover:text-foreground">{all ? "Show fewer" : `Show all ${info.requests.length} requests`}</button>}
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ChevronDownIcon className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />Settings for bot requests
        </button>
      </div>
      {open && (
        <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 text-sm sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Bot requests a day (both bots together)</span>
            <Input type="number" min={0} max={1000} value={cap ?? String(info.config.botDailyCap)} onChange={(e) => setCap(e.target.value)} onBlur={() => cap !== null && saveConfig({ botDailyCap: Number(cap) })} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur() }} />
            <span className="text-xs text-muted-foreground">{info.quota.remaining} left today. At most {info.config.botMaxPending} wait at once. A bot can ask for a new schematic or a new variant, never change an existing one.</span>
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Model for bot requests</span>
            <ModelSelect info={info} value={info.config.botModel} onChange={(v) => saveConfig({ botModel: v })} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Effort for bot requests</span>
            <EffortSelect info={info} value={info.config.botEffort} onChange={(v) => saveConfig({ botEffort: v })} />
          </div>
        </div>
      )}
    </Card>
  )
}

function ModelSelect({ info, value, onChange }: { info: AgentInfo; value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full" aria-label="Model"><SelectValue /></SelectTrigger>
      <SelectContent>{info.models.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}{m.id === info.defaults.model ? " (default)" : ""}</SelectItem>)}</SelectContent>
    </Select>
  )
}
function EffortSelect({ info, value, onChange }: { info: AgentInfo; value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full" aria-label="Effort"><SelectValue /></SelectTrigger>
      <SelectContent>{info.efforts.map((e) => <SelectItem key={e} value={e}>{effortLabel(e)}{e === info.defaults.effort ? " (default)" : ""}</SelectItem>)}</SelectContent>
    </Select>
  )
}

export type Prefill = { kind: "new" | "variant" | "edit"; id?: string; variant?: string }

/** The form that asks for a build: new, a variant of an existing schematic, or a change to one variant. Model and effort start at Opus 5.5, Medium. */
export function RequestSheet({ open, onOpenChange, info, list, prefill, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; info: AgentInfo | null; list: SchematicSummary[]; prefill: Prefill; onCreated: () => void
}) {
  const [kind, setKind] = useState<Prefill["kind"]>("new")
  const [target, setTarget] = useState("")
  const [variant, setVariant] = useState("")
  const [prompt, setPrompt] = useState("")
  const [model, setModel] = useState("")
  const [effort, setEffort] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // each time the form opens it starts from what the page asked for, and the model and effort go back to the defaults
  useEffect(() => {
    if (!open) return
    setKind(prefill.kind); setTarget(prefill.id ?? list[0]?.id ?? ""); setVariant(prefill.variant ?? "")
    setModel(info?.defaults.model ?? "claude-opus-5-5"); setEffort(info?.defaults.effort ?? "medium"); setError(null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const picked = useMemo(() => list.find((s) => s.id === target) ?? null, [list, target])
  const variants = picked?.variants ?? []
  const variantId = variants.some((v) => v.id === variant) ? variant : (picked?.defaultVariant ?? "")
  const ready = prompt.trim().length >= 8 && !busy && !!info?.available && (kind === "new" || !!picked)

  const submit = async () => {
    setBusy(true); setError(null)
    const r = await post<{ request: AgentRequest }>(`${BASE}/requests`, { prompt, kind, target: kind === "new" ? null : { id: target, variant: variantId }, model, effort })
    setBusy(false)
    if (!r.ok) { setError(r.why ?? "The request was not accepted."); return }
    setPrompt(""); onOpenChange(false); onCreated()
  }
  const placeholder = kind === "new"
    ? "A two-storey stone watchtower with a spiral stair, a lit lookout deck and a small door at the base. About 9×9, built from cobblestone and spruce."
    : kind === "variant" ? "The same build, but in spruce and dark oak, with a cellar under it." : "Add a porch with two steps along the south wall and replace the glass panes with oak trapdoor shutters."

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Ask the schematic agent</SheetTitle>
          <SheetDescription>It builds in a block workspace, checks its own layers, and files the result in the catalog. It takes a few minutes; you can keep using the app.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">What do you want?</span>
            <ToggleGroup type="single" value={kind} onValueChange={(v) => v && setKind(v as Prefill["kind"])} variant="outline" spacing={0} className="grid w-full grid-cols-3">
              <ToggleGroupItem value="new">New schematic</ToggleGroupItem>
              <ToggleGroupItem value="variant" disabled={list.length === 0}>Add a variant</ToggleGroupItem>
              <ToggleGroupItem value="edit" disabled={list.length === 0}>Change a variant</ToggleGroupItem>
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              {kind === "new" ? "A schematic that is not in the catalog yet. It starts with one variant, Main."
                : kind === "variant" ? "Another version of a schematic that is there (a smaller one, another wood). The chosen variant is the starting point; the original stays as it is."
                : "Change one variant in place. The previous file is kept in the agent's history folder."}
            </p>
          </div>
          {kind !== "new" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Schematic</span>
                <Select value={target} onValueChange={(v) => { setTarget(v); setVariant("") }}>
                  <SelectTrigger className="w-full" aria-label="Schematic"><SelectValue placeholder="Pick one" /></SelectTrigger>
                  <SelectContent>{list.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">{kind === "variant" ? "Start from variant" : "Variant to change"}</span>
                <Select value={variantId} onValueChange={setVariant} disabled={variants.length === 0}>
                  <SelectTrigger className="w-full" aria-label="Variant"><SelectValue /></SelectTrigger>
                  <SelectContent>{variants.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{kind === "new" ? "Describe the build" : kind === "variant" ? "What should be different?" : "What should change?"}</span>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={7} maxLength={4000} placeholder={placeholder} autoFocus
              className="min-h-32 w-full resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30" />
            <span className="text-xs text-muted-foreground">Say what it is for, the size, the materials and the style. For something the bots will build, say what has to work (a farm, a storage room). Say nothing about format: the agent knows it.</span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Model</span>
              {info ? <ModelSelect info={info} value={model} onChange={setModel} /> : <Input disabled value={model} />}
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Effort</span>
              {info ? <EffortSelect info={info} value={effort} onChange={setEffort} /> : <Input disabled value={effort} />}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">It runs on your Claude login on this computer, like the other jobs. Higher effort and bigger builds take longer and cost more.</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <SheetFooter className="border-t">
          <Button onClick={submit} disabled={!ready}>{busy ? <Loader2Icon className="animate-spin" /> : <SparklesIcon />}{busy ? "Sending…" : "Build it"}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
