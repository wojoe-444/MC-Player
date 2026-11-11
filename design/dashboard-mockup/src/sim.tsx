// The Claude reviews and Settings pages belong to the Electron shell (app/), which talks to the main process through
// window.botApp. The mockup has no main process, so this context simulates the same state and actions with sample data.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"

export type UpdateState = { status: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "error" | "unsupported"; latest?: string; progress?: number; notes?: string; checkedAt?: string; error?: string }
export type Trigger = { id: string; title: string; enabled: boolean; intervalMin: number; running: boolean; lastRun: string | null; nextRun: string | null; lastResult: { ok: boolean; summary: string } | null }
export type Finding = { severity: "high" | "med" | "low"; title: string; evidence: string; suggestion: string; kind: string; seenRuns: number; firstSeen: string }
export type BotReview = { name: string; status: string; updatedAt: string | null; telemetry: string | null; summary: string | null; open: Finding[] }
export type Review = { at: string; text: string }

const min = (m: number) => new Date(Date.now() + m * 60000).toISOString()

const SAMPLE_BOTS: BotReview[] = [
  {
    name: "OzoGo444", status: "watching", updatedAt: min(-2),
    telemetry: "telemetry: 14 jumps/min, 46 blocks walked, 3s idle in the last minute; 1 detector flag(s) active",
    summary: "Mining steadily at Y 11 and smelting in bulk. One stall at the gravel shaft cleared by itself.",
    open: [
      { severity: "high", title: "Repeated lava deaths near Y 9", evidence: "3 deaths in 6 days within 4 blocks of (207, 9, -141); the lava bucket reflex fired late twice.", suggestion: "Place a block over lava before mining past it; widen the scan radius to 5.", kind: "safety", seenRuns: 31, firstSeen: min(-60 * 24 * 6) },
      { severity: "med", title: "Gravel stalls the ladder shaft", evidence: "Stalled 40 s at (210, 22, -145) when gravel fell into the shaft.", suggestion: "Dig around falling blocks instead of waiting for the unstuck timer.", kind: "stall", seenRuns: 12, firstSeen: min(-60 * 24 * 2) },
    ],
  },
  {
    name: "Smeo444", status: "watching", updatedAt: min(-2),
    telemetry: "telemetry: 6 jumps/min, 21 blocks walked, 0s idle in the last minute; 0 detector flag(s) active",
    summary: "Building the mob farm walls, no problems seen.",
    open: [
      { severity: "low", title: "Torches placed on the spawning platform", evidence: "2 torches found on the mob farm platform during the inspection.", suggestion: "Skip the platform's cells in the light-up pass.", kind: "build", seenRuns: 2, firstSeen: min(-60 * 3) },
    ],
  },
]
const SAMPLE_REVIEWS: Review[] = [
  { at: min(-2), text: "OzoGo444 mined steadily for 9 minutes and smelted a full stack of iron. One stall at the gravel shaft cleared on its own. Smeo444 is on the mob farm walls and made progress, no problems seen." },
  { at: min(-12), text: "Both bots active. Ozo lost 40 seconds to a gravel stall. Smeo killed two zombies without damage and kept building." },
  { at: min(-22), text: "Ozo died to lava at Y 9 after respawning into the same tunnel. Gear chest restocked. Recommend a pause before returning to that corridor." },
]

type Sim = {
  info: { version: string; dataDir: string; dashboardUrl: string; model: string; attached: boolean }
  update: UpdateState
  checkUpdate: () => void
  installUpdate: () => void
  triggers: Trigger[]
  setTrigger: (id: string, patch: Partial<Trigger>) => void
  runTrigger: (id: string) => void
  reviews: Review[]
  reviewer: { installed: boolean; intervalMin: number; running: boolean; lastRun: string | null; nextRun: string | null; lastResult: number | null; bots: BotReview[] }
  setReviewerInterval: (n: number) => void
  installTask: () => void
  removeTask: () => void
  reviewNow: () => void
}
const Ctx = createContext<Sim | null>(null)
export const useSim = () => {
  const s = useContext(Ctx)
  if (!s) throw new Error("SimProvider missing")
  return s
}

