// The bridge to the Electron shell (app/). The preload script exposes window.botApp (see app/preload.js); this context turns it into React state.
// In a plain browser there is no window.botApp: `available` is false and the pages that need the app (Claude reviews, Memory loop, updates) say so.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"

export type UpdateState = { status: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "ready" | "error" | "unsupported"; current?: string; latest?: string | null; progress?: number; notes?: string; checkedAt?: string | null; error?: string | null }
export type Trigger = { id: string; title: string; enabled: boolean; intervalMin: number; running: boolean; lastRun: string | null; nextRun: string | null; lastResult: { ok: boolean; summary: string } | null }
export type Review = { at: string; text: string }
export type AppState = { triggers: Trigger[]; reviews: Review[]; dashboard: { url: string; attached: boolean }; claude: { model: string } }
export type TaskState = { installed?: boolean; status?: string; nextRun?: string; lastRun?: string; lastResult?: string | number; unsupported?: boolean } | null
export type Finding = { severity: "high" | "med" | "low"; title: string; evidence: string; suggestion: string; kind: string; seenRuns: number; firstSeen: string }
export type BotReview = {
  id: string; name: string
  findings: { status: string; updatedAt: string | null; summary?: string; open: Finding[] } | null
  telemetry: { last1min?: { jumpsPerMin: number; blocksWalked: number; idleSeconds: number }; flags: unknown[] } | null
}
export type ReviewerState = { available: boolean; bots: BotReview[]; task: TaskState; taskName?: string }
export type LoopJob = { id: string; title: string; about: string; taskName: string; minutes: number; maxMinutes: number; running: boolean; task: TaskState }
export type LoopOrder = {
  key: string; title: string; status: string; kind: string; costMin: number; problem?: string; suggestion?: string; openedAt: string; seenDreams: number; reopens?: number; pr?: number
  closed?: { reason: string }; findings?: string[]; bots?: Record<string, { costMin: number; line: string; evidence?: string[] }>
}
export type LoopBot = {
  id: string; name: string; memory: string | null
  brief: { at: string; day: number; intent?: string; focus?: string[]; holds?: { step: string; untilDay: number; why: string }[]; freeTime?: { choice: string; note?: string }; ask?: string } | null
  lastCheck: { at: string; changes: { step: string; op: string; from?: string; to?: string; why?: string; cites?: string[] }[]; calls?: { step: string; ok: boolean }[]; skippedSteps?: Record<string, unknown>; costUsd?: number; dropped?: string[] } | null
}
export type FixMode = "merge" | "pr" | "local"
export type LoopFix = {
  mode: FixMode; repo: string; workDir: string; hasClone: boolean; at: string | null
  gh: { ok: boolean; note: string } | null
  last: { order: string; outcome: string; pr: number | null; note?: string } | null
  orders: Record<string, { attempts: number; waiting: { on: "merge" | "deploy" | "verdict"; pr?: number } | null; ready: { branch: string; why?: string } | null }>
}
export type LoopRun = { at: string; job: string; ok?: boolean; summary?: string; durationMs?: number; costUsd?: number }
export type LoopState = {
  available: boolean; loopDir?: string; jobs?: LoopJob[]
  code?: { dir: string | null; isClone: boolean; hasDeployer: boolean; last: { event: string; to?: string; why?: string; verdict?: string; t: string }[] }
  digest?: { date: string; text: string } | null
  reviewTask?: { title: string; taskName: string; task: TaskState }
  orders?: LoopOrder[]; runs?: LoopRun[]; bots?: LoopBot[]
  fix?: LoopFix | null
}
export type AppInfo = { version: string; packaged: boolean; dataDir: string; dashboardUrl: string }
type Result<S> = { ok?: boolean; error?: string; state?: S }

type BotApp = {
  state: () => Promise<AppState>
  runTrigger: (id: string) => Promise<boolean>
  setTrigger: (id: string, patch: { enabled?: boolean; intervalMin?: number }) => Promise<AppState>
  reviewerState: () => Promise<ReviewerState>
  reviewerRun: () => Promise<boolean>
  reviewerInstall: (minutes: number) => Promise<Result<ReviewerState>>
  reviewerUninstall: () => Promise<Result<ReviewerState>>
  onReviewer: (cb: (s: ReviewerState) => void) => void
  loopState: () => Promise<LoopState>
  loopRun: (id: string) => Promise<boolean>
  loopInstall: (id: string, minutes: number) => Promise<Result<LoopState>>
  loopUninstall: (id: string) => Promise<Result<LoopState>>
  loopCodeDir: (dir: string) => Promise<Result<LoopState>>
  loopFixMode?: (mode: FixMode) => Promise<Result<LoopState>>
  onLoop: (cb: (s: LoopState) => void) => void
  appInfo: () => Promise<AppInfo>
  updateState: () => Promise<UpdateState>
  updateCheck: () => Promise<UpdateState>
  updateInstall: () => Promise<UpdateState>
  onUpdate: (cb: (s: UpdateState) => void) => void
  onState: (cb: (s: AppState) => void) => void
  onNavigate?: (cb: (page: string) => void) => void
}
declare global { interface Window { botApp?: BotApp } }

