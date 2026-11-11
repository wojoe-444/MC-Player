// The Memory loop page (docs/MEMORY-LOOP.md): the loop's scheduled jobs (install, remove, run now), the digest, the ranked work orders,
// each bot's memory file with what the last check changed, and one line per run. Everything shown is read from this computer by the app's main process.
import { useEffect, useState } from "react"
import { PlayIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { NeedsApp, PageHeader } from "@/components/common"
import { useApp, type FixMode, type LoopBot, type LoopFix, type LoopJob, type LoopOrder, type LoopState, type TaskState } from "@/botapp"

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "never")
const mins = (n: number) => `${Math.round((n || 0) * 10) / 10} min`
const money = (n?: number) => (typeof n === "number" && n > 0 ? `$${n.toFixed(3)}` : "")
const isOpen = (o: LoopOrder) => o.status === "open" || o.status === "parked"

const Pre = ({ children, className = "" }: { children: string; className?: string }) => (
  <pre className={`font-sans text-sm leading-relaxed whitespace-pre-wrap ${className}`}>{children}</pre>
)
const File = ({ children }: { children: string }) => (
  <pre className="max-h-96 overflow-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">{children}</pre>
)
const Details = ({ summary, open, children }: { summary: string; open?: boolean; children: React.ReactNode }) => (
  <details open={open} className="group rounded-lg border px-4 py-3">
    <summary className="cursor-pointer text-sm font-medium text-muted-foreground group-open:mb-3">{summary}</summary>
    {children}
  </details>
)

function taskLine(t: TaskState, name: string, runLabel: string) {
  if (t?.installed) return `Task "${name}": ${t.status || "installed"}, next run ${t.nextRun || "?"}, last run ${t.lastRun || "never"} (result ${t.lastResult ?? "?"}). Runs only while you are logged in, window hidden.`
  if (t?.unsupported) return `Task Scheduler is Windows-only; "${runLabel}" still works.`
  return `Not installed. Install creates one Windows Task Scheduler job named "${name}" for your user account (no admin, no password).`
}

function CodeRow({ code }: { code: NonNullable<LoopState["code"]> }) {
  const { saveCodeDir } = useApp()
  const [dir, setDir] = useState(code.dir || "")
  const last = (code.last || []).slice(-1)[0]
  const state = !code.isClone ? "This folder is not a git clone, so the deployer has nothing to update."
    : !code.hasDeployer ? "This clone has no tools/deployer.js yet: pull main into it once by hand."
      : last ? `Last record: ${last.event}${last.to ? ` to ${last.to}` : ""}${last.why ? ` (${last.why})` : ""}${last.verdict ? ` ${last.verdict}` : ""}, ${when(last.t)}.` : "No deploy recorded yet."
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex flex-1 items-center gap-2 text-muted-foreground">Code folder the live bots run from <Input value={dir} onChange={(e) => setDir(e.target.value)} className="min-w-64 flex-1 font-mono text-xs" /></label>
        <Button variant="outline" size="sm" onClick={async () => { const err = await saveCodeDir(dir); if (err) alert("Could not save: " + err) }}>Save</Button>
      </div>
      <span className="text-xs text-muted-foreground">{state}</span>
    </div>
  )
}

// The fixer's own settings and state: what it does with a checked fix, whether it could reach GitHub on its last run, where its copy of the code is.
const FIX_MODES: [FixMode, string][] = [["merge", "open the pull request and merge it when every check passes"], ["pr", "open the pull request, I merge it"], ["local", "keep the fix on this computer"]]
function FixRow({ fix }: { fix: LoopFix }) {
  const { saveFixMode } = useApp()
  const gh = fix.gh ? (fix.gh.ok ? "GitHub CLI was logged in on the last run." : `GitHub: ${fix.gh.note}`) : "It has not tried to reach GitHub yet. It needs the GitHub CLI logged in once (gh auth login, then gh auth setup-git)."
  const last = fix.last ? `Last run ${when(fix.at)}: ${fix.last.note || fix.last.outcome}` : "No run yet."
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-4">
      <label className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">With a checked fix
        <select value={fix.mode} onChange={async (e) => { const err = await saveFixMode(e.target.value as FixMode); if (err) alert("Could not save: " + err) }} className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm text-foreground">
          {FIX_MODES.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
      </label>
      <span className="text-xs text-muted-foreground">{last} {gh}</span>
      <span className="text-xs text-muted-foreground break-all">{`Its copy of the code: ${fix.workDir}${fix.hasClone ? "" : " (cloned from GitHub on the first run)"}. Session logs are beside it in fixer/sessions.`}</span>
    </div>
  )
}
const fixLine = (f?: LoopFix["orders"][string] | null) => !f ? "" : f.ready ? ` · fixer: checked fix waits on ${f.ready.branch}${f.ready.why ? ` (${f.ready.why})` : ""}`
  : f.waiting ? ` · fixer: waits on ${f.waiting.on === "merge" ? "a merge" : f.waiting.on === "deploy" ? "the deployer" : "the deploy verdict"}` : f.attempts ? ` · fixer: ${f.attempts} failed attempt(s)` : ""

