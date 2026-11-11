import { useMemo, useState } from "react"
import { ShieldIcon } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ItemTile, PageHeader, Swatch } from "@/components/common"
import { ACQUIRED, ARMOR, GRID, HOTBAR } from "@/data"

const WINDOWS = [["1h", "L1H", "last hour"], ["8h", "L8H", "last 8 hours"], ["24h", "L24H", "last 24 hours"], ["7d", "L7D", "last 7 days"], ["all", "All", "all time"]] as const

export function Inventory() {
  const [bot, setBot] = useState("ozo")
  const [win, setWin] = useState<string>("8h")
  const rows = useMemo(() => [...ACQUIRED[win]].sort((a, b) => b.ozo + b.smeo - (a.ozo + a.smeo)), [win])
  const tot = rows.reduce((a, r) => ({ ozo: a.ozo + r.ozo, smeo: a.smeo + r.smeo }), { ozo: 0, smeo: 0 })
  const text = WINDOWS.find((w) => w[0] === win)![2]
  const max = Math.max(...rows.map((r) => r.ozo + r.smeo))
  return (
    <>
      <PageHeader title="Inventory" description="What the bot is carrying right now, and what both bots have picked up over time.">
        <ToggleGroup type="single" variant="outline" value={bot} onValueChange={(v) => v && setBot(v)}>
          <ToggleGroupItem value="ozo">OzoGo444</ToggleGroupItem>
          <ToggleGroupItem value="smeo">Smeo444</ToggleGroupItem>
        </ToggleGroup>
      </PageHeader>

      <section className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardHeader>
            <CardTitle>Carried items</CardTitle>
            <CardDescription>Hotbar and main grid as of the latest snapshot, 12 seconds ago.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Hotbar</span>
              <div className="flex flex-wrap gap-2">{HOTBAR.map((it, i) => <ItemTile key={i} item={it} />)}</div>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Main inventory</span>
              <div className="grid w-fit grid-cols-9 gap-2">{GRID.map((it, i) => <ItemTile key={i} item={it} />)}</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><ShieldIcon className="size-4 text-primary" />Armor</CardTitle><CardDescription>Helmet, chest, legs, boots.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex gap-2">{ARMOR.map((it, i) => <ItemTile key={i} item={it} />)}</div>
            <div className="flex items-center justify-between rounded-lg bg-muted/60 p-4 text-sm"><span className="text-muted-foreground">Armor points</span><span className="font-semibold tabular-nums">11 / 20</span></div>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Items acquired · {text}</CardTitle>
          <CardDescription>Dropped items picked up. Taking things out of a chest or picking up its own drops is not counted. Tracking since 3 days ago.</CardDescription>
          <div className="pt-2">
            <ToggleGroup type="single" variant="outline" size="sm" value={win} onValueChange={(v) => v && setWin(v)} aria-label="Time window">
              {WINDOWS.map((w) => <ToggleGroupItem key={w[0]} value={w[0]}>{w[1]}</ToggleGroupItem>)}
            </ToggleGroup>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow><TableHead className="pl-4">Item</TableHead><TableHead className="w-1/3">Share</TableHead><TableHead className="text-right">OzoGo444</TableHead><TableHead className="text-right">Smeo444</TableHead><TableHead className="pr-4 text-right">Both</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.item}>
                    <TableCell className="pl-4"><span className="flex items-center gap-3 font-medium"><Swatch color={r.color} />{r.item}</span></TableCell>
                    <TableCell>
                      <span className="flex h-2 overflow-hidden rounded-full bg-muted" style={{ width: `${(100 * (r.ozo + r.smeo)) / max}%`, minWidth: 6 }}>
                        <span className="h-full bg-chart-1" style={{ width: `${(100 * r.ozo) / (r.ozo + r.smeo)}%` }} /><span className="h-full bg-chart-2" style={{ width: `${(100 * r.smeo) / (r.ozo + r.smeo)}%` }} />
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.ozo || <span className="text-muted-foreground">–</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.smeo || <span className="text-muted-foreground">–</span>}</TableCell>
                    <TableCell className="pr-4 text-right font-semibold tabular-nums">{(r.ozo + r.smeo).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow><TableCell className="pl-4 font-medium" colSpan={2}>Total items</TableCell><TableCell className="text-right tabular-nums">{tot.ozo.toLocaleString()}</TableCell><TableCell className="text-right tabular-nums">{tot.smeo.toLocaleString()}</TableCell><TableCell className="pr-4 text-right font-semibold tabular-nums">{(tot.ozo + tot.smeo).toLocaleString()}</TableCell></TableRow>
              </TableFooter>
            </Table>
          </div>
          <div className="mt-4 flex items-center gap-6 text-xs text-muted-foreground">
            <span className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-chart-1" />OzoGo444</span>
            <span className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-chart-2" />Smeo444</span>
          </div>
        </CardContent>
      </Card>
    </>
  )
}
