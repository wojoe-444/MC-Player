export type BotId = "ozo" | "smeo"
export const BOT_IDS: BotId[] = ["ozo", "smeo"]

export type BotStatus = {
  at: string
  bot: string
  role?: string
  step?: string | null
  hp: number
  food: number
  time: number
  sleeping: boolean
  me?: [number, number, number]
  bag?: Record<string, number>
  armor?: (string | { name?: string })[]
  spawnable?: number
  torches?: number
  lookingAt?: { block: string; dist: number } | null
  /** slot-level inventory (mineflayer slot numbers: 5-8 armor, 9-35 main, 36-44 hotbar, 45 offhand); published by the bot */
  /** experience: level, total points, progress 0..1 toward the next level; published by the bot's senses module */
  xp?: { level: number; points: number; progress: number } | null
  inv?: { slots: { s: number; n: string; c: number; d?: number }[]; held: number }
  _img?: { top?: number; pov?: number; slice?: number }
}

export type BotSnap = {
  id: BotId
  name: string
  viewerPort: number
  status: BotStatus | null
  goal: string | null
  plan: string | null
}

export type LogEntry = { id: number; bot: BotId; t: string | null; kind: string; text: string }

// /api/progress (dashboard/progress.js)
export type RoadmapItem = { id: string; phase: string; title: string; status: "done" | "open" | "unmeasured"; needs: string | null }
export type RoadmapPhase = { id: string; name: string; blurb: string; total: number; measured: number; done: number; items: RoadmapItem[] }
export type BuildRow = {
  id: string
  kind: string
  label: string
  pos: number[] | null
  by?: string | null
  at?: string | null
  depth?: number | null
  chests?: number
  hasReset?: boolean
  detail?: string
  status: "passes" | "faults" | "unchecked" | "built" | "working" | "digging"
  inspection: { at: string | null; faults: number; warns: number; headline: string[] } | null
}
export type GameDay = { day: number; iron: number; ingots: number; tunnels: number; deaths: number; armor: string | null; commits: string[]; done: boolean }
export type RealDay = {
  date: string
  journal: boolean
  deaths: number | null
  stalledMin: number | null
  alarms: number | null
  flagsHigh: number | null
  commits: number | null
  activeMin: number | null
  topSteps: { id: string; minutes: number; runs: number; fail: number }[]
  iron: number | null
  ingots: number | null
  diamonds: number | null
  items: number | null
}
export type BotProgress = {
  id: BotId
  name: string
  roadmap: { source: "bot" | "live" | "stale"; at: string | null; phases: RoadmapPhase[] } | null
  inspectionAt: string | null
  ownBuilds: BuildRow[]
  gameDays: GameDay[] | null
  days: RealDay[]
  hasJournal: boolean
}
export type Progress = {
  generatedAt: string
  phases: { id: string; name: string; blurb: string }[]
  registry: { found: boolean; shared: boolean }
  builds: BuildRow[]
  bots: Record<BotId, BotProgress>
}
