import type { ReactNode } from "react"
import { ArrowDownRightIcon, ArrowUpRightIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

export function Sparkline({ data, className }: { data: number[]; className?: string }) {
  const w = 96, h = 32, max = Math.max(...data, 1), min = Math.min(...data, 0)
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - 3 - ((v - min) / (max - min || 1)) * (h - 6)])
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn("h-8 w-24", className)} aria-hidden>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="currentColor" opacity="0.12" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function StatCard({ label, value, delta, good, spark }: { label: string; value: string; delta: string; good: boolean; spark: number[] }) {
  const Arrow = delta.startsWith("-") ? ArrowDownRightIcon : ArrowUpRightIcon
  return (
    <Card size="sm">
      <CardContent className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</span>
          <span className="text-3xl font-semibold tracking-tight tabular-nums">{value}</span>
          <span className={cn("inline-flex items-center gap-1 text-xs font-medium", good ? "text-success" : "text-warning-foreground dark:text-warning")}>
            <Arrow className="size-3.5" />{delta}
          </span>
        </div>
        <Sparkline data={spark} className={good ? "text-success" : "text-warning"} />
      </CardContent>
    </Card>
  )
}

// A bar on a 0..max scale used for vitals and phase progress.
export function Meter({ value, max, tone = "primary", className }: { value: number; max: number; tone?: "primary" | "success" | "danger" | "warning"; className?: string }) {
  const color = { primary: "bg-primary", success: "bg-success", danger: "bg-destructive", warning: "bg-warning" }[tone]
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-muted", className)} role="meter" aria-valuenow={value} aria-valuemax={max}>
      <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${Math.min(100, (100 * value) / max)}%` }} />
    </div>
  )
}
