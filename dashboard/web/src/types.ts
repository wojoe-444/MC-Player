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
  _img?: { top?: number; pov?: number }
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