function JobCard({ j, code, fix }: { j: LoopJob; code?: LoopState["code"]; fix?: LoopFix | null }) {
  const { installLoopJob, removeLoopJob, runLoopJob } = useApp()
  const [every, setEvery] = useState(j.minutes)
  const [busy, setBusy] = useState(false)
  const t = j.task
  return (
    <Card>
      <CardHeader>
        <CardTitle>{j.title}</CardTitle>
        <CardDescription>{taskLine(t, j.taskName, "Run now")}</CardDescription>
        <CardAction><Badge variant={t?.installed ? "success" : "outline"}>{t?.installed ? "Installed" : "Not installed"}</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {j.about && <p className="text-sm text-muted-foreground">{j.about}</p>}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="flex-1" />
          <label className="flex items-center gap-2 text-muted-foreground">every <Input type="number" min={10} max={j.maxMinutes} value={every} onChange={(e) => setEvery(Number(e.target.value))} className="w-20" /> min</label>
          <Button variant="outline" disabled={busy} onClick={async () => { setBusy(true); const err = await installLoopJob(j.id, every); setBusy(false); if (err) alert("Could not install: " + err) }}>{t?.installed ? "Reinstall task" : "Install Task Scheduler job"}</Button>
          <Button variant="outline" disabled={!t?.installed} onClick={() => removeLoopJob(j.id)}>Remove task</Button>
          <Button variant="outline" disabled={j.running} onClick={() => runLoopJob(j.id)}><PlayIcon />{j.running ? "Running…" : "Run now"}</Button>
        </div>
        {j.id === "deploy" && code && <CodeRow code={code} />}
        {j.id === "fix" && fix && <FixRow fix={fix} />}
      </CardContent>
    </Card>
  )
}

function OrderCard({ o, fix }: { o: LoopOrder; fix?: LoopFix["orders"][string] | null }) {
  const open = isOpen(o)
  const lines = Object.entries(o.bots || {}).map(([b, n]) => `${b}: ${n.line} (${mins(n.costMin)} lost)` + (n.evidence || []).map((e) => `\n    ${e}`).join(""))
  if (o.suggestion) lines.push(`Where to look: ${o.suggestion}`)
  if (o.findings?.length) lines.push(`Reviewer findings: ${o.findings.join(", ")}`)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{o.title}</CardTitle>
        <CardDescription className="font-mono text-xs">{`${o.key} · ${o.kind} · ${o.status} · opened ${when(o.openedAt)} · seen in ${o.seenDreams} check(s)${o.reopens ? ` · reopened ${o.reopens}x` : ""}${o.pr ? ` · PR #${o.pr}` : ""}${o.closed ? ` · ${o.closed.reason}` : ""}${fixLine(fix)}`}</CardDescription>
        <CardAction><Badge variant={open ? "warning" : "success"}>{open ? mins(o.costMin) : o.status}</Badge></CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {o.problem && <Pre>{o.problem}</Pre>}
        <Details summary="Numbers and evidence"><Pre className="text-muted-foreground">{lines.join("\n")}</Pre></Details>
      </CardContent>
    </Card>
  )
}