const NOTES = "Progress page: roadmap, builds and per-day numbers.\nItems acquired table on the inventory page.\nJournal: one searchable record per bot per day."

export function SimProvider({ children }: { children: ReactNode }) {
  const [update, setUpdate] = useState<UpdateState>({ status: "up-to-date", checkedAt: min(-3) })
  const [triggers, setTriggers] = useState<Trigger[]>([
    { id: "review", title: "Spectator review", enabled: true, intervalMin: 10, running: false, lastRun: min(-2), nextRun: min(8), lastResult: { ok: true, summary: "3 open findings across both bots, 1 resolved since last run." } },
    { id: "journal", title: "Daily journal rollup", enabled: true, intervalMin: 60, running: false, lastRun: min(-34), nextRun: min(26), lastResult: { ok: true, summary: "Journal written: 2 bots, 1 death, 11 stalled minutes." } },
    { id: "drive", title: "Drive the bots", enabled: false, intervalMin: 5, running: false, lastRun: null, nextRun: null, lastResult: null },
  ])
  const [reviews, setReviews] = useState<Review[]>(SAMPLE_REVIEWS)
  const [reviewer, setReviewer] = useState({ installed: true, intervalMin: 10, running: false, lastRun: min(-2) as string | null, nextRun: min(8) as string | null, lastResult: 0 as number | null, bots: SAMPLE_BOTS })
  const timers = useRef<number[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)) }

  const checkUpdate = () => {
    setUpdate((u) => ({ ...u, status: "checking" }))
    later(() => setUpdate({ status: "available", latest: "0.9.5", notes: NOTES, checkedAt: new Date().toISOString() }), 1200)
  }
  const installUpdate = () => {
    let p = 0
    const tick = () => {
      p += 20
      if (p >= 100) { setUpdate((u) => ({ ...u, status: "ready" })); later(() => setUpdate({ status: "up-to-date", checkedAt: new Date().toISOString() }), 2500); return }
      setUpdate((u) => ({ ...u, status: "downloading", progress: p }))
      later(tick, 500)
    }
    tick()
  }
  const setTrigger = (id: string, patch: Partial<Trigger>) =>
    setTriggers((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch, nextRun: patch.enabled === false ? null : patch.enabled === true || t.enabled ? min(patch.intervalMin ?? t.intervalMin) : t.nextRun } : t)))
  const runTrigger = (id: string) => {
    setTrigger(id, { running: true })
    later(() => {
      setTriggers((ts) => ts.map((t) => (t.id === id ? { ...t, running: false, lastRun: new Date().toISOString(), nextRun: t.enabled ? min(t.intervalMin) : null, lastResult: { ok: true, summary: id === "review" ? "Review done: 3 open findings." : "Done." } } : t)))
      if (id === "review") setReviews((r) => [{ at: new Date().toISOString(), text: "Fresh pass: both bots active, no new problems since the last review. The lava finding is still open." }, ...r])
    }, 2000)
  }
  const reviewNow = () => {
    setReviewer((r) => ({ ...r, running: true }))
    later(() => {
      setReviewer((r) => ({ ...r, running: false, lastRun: new Date().toISOString(), nextRun: r.installed ? min(r.intervalMin) : null }))
      setReviews((r) => [{ at: new Date().toISOString(), text: "Spectator pass: OzoGo444 mining, Smeo444 building. No new findings." }, ...r])
    }, 2200)
  }
  const sim: Sim = {
    info: { version: "0.9.4", dataDir: "C:\\Users\\you\\AppData\\Roaming\\Bot Dashboard", dashboardUrl: "http://localhost:8765", model: "haiku-5-5", attached: true },
    update, checkUpdate, installUpdate, triggers, setTrigger, runTrigger, reviews, reviewer,
    setReviewerInterval: (n) => setReviewer((r) => ({ ...r, intervalMin: n })),
    installTask: () => setReviewer((r) => ({ ...r, installed: true, nextRun: min(r.intervalMin) })),
    removeTask: () => setReviewer((r) => ({ ...r, installed: false, nextRun: null })),
    reviewNow,
  }
  return <Ctx.Provider value={sim}>{children}</Ctx.Provider>
}
