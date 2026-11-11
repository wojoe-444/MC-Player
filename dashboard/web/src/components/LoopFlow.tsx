// The memory loop drawn as a flowchart (docs/MEMORY-LOOP.md), for the top of the Memory loop page. It answers one question: why is this a loop and not
// a pipeline? Two paths leave the bots' play and both come back to it. The upper one changes what the bot remembers (journal, dream, memory, dawn brief).
// The lower one changes the bot's code (work order, fixer, deployer). Each box shows where that stage stands right now, from the same state as the page.
import { type ReactNode } from "react"
import { BookOpenIcon, BrainIcon, ClipboardListIcon, GamepadIcon, MoonIcon, NewspaperIcon, RocketIcon, RotateCcwIcon, RotateCwIcon, SunriseIcon, WrenchIcon, type LucideIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { LoopBot, LoopJob, LoopRun, LoopState } from "@/botapp"

type Tone = "ok" | "run" | "warn" | "bad" | "idle"
type Line = { tone: Tone; text: string }
type NodeId = "play" | "journal" | "dream" | "memory" | "brief" | "orders" | "fix" | "deploy" | "digest"
type FlowNode = { id: NodeId; col: number; row: number; title: string; sub: string; icon: LucideIcon; lines: Line[]; tip: string; target?: string }

const MIN = 60_000
const FRESH_MS = 15 * MIN       // a bot that plays writes its journal all the time; older than this and it is most likely not running
const BRIEF_LATE_MS = 60 * MIN  // an in-game day is about 20 minutes, so a brief this old while the bot plays means nobody answers at dawn

function span(ms: number) {
  const m = Math.max(0, Math.round(ms / MIN))
  if (m < 1) return "under a minute"
  if (m < 90) return `${m} min`
  const h = Math.round(m / 60)
  return h < 36 ? `${h} h` : `${Math.round(h / 24)} d`
}
const age = (at: string | number | null | undefined, now: number) => { const t = at == null ? NaN : new Date(at).getTime(); return Number.isFinite(t) ? now - t : null }
const ago = (at: string | number | null | undefined, now: number) => { const a = age(at, now); return a == null ? "" : a < MIN ? "just now" : `${span(a)} ago` }
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`

// one line per bot, for the stages that are a file per bot
const perBot = (bots: LoopBot[], f: (b: LoopBot) => Line): Line[] => (bots.length ? bots.slice(0, 3).map(f) : [{ tone: "idle", text: "no bots found" }])

// a scheduled job: is it installed (or running this minute), and how its newest run went
function jobLines(j: LoopJob | undefined, last: LoopRun | undefined, now: number, never = "has not run yet"): Line[] {
  const first: Line = !j ? { tone: "idle", text: "not known to this app version" }
    : j.running ? { tone: "run", text: "running now" }
      : j.task?.installed ? { tone: "ok", text: "on a schedule" }
        : j.task?.unsupported ? { tone: "idle", text: "no Task Scheduler on this system" }
          : { tone: "warn", text: "not on a schedule yet" }
  const second: Line = last ? { tone: last.ok === false ? "bad" : "ok", text: `${last.ok === false ? "failed" : "ran"} ${ago(last.at, now)}` } : { tone: "idle", text: never }
  return [first, second]
}

const FIX_WORDS: Record<string, string> = {
  fixed: "opened a fix", telemetry: "added telemetry", ready: "a checked fix waits", parked: "parked an order for you", "no-fix": "found no fix",
  "gave-up": "found no fix", error: "its session failed", lost: "lost a checked fix", closed: "its pull request was closed",
}
const DEPLOY_WORDS: Record<string, string> = { deploy: "deployed", verdict: "judged", revert: "took a deploy back", refused: "refused to deploy" }

export function flowNodes(s: LoopState, now = Date.now()): FlowNode[] {
  const bots = s.bots || [], last = s.lastRuns || {}
  const job = (id: string) => (s.jobs || []).find((j) => j.id === id)
  const fresh = (b: LoopBot) => { const a = age(b.journal?.at, now); return a != null && a < FRESH_MS }

  const open = (s.orders || []).filter((o) => o.status === "open" || o.status === "parked")
  const closed = (s.orders || []).length - open.length
  const lost = Math.round(open.reduce((n, o) => n + (o.costMin || 0), 0))
  const waiting = Object.values(s.fix?.orders || {}).filter((o) => o.waiting).length

  const review = s.reviewTask?.task
  const fixLast = s.fix?.last, dep = (s.code?.last || []).slice(-1)[0]
  const fixLines = jobLines(job("fix"), last.fix, now)
  if (fixLast) fixLines[1] = { tone: fixLast.outcome === "error" ? "bad" : "ok", text: `${FIX_WORDS[fixLast.outcome] || fixLast.outcome}${fixLast.pr ? ` (#${fixLast.pr})` : ""} ${ago(s.fix?.at, now)}` }
  const depLines = jobLines(job("deploy"), last.deploy, now)
  if (dep) depLines.push({ tone: dep.event === "revert" || dep.event === "refused" ? "warn" : "ok", text: `${DEPLOY_WORDS[dep.event] || dep.event}${dep.event === "verdict" && dep.verdict ? ` ${dep.verdict}` : dep.event === "refused" && dep.why ? `: ${dep.why}` : dep.to ? ` ${dep.to}` : ""} ${ago(dep.t, now)}` })

  return [
    {
      id: "play", col: 0, row: 1, title: "The bots play", sub: "both loops start and end here", icon: GamepadIcon,
      tip: "The bots play around the clock. Everything else on this chart exists to change how they play tomorrow.",
      lines: perBot(bots, (b) => ({ tone: fresh(b) ? "ok" : b.journal ? "warn" : "idle", text: `${b.name} · ${fresh(b) ? (b.brief ? `in-game day ${b.brief.day}` : "playing") : b.journal ? `quiet for ${span(age(b.journal.at, now) || 0)}` : "not seen yet"}` })),
    },
    {
      id: "journal", col: 1, row: 1, title: "Journal", sub: "the bot's own record of each day", icon: BookOpenIcon,
      tip: "Each bot writes one line per event as it plays: steps and how they ended, alarms, deaths, items. No model is involved. Every later stage reads it.",
      lines: perBot(bots, (b) => (b.journal ? { tone: fresh(b) ? "ok" : "warn", text: `${b.name} · wrote ${ago(b.journal.at, now)}` } : { tone: "idle", text: `${b.name} · no journal yet` })),
    },
    {
      id: "dream", col: 2, row: 1, title: "Dream", sub: "checks memory against the journal", icon: MoonIcon, target: "loop-job-dream",
      tip: "A scheduled job. It reads what the bot remembers and what the journal says happened, corrects and prunes the memory, and opens a work order for a fault that memory cannot fix.",
      lines: jobLines(job("dream"), last.dream, now),
    },
    {
      id: "memory", col: 2, row: 0, title: "Memory", sub: "one small file per bot", icon: BrainIcon, target: "loop-memory",
      tip: "A short file of what the bot has learned about how to play. The dream job is the only thing that edits it, and every edit cites the journal.",
      lines: perBot(bots, (b) => (b.lastCheck ? { tone: "ok", text: `${b.name} · ${plural(b.lastCheck.changes.length, "edit")} ${ago(b.lastCheck.at, now)}` } : { tone: "idle", text: `${b.name} · ${b.memory ? "not checked yet" : "no memory file yet"}` })),
    },
    {
      id: "brief", col: 0, row: 0, title: "Dawn brief", sub: "the plan for the in-game day", icon: SunriseIcon, target: "loop-memory",
      tip: "At each in-game dawn the bot asks for a plan. The answer is written from its memory and yesterday's journal: what to focus on, what to hold off, what it does with its free time.",
      lines: [
        ...perBot(bots, (b): Line => {
          if (!b.brief) return { tone: "idle", text: `${b.name} · no brief yet` }
          const late = fresh(b) && (age(b.brief.at, now) || 0) > BRIEF_LATE_MS
          return { tone: late ? "warn" : fresh(b) ? "ok" : "idle", text: `${b.name} · day ${b.brief.day}, ${ago(b.brief.at, now)}` }
        }),
        ...(review && !review.installed && !review.unsupported ? [{ tone: "warn", text: "the review job that answers is off" } as Line] : []),
      ],
    },
    {
      id: "orders", col: 2, row: 2, title: "Work orders", sub: "faults only code can fix", icon: ClipboardListIcon, target: "loop-orders",
      tip: "When the journal shows the same fault again and again and no memory edit can stop it, the dream job opens a work order and ranks it by the minutes of play it costs.",
      lines: [
        open.length ? { tone: "warn", text: `${open.length} open · ${lost} min of play lost` } : { tone: (s.orders || []).length ? "ok" : "idle", text: "none open" },
        { tone: "idle", text: `${closed} closed${waiting ? ` · ${waiting} waiting on a fix` : ""}` },
      ],
    },
    {
      id: "fix", col: 1, row: 2, title: "Fixer", sub: "a test, a fix, a pull request", icon: WrenchIcon, target: "loop-job-fix",
      tip: "A scheduled job. It takes the most costly open work order, writes a test that shows the fault, fixes it, and opens a pull request once code checks pass.",
      lines: fixLines,
    },
    {
      id: "deploy", col: 0, row: 2, title: "Deployer", sub: "ships the fix, reverts if worse", icon: RocketIcon, target: "loop-job-deploy",
      tip: "A scheduled job with no model. It puts new code from main on the live bots, compares each bot with its own hours before, and takes the deploy back if play got clearly worse.",
      lines: depLines,
    },
    {
      id: "digest", col: 3, row: 1, title: "Digest", sub: "one page a day, for you", icon: NewspaperIcon, target: "loop-digest",
      tip: "Not part of the loop. Once a day it reads every stage and writes one page for you. It changes nothing.",
      lines: [jobLines(job("digest"), undefined, now)[0], s.digest ? { tone: "ok", text: `latest: ${s.digest.date}` } : { tone: "idle", text: "none written yet" }],
    },
  ]
}

// geometry of the drawing, in its own units (the SVG scales to the card)
const W = 212, H = 112, GX = 92, GY = 72, PAD = 16
const X = (c: number) => PAD + c * (W + GX), Y = (r: number) => PAD + r * (H + GY)
const CX = (c: number) => X(c) + W / 2, CY = (r: number) => Y(r) + H / 2
const VIEW_W = X(3) + W + PAD, VIEW_H = Y(2) + H + PAD

const DOT: Record<Tone, string> = { ok: "bg-success", run: "bg-primary animate-pulse", warn: "bg-warning", bad: "bg-destructive", idle: "bg-muted-foreground/35" }
const worst = (lines: Line[]): Tone => (["bad", "warn", "run", "ok", "idle"] as Tone[]).find((t) => lines.some((l) => l.tone === t)) || "idle"

function Box({ n }: { n: FlowNode }) {
  const go = n.target ? () => document.getElementById(n.target!)?.scrollIntoView({ behavior: "smooth", block: "start" }) : undefined
  const Icon = n.icon
  return (
    <foreignObject x={X(n.col)} y={Y(n.row)} width={W} height={H}>
      <div
        role={go ? "button" : undefined} tabIndex={go ? 0 : undefined} title={n.tip} onClick={go}
        onKeyDown={go ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go() } } : undefined}
        className={cn(
          "flex h-full flex-col rounded-xl border bg-card px-3 py-2.5 text-left text-card-foreground shadow-xs outline-none",
          n.id === "play" && "border-primary/60 bg-accent text-accent-foreground",
          n.id === "digest" && "border-dashed",
          go && "cursor-pointer transition-colors hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <div className="flex items-center gap-1.5">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate text-[13px] leading-5 font-semibold">{n.title}</span>
          <span className={cn("ml-auto size-2 shrink-0 rounded-full", DOT[worst(n.lines)])} aria-hidden />
        </div>
        <div className="truncate text-[11px] leading-4 text-muted-foreground">{n.sub}</div>
        <div className="mt-auto flex flex-col">
          {n.lines.slice(0, 3).map((l, i) => (
            <div key={i} className="flex items-center gap-1.5 text-[11px] leading-[15px]">
              <span className={cn("size-1.5 shrink-0 rounded-full", DOT[l.tone])} aria-hidden />
              <span className="truncate">{l.text}</span>
            </div>
          ))}
        </div>
      </div>
    </foreignObject>
  )
}

type Kind = "flow" | "back" | "read"
const STROKE: Record<Kind, string> = { flow: "stroke-muted-foreground/70", back: "stroke-primary", read: "stroke-muted-foreground/45" }

// a label that sits on the card: the halo in the card's colour keeps it readable where it meets a line
function Label({ x, y, anchor = "middle", strong, children }: { x: number; y: number; anchor?: "start" | "middle" | "end"; strong?: boolean; children: ReactNode }) {
  return <text x={x} y={y} textAnchor={anchor} className={cn("text-[11px]", strong ? "fill-primary font-semibold" : "fill-muted-foreground")} style={{ paintOrder: "stroke", stroke: "var(--card)", strokeWidth: 4, strokeLinejoin: "round" }}>{children}</text>
}

function Edge({ d, kind = "flow" }: { d: string; kind?: Kind }) {
  return <path d={d} fill="none" strokeWidth={kind === "back" ? 2.5 : 1.5} strokeDasharray={kind === "read" ? "4 4" : undefined} strokeLinecap="round" markerEnd={`url(#loopflow-${kind})`} className={STROKE[kind]} />
}

// the arrow tip stops 3 units short of the box it points at
const TIP = 3
const right = (c: number, r: number) => `M${X(c) + W} ${CY(r)} H${X(c + 1) - TIP}`
const left = (c: number, r: number, to = c - 1) => `M${X(c)} ${CY(r)} H${X(to) + W + TIP}`
const up = (c: number, r: number) => `M${CX(c)} ${Y(r)} V${Y(r - 1) + H + TIP}`
const down = (c: number, r: number) => `M${CX(c)} ${Y(r) + H} V${Y(r + 1) - TIP}`

function LoopName({ y, icon: Icon, name, turns }: { y: number; icon: LucideIcon; name: string; turns: string }) {
  return (
    <g>
      <Icon x={CX(1) - 9} y={y - 30} width={18} height={18} className="text-primary" aria-hidden />
      <text x={CX(1)} y={y + 4} textAnchor="middle" className="fill-foreground text-[12px] font-semibold tracking-wide uppercase">{name}</text>
      <text x={CX(1)} y={y + 20} textAnchor="middle" className="fill-muted-foreground text-[11px]">{turns}</text>
    </g>
  )
}

const every = (m?: number) => (!m ? "" : m % 60 === 0 ? `every ${m / 60} h` : `every ${m} min`)

export function LoopFlow({ s }: { s: LoopState }) {
  const nodes = flowNodes(s)
  const dream = (s.jobs || []).find((j) => j.id === "dream")
  const midTop = Y(0) + H + GY / 2, midBottom = Y(1) + H + GY / 2
  const dx = X(2) + W, ex = X(3)
  return (
    <Card>
      <CardContent className="flex flex-col gap-5">
        <div className="overflow-x-auto">
          <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="h-auto w-full min-w-[820px]" role="img" aria-label="Flowchart of the memory loop: two paths lead from the bots' play back to the bots' play, one through memory and one through code.">
            <defs>
              {(["flow", "back", "read"] as Kind[]).map((k) => (
                <marker key={k} id={`loopflow-${k}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth={k === "back" ? 5 : 6.5} markerHeight={k === "back" ? 5 : 6.5} orient="auto-start-reverse">
                  <path d="M1 1 L9 5 L1 9 Z" className={k === "back" ? "fill-primary" : k === "read" ? "fill-muted-foreground/60" : "fill-muted-foreground"} />
                </marker>
              ))}
            </defs>

            {/* the shared trunk: play is written down, and the record is read */}
            <Edge d={right(0, 1)} /><Label x={X(0) + W + GX / 2} y={CY(1) - 8}>every event</Label>
            <Edge d={right(1, 1)} /><Label x={X(1) + W + GX / 2} y={CY(1) - 8}>{every(dream?.minutes) || "on a schedule"}</Label>

            {/* the memory loop */}
            <Edge d={up(2, 1)} /><Label x={CX(2) + 10} y={midTop + 4} anchor="start">corrects and prunes</Label>
            <Edge d={left(2, 0, 0)} /><Label x={CX(1)} y={CY(0) - 8}>read at each in-game dawn</Label>
            <Edge d={down(0, 0)} kind="back" /><Label x={CX(0) + 10} y={midTop + 4} anchor="start" strong>back into play: today's plan</Label>
            <LoopName y={midTop} icon={RotateCcwIcon} name="Memory loop" turns="changes what the bot remembers" />

            {/* the code loop */}
            <Edge d={down(2, 1)} /><Label x={CX(2) + 10} y={midBottom + 4} anchor="start">what memory cannot fix</Label>
            <Edge d={left(2, 2)} /><Label x={X(1) + W + GX / 2} y={CY(2) - 8}>costliest first</Label>
            <Edge d={left(1, 2)} /><Label x={X(0) + W + GX / 2} y={CY(2) - 8}>pull request</Label>
            <Edge d={up(0, 2)} kind="back" /><Label x={CX(0) + 10} y={midBottom + 4} anchor="start" strong>back into play: new code</Label>
            <LoopName y={midBottom} icon={RotateCwIcon} name="Code loop" turns="changes the bot's code" />

            {/* the digest reads every stage and feeds nothing back */}
            <Edge kind="read" d={`M${dx} ${CY(0)} C${dx + GX * 0.7} ${CY(0)} ${ex - GX * 0.7} ${CY(1) - 26} ${ex - TIP} ${CY(1) - 26}`} />
            <Edge kind="read" d={`M${dx} ${CY(1)} H${ex - TIP}`} />
            <Edge kind="read" d={`M${dx} ${CY(2)} C${dx + GX * 0.7} ${CY(2)} ${ex - GX * 0.7} ${CY(1) + 26} ${ex - TIP} ${CY(1) + 26}`} />
            <Label x={dx + GX / 2} y={CY(1) - 8}>reads only</Label>

            {nodes.map((n) => <Box key={n.id} n={n} />)}
          </svg>
        </div>

        <div className="grid gap-x-8 gap-y-4 text-sm leading-relaxed md:grid-cols-3">
          <p><span className="font-medium">Why it is a loop.</span> <span className="text-muted-foreground">Follow either path from "The bots play" and you arrive back at "The bots play". What comes out of a turn (a better memory, a fixed step) is what the bots play the next turn with, and that play is written into the same journal the next turn reads.</span></p>
          <p><span className="font-medium">The memory loop</span> <span className="text-muted-foreground">needs no code change. The dream job holds the memory file against the journal, and the next dawn brief plans the day from the corrected file. A lesson reaches the game within one in-game day.</span></p>
          <p><span className="font-medium">The code loop</span> <span className="text-muted-foreground">takes what memory cannot fix. After a fix ships, the same journal judges it: if the fault goes quiet the dream job closes the work order, and if it comes back the order reopens and goes round again.</span></p>
        </div>
      </CardContent>
    </Card>
  )
}