type Ctx = {
  available: boolean
  info: AppInfo | null
  update: UpdateState
  checkUpdate: () => void
  installUpdate: () => void
  state: AppState | null
  setTrigger: (id: string, patch: { enabled?: boolean; intervalMin?: number }) => void
  runTrigger: (id: string) => void
  reviewer: ReviewerState | null
  reviewerRunning: boolean
  reviewNow: () => void
  installReviewer: (minutes: number) => Promise<string | null>
  removeReviewer: () => void
  loop: LoopState | null
  refreshLoop: () => void
  runLoopJob: (id: string) => void
  installLoopJob: (id: string, minutes: number) => Promise<string | null>
  removeLoopJob: (id: string) => void
  saveCodeDir: (dir: string) => Promise<string | null>
  saveFixMode: (mode: FixMode) => Promise<string | null>
  /** page ids the main process asked to show (menu shortcuts) */
  onNavigate: (cb: (page: string) => void) => void
}
const AppCtx = createContext<Ctx | null>(null)
export const useApp = () => {
  const c = useContext(AppCtx)
  if (!c) throw new Error("AppProvider missing")
  return c
}

const POLL_MS = 60_000

export function AppProvider({ children }: { children: ReactNode }) {
  const api = typeof window !== "undefined" ? window.botApp : undefined
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [update, setUpdate] = useState<UpdateState>({ status: api ? "idle" : "unsupported" })
  const [state, setState] = useState<AppState | null>(null)
  const [reviewer, setReviewer] = useState<ReviewerState | null>(null)
  const [reviewerRunning, setReviewerRunning] = useState(false)
  const [loop, setLoop] = useState<LoopState | null>(null)
  const navCb = useRef<((page: string) => void) | null>(null)

  const refreshReviewer = useCallback(() => { api?.reviewerState().then(setReviewer).catch(() => {}) }, [api])
  const refreshLoop = useCallback(() => { api?.loopState().then(setLoop).catch(() => {}) }, [api])

  useEffect(() => {
    if (!api) return
    api.appInfo().then(setInfo).catch(() => {})
    api.updateState().then(setUpdate).catch(() => {})
    api.state().then(setState).catch(() => {})
    refreshReviewer()
    api.onUpdate(setUpdate)
    api.onState(setState)
    api.onReviewer((r) => { setReviewer(r); setReviewerRunning(false) })
    api.onLoop(setLoop)
    api.onNavigate?.((page) => navCb.current?.(page))
    const t = setInterval(refreshReviewer, POLL_MS)
    return () => clearInterval(t)
  }, [api, refreshReviewer])

  const value = useMemo<Ctx>(() => ({
    available: !!api,
    info, update, state, reviewer, reviewerRunning, loop, refreshLoop,
    checkUpdate: () => { api?.updateCheck().then(setUpdate) },
    installUpdate: () => { api?.updateInstall().then(setUpdate) },
    setTrigger: (id, patch) => { api?.setTrigger(id, patch).then(setState) },
    runTrigger: (id) => { api?.runTrigger(id) },
    reviewNow: () => { setReviewerRunning(true); api?.reviewerRun().then((started) => { if (!started) setReviewerRunning(false) }) },
    installReviewer: async (minutes) => {
      const r = await api!.reviewerInstall(minutes)
      if (r.state) setReviewer(r.state)
      return r.ok ? null : r.error || "unknown error"
    },
    removeReviewer: () => { api?.reviewerUninstall().then((r) => { if (r.state) setReviewer(r.state) }) },
    runLoopJob: (id) => { api?.loopRun(id).then(refreshLoop) },
    installLoopJob: async (id, minutes) => {
      const r = await api!.loopInstall(id, minutes)
      if (r.state) setLoop(r.state)
      return r.ok ? null : r.error || "unknown error"
    },
    removeLoopJob: (id) => { api?.loopUninstall(id).then((r) => { if (r.state) setLoop(r.state) }) },
    saveCodeDir: async (dir) => {
      const r = await api!.loopCodeDir(dir)
      if (r.state) setLoop(r.state)
      return r.ok ? null : r.error || "unknown error"
    },
    saveFixMode: async (mode) => {
      if (!api?.loopFixMode) return "this version of the app cannot set it"
      const r = await api.loopFixMode(mode)
      if (r.state) setLoop(r.state)
      return r.ok ? null : r.error || "unknown error"
    },
    onNavigate: (cb) => { navCb.current = cb },
  }), [api, info, update, state, reviewer, reviewerRunning, loop, refreshLoop])

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>
}

/** true when an update can be installed (puts the dot on Settings in the sidebar) */
export const updatePending = (u: UpdateState) => u.status === "available" || u.status === "downloading" || u.status === "ready"
