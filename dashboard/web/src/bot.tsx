// Which bot the per-bot pages show. One selector in the app bar replaces the shipped sidebar's two repeated bot groups.
import { createContext, useContext, useState, type ReactNode } from "react"
import type { BotId } from "@/types"

const Ctx = createContext<{ bot: BotId; setBot: (b: BotId) => void } | null>(null)

export function BotSelectionProvider({ children }: { children: ReactNode }) {
  const [bot, setBotState] = useState<BotId>(() => (localStorage.getItem("bd-bot") === "smeo" ? "smeo" : "ozo"))
  const setBot = (b: BotId) => { localStorage.setItem("bd-bot", b); setBotState(b) }
  return <Ctx.Provider value={{ bot, setBot }}>{children}</Ctx.Provider>
}
export const useBotSelection = () => {
  const c = useContext(Ctx)
  if (!c) throw new Error("BotSelectionProvider missing")
  return c
}
