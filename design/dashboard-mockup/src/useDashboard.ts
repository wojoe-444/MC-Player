import { useEffect, useState } from "react"
import { BOT_IDS, type BotId, type BotSnap, type LogEntry } from "@/types"

const MAXLOG = 1500

export type Dashboard = {
  connected: boolean
  ready: boolean
  snap: Record<BotId, BotSnap> | null
  logs: Record<BotId, LogEntry[]>
}

const emptyLogs = (): Record<BotId, LogEntry[]> => ({ ozo: [], smeo: [] })

export function useDashboard(): Dashboard {
  const [state, setState] = useState<Dashboard>({ connected: false, ready: false, snap: null, logs: emptyLogs() })

  useEffect(() => {
    const es = new EventSource("/api/stream")
    es.addEventListener("init", (ev) => {
      const d = JSON.parse((ev as MessageEvent).data)
      setState({ connected: true, ready: true, snap: d.snapshot, logs: { ...emptyLogs(), ...d.logs } })
    })
    es.addEventListener("status", (ev) => {
      const snap = JSON.parse((ev as MessageEvent).data)
      setState((s) => ({ ...s, snap, connected: true }))
    })
    es.addEventListener("log", (ev) => {
      const fresh: LogEntry[] = JSON.parse((ev as MessageEvent).data)
      setState((s) => {
        const logs = { ...s.logs }
        for (const id of BOT_IDS) {
          const last = logs[id].length ? logs[id][logs[id].length - 1].id : 0
          const add = fresh.filter((e) => e.bot === id && e.id > last)
          if (add.length) logs[id] = [...logs[id], ...add].slice(-MAXLOG)
        }
        return { ...s, logs }
      })
    })
    es.addEventListener("ping", () => setState((s) => (s.connected ? s : { ...s, connected: true })))
    es.onerror = () => setState((s) => ({ ...s, connected: false }))
    return () => es.close()
  }, [])

  return state
}

// re-render every few seconds so "x s ago" stays fresh
export function useNow(ms = 5000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  return `${(s / 3600).toFixed(1)}h ago`
}
