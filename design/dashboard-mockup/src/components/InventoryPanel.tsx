import { useState } from "react"
import { InfoIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ago, useNow } from "@/useDashboard"
import type { BotStatus } from "@/types"

type Stack = { n: string; c: number }

/** Experience level, progress toward the next level, and total points. */
function XpBar({ xp }: { xp: BotStatus["xp"] }) {
  if (!xp) {
    return <p className="text-xs text-muted-foreground">Experience: not published yet. It appears once the bot's senses module writes <code className="font-mono">xp</code> to views/latest.json.</p>
  }
  const pct = Math.round(Math.max(0, Math.min(1, xp.progress)) * 100)
  return (
    <div className="flex max-w-md flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Experience</span>
        <Badge>level {xp.level}</Badge>
        <span className="text-xs text-muted-foreground tabular-nums">{xp.points} points · {pct}% to level {xp.level + 1}</span>
      </div>
      <Progress value={pct} aria-label={`Experience progress to level ${xp.level + 1}`} />
    </div>
  )
}

const pretty = (n: string) => n.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())
const SINGLE = /(_pickaxe|_axe|_shovel|_hoe|_sword|_helmet|_chestplate|_leggings|_boots|_bed|bucket|shield|bow|crossbow|elytra|shears|flint_and_steel|fishing_rod|totem|boat|minecart)$/

function Icon({ name }: { name: string }) {
  const [bad, setBad] = useState(false)
  if (bad) return <span className="text-[10px] font-semibold text-muted-foreground uppercase">{name.slice(0, 3)}</span>
  return <img src={`/tex/${name}.png`} alt="" onError={() => setBad(true)} className="size-7 [image-rendering:pixelated]" />
}

function Slot({ stack, held, label }: { stack?: Stack | null; held?: boolean; label?: string }) {
  const box = (
    <div
      className={`relative flex size-11 items-center justify-center rounded-md border bg-muted/50 ${held ? "ring-2 ring-primary" : ""}`}
      aria-label={stack ? `${pretty(stack.n)} ${stack.c}` : label ? `${label} empty` : "empty slot"}
    >
      {stack ? (
        <>
          <Icon name={stack.n} />
          {stack.c > 1 && <span className="absolute right-0.5 bottom-0 text-[11px] leading-none font-semibold tabular-nums text-foreground [text-shadow:0_0_3px_var(--background)]">{stack.c}</span>}
        </>
      ) : label ? (
        <span className="text-[9px] text-muted-foreground">{label}</span>
      ) : null}
    </div>
  )
  if (!stack) return box
  return (
    <Tooltip>
      <TooltipTrigger asChild>{box}</TooltipTrigger>
      <TooltipContent>{pretty(stack.n)} × {stack.c}</TooltipContent>
    </Tooltip>
  )
}

// fallback when the bot has not published slots yet: total counts split into plausible stacks
function approximateStacks(bag: Record<string, number>): Stack[] {
  const out: Stack[] = []
  for (const [n, total] of Object.entries(bag).sort((a, b) => b[1] - a[1])) {
    const max = SINGLE.test(n) ? 1 : 64
    for (let left = total; left > 0; left -= max) out.push({ n, c: Math.min(max, left) })
  }
  return out
}

export function InventoryPanel({ status }: { status: BotStatus }) {
  const now = useNow()
  const age = now - new Date(status.at).getTime()
  const inv = status.inv

  if (!inv) {
    const stacks = approximateStacks(status.bag ?? {})
    const cells = Array.from({ length: Math.max(36, Math.ceil(stacks.length / 9) * 9) }, (_, i) => stacks[i] ?? null)
    return (
      <div className="flex flex-col gap-4">
        <Alert>
          <InfoIcon />
          <AlertTitle>Totals only, slot layout not published yet</AlertTitle>
          <AlertDescription>
            The bot currently reports item totals, not which slot holds what. Stacks below are the totals split into plausible stacks, so hotbar, offhand and armor positions are unknown. It switches to the real layout once the bot adds <code className="font-mono">inv</code> to its views/latest.json.
          </AlertDescription>
        </Alert>
        <XpBar xp={status.xp} />
        <div className="grid w-fit grid-cols-9 gap-1">{cells.map((s, i) => <Slot key={i} stack={s} />)}</div>
        {(status.armor ?? []).length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Worn</span>
            {(status.armor ?? []).map((a, i) => <Badge key={i} variant="outline">{pretty(typeof a === "string" ? a : (a.name ?? "?"))}</Badge>)}
          </div>
        )}
        <span className="text-xs text-muted-foreground">Snapshot {age < 90_000 ? `${Math.round(age / 1000)}s` : ago(age).replace(" ago", "")} old</span>
      </div>
    )
  }

  const by = new Map(inv.slots.map((s) => [s.s, { n: s.n, c: s.c }]))
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
  const armorLabels = ["Head", "Chest", "Legs", "Feet"]
  const held = inv.held
  const heldStack = by.get(36 + held)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Holding</span>
        <Badge variant={heldStack ? "default" : "outline"}>{heldStack ? `${pretty(heldStack.n)} × ${heldStack.c}` : "empty hand"}</Badge>
        <span className="text-xs text-muted-foreground">hotbar slot {held + 1} · snapshot {ago(age)}</span>
      </div>
      <XpBar xp={status.xp} />
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Armor</span>
          <div className="flex gap-1 sm:flex-col">
            {range(5, 8).map((s, i) => <Slot key={s} stack={by.get(s)} label={armorLabels[i]} />)}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Offhand</span>
          <Slot stack={by.get(45)} label="Off" />
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Inventory</span>
            <div className="grid grid-cols-9 gap-1">{range(9, 35).map((s) => <Slot key={s} stack={by.get(s)} />)}</div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Hotbar</span>
            <div className="grid grid-cols-9 gap-1">{range(36, 44).map((s) => <Slot key={s} stack={by.get(s)} held={s === 36 + held} />)}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
