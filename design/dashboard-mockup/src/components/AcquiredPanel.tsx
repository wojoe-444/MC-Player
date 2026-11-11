import { useEffect, useMemo, useState } from "react"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ago } from "@/useDashboard"
import { BOT_IDS, type BotId } from "@/types"

// Dropped items each bot picked up (mining, mobs, farms). Chest withdrawals and re-picking its own drops are not counted, see brain/acquired.
const WINDOWS = [
  { key: "1h", label: "L1H", text: "last hour" },
  { key: "8h", label: "L8H", text: "last 8 hours" },
  { key: "24h", label: "L24H", text: "last 24 hours" },
  { key: "7d", label: "L7D", text: "last 7 days" },
  { key: "all", label: "All", text: "all time" },
] as const
type WindowKey = (typeof WINDOWS)[number]["key"]

type Acquired = { window: string; since: number; now: number; trackingSince: number | null; bots: Record<BotId, Record<string, number>> }
const NAMES: Record<BotId, string> = { ozo: "OzoGo444", smeo: "Smeo444" }
const pretty = (n: string) => n.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())

function Icon({ name }: { name: string }) {
  const [bad, setBad] = useState(false)
  if (bad) return <span className="inline-block size-6" />
  return <img src={`/tex/${name}.png`} alt="" onError={() => setBad(true)} className="size-6 [image-rendering:pixelated]" />
}

export function AcquiredPanel({ id }: { id: BotId }) {
  const [win, setWin] = useState<WindowKey>("8h")
  const [data, setData] = useState<Acquired | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    setData(null)
    const load = () =>
      fetch(`/api/acquired?window=${win}`).then((r) => r.json()).then((d: Acquired) => { if (live) { setData(d); setFailed(false) } }).catch(() => live && setFailed(true))
    load()
    const t = setInterval(load, 20_000)
    return () => { live = false; clearInterval(t) }
  }, [win])

  const rows = useMemo(() => {
    if (!data) return []
    const names = new Set(BOT_IDS.flatMap((b) => Object.keys(data.bots[b] ?? {})))
    return [...names]
      .map((n) => ({ n, per: Object.fromEntries(BOT_IDS.map((b) => [b, data.bots[b]?.[n] ?? 0])) as Record<BotId, number>, both: BOT_IDS.reduce((a, b) => a + (data.bots[b]?.[n] ?? 0), 0) }))
      .sort((a, b) => b.both - a.both || a.n.localeCompare(b.n))
  }, [data])
  const totals = useMemo(() => Object.fromEntries(BOT_IDS.map((b) => [b, rows.reduce((a, r) => a + r.per[b], 0)])) as Record<BotId, number>, [rows])
  const winText = WINDOWS.find((w) => w.key === win)?.text ?? win

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold">Items acquired · {winText}</h3>
          <p className="text-xs text-muted-foreground">
            Dropped items picked up. Taking things out of a chest or picking up its own drops is not counted.
            {data?.trackingSince ? ` Tracking since ${ago(Date.now() - data.trackingSince).replace(" ago", "")} ago.` : ""}
          </p>
        </div>
        <ToggleGroup type="single" variant="outline" size="sm" value={win} onValueChange={(v) => v && setWin(v as WindowKey)} aria-label="Time window">
          {WINDOWS.map((w) => <ToggleGroupItem key={w.key} value={w.key}>{w.label}</ToggleGroupItem>)}
        </ToggleGroup>
      </div>
      {failed && !data ? (
        <p className="text-xs text-muted-foreground">Could not load the acquired log.</p>
      ) : data && rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Nothing acquired in the {winText}</EmptyTitle>
            <EmptyDescription>
              {data.trackingSince ? "Nothing was picked up in this window." : "Counting starts when the bots restart on the code that logs pickups; earlier pickups are not backfilled."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                {BOT_IDS.map((b) => <TableHead key={b} className={`text-right ${b === id ? "text-foreground" : ""}`}>{NAMES[b]}</TableHead>)}
                <TableHead className="text-right">Both</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.n}>
                  <TableCell><span className="flex items-center gap-2"><Icon name={r.n} />{pretty(r.n)}</span></TableCell>
                  {BOT_IDS.map((b) => <TableCell key={b} className={`text-right tabular-nums ${b === id ? "font-medium" : "text-muted-foreground"}`}>{r.per[b] || "–"}</TableCell>)}
                  <TableCell className="text-right font-medium tabular-nums">{r.both}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            {rows.length > 0 && (
              <TableFooter>
                <TableRow>
                  <TableCell>Total items</TableCell>
                  {BOT_IDS.map((b) => <TableCell key={b} className="text-right tabular-nums">{totals[b]}</TableCell>)}
                  <TableCell className="text-right tabular-nums">{BOT_IDS.reduce((a, b) => a + totals[b], 0)}</TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      )}
    </div>
  )
}
