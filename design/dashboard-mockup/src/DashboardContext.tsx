import { createContext, useContext } from "react"
import { useDashboard, type Dashboard } from "@/useDashboard"

const Ctx = createContext<Dashboard | null>(null)

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const d = useDashboard()
  return <Ctx.Provider value={d}>{children}</Ctx.Provider>
}

export function useData() {
  const d = useContext(Ctx)
  if (!d) throw new Error("DashboardProvider missing")
  return d
}