function BotCard({ b }: { b: LoopBot }) {
  const brief = b.brief, c = b.lastCheck
  const holds = (brief?.holds || []).map((h) => `${h.step} (until day ${h.untilDay}: ${h.why})`)
  const steps = c ? (c.calls || []).map((x) => `${x.step} ${x.ok ? "ok" : "failed"}`).concat(Object.keys(c.skippedSteps || {}).map((s) => `${s} skipped`)) : []
  return (
    <Card>
      <CardHeader>
        <CardTitle>{b.name}</CardTitle>
        <CardDescription>{brief ? `last plan ${when(brief.at)}, in-game day ${brief.day}` : "no dawn brief yet"}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {brief && (
          <div className="flex flex-col gap-2">
            {brief.intent && <p className="text-sm">{brief.intent}</p>}
            <p className="text-xs text-muted-foreground">{`focus: ${(brief.focus || []).join(", ") || "none"} · holds: ${holds.join("; ") || "none"} · free time: ${brief.freeTime ? `${brief.freeTime.choice}${brief.freeTime.note ? ` (${brief.freeTime.note})` : ""}` : "none"}`}</p>
            {brief.ask && <p className="rounded-lg bg-primary/5 p-3 text-sm"><span className="mr-2 font-semibold">{b.name} asks:</span>{brief.ask}</p>}
          </div>
        )}
        {b.memory
          ? <Details summary="global.md, the file it reads every dawn" open><File>{b.memory}</File></Details>
          : <p className="text-sm text-muted-foreground">No memory folder. It appears once this bot runs code with the dawn brief on (on for the hillclimber, off for the assistant).</p>}
        {c && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">{`Last memory check ${when(c.at)}: ${steps.join(", ")}${money(c.costUsd) ? `, ${money(c.costUsd)}` : ""}. ${c.changes.length ? `${c.changes.length} line(s) changed:` : "Nothing changed."}`}</p>
            {c.changes.map((ch, i) => (
              <Pre key={i} className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">{`${ch.step}, ${ch.op}${ch.from ? `: ${ch.from}` : ""}${ch.to ? `\n  now: ${ch.to}` : ""}\n  why: ${ch.why || ""}${(ch.cites || []).map((x) => `\n  from: ${x}`).join("")}`}</Pre>
            ))}
            {!!c.dropped?.length && <Details summary={`${c.dropped.length} answer(s) failed a check and were not applied`}><Pre className="text-xs text-muted-foreground">{c.dropped.join("\n")}</Pre></Details>}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function Loop() {
  const app = useApp()
  const { loop: s, refreshLoop } = app
  useEffect(() => {
    if (!app.available) return
    refreshLoop()
    const t = setInterval(refreshLoop, 60_000)
    return () => clearInterval(t)
  }, [app.available, refreshLoop])
  if (!app.available) return <NeedsApp title="Memory loop" />
  if (!s) return <PageHeader title="Memory loop" description="Loading…" />
  if (!s.available) return <PageHeader title="Memory loop" description="The reviewer folder was not found next to the app, so the loop cannot be shown." />

  const orders = [...(s.orders || []).filter(isOpen), ...(s.orders || []).filter((o) => !isOpen(o)).slice(0, 8)]
  const rt = s.reviewTask
  return (
    <>
      <PageHeader title="Memory loop" description={`The bots keep a journal, plan each dawn from a small memory file, and a check compares that memory with the journal every two hours. What memory cannot fix becomes a work order, ranked by lost minutes. Everything on this page stays on this computer (${s.loopDir}).`} />

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Digest</h2>
        {s.digest
          ? <Card><CardContent><Details summary={`Digest of ${s.digest.date}`} open><File>{s.digest.text}</File></Details></CardContent></Card>
          : <p className="text-sm text-muted-foreground">No digest yet. Install the digest job below, or press its Run now.</p>}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Scheduled jobs</h2>
        <div className="grid items-start gap-6 xl:grid-cols-2 [&>*]:min-w-0">
          {rt && (
            <Card>
              <CardHeader>
                <CardTitle>{rt.title || "Review and dawn briefs"}</CardTitle>
                <CardDescription>{(rt.task?.installed ? `Task "${rt.taskName}": ${rt.task.status || "installed"}, last run ${rt.task.lastRun || "never"}.` : rt.task?.unsupported ? "Task Scheduler is Windows-only." : "Not installed.") + " The dawn brief is answered by this job. Install and remove it on the Claude reviews page."}</CardDescription>
                <CardAction><Badge variant={rt.task?.installed ? "success" : "outline"}>{rt.task?.installed ? "Installed" : "Not installed"}</Badge></CardAction>
              </CardHeader>
            </Card>
          )}
          {(s.jobs || []).map((j) => <JobCard key={j.id} j={j} code={s.code} fix={s.fix} />)}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Work orders</h2>
        {orders.length
          ? <div className="grid items-start gap-6 xl:grid-cols-2 [&>*]:min-w-0">{orders.map((o) => <OrderCard key={o.key} o={o} fix={s.fix?.orders?.[o.key]} />)}</div>
          : <p className="text-sm text-muted-foreground">No work orders yet. The dream job opens one when the journal shows the same fault again and again.</p>}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Each bot's memory</h2>
        <div className="grid items-start gap-6 xl:grid-cols-2 [&>*]:min-w-0">{(s.bots || []).map((b) => <BotCard key={b.id} b={b} />)}</div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Runs</h2>
        {s.runs?.length ? (
          <Card>
            <CardContent>
              <Table>
                <TableHeader><TableRow>{["When", "Job", "Result", "What it did", "Time and cost"].map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow></TableHeader>
                <TableBody>
                  {s.runs.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="whitespace-nowrap">{when(r.at)}</TableCell>
                      <TableCell>{r.job}</TableCell>
                      <TableCell><Badge variant={r.ok === false ? "destructive" : "success"}>{r.ok === false ? "failed" : "ok"}</Badge></TableCell>
                      <TableCell className="whitespace-normal">{r.summary || ""}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{[r.durationMs ? `${Math.round(r.durationMs / 1000)} s` : "", money(r.costUsd)].filter(Boolean).join(" · ")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        ) : <p className="text-sm text-muted-foreground">No runs recorded yet.</p>}
      </section>
    </>
  )
}
