import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { CheckIcon, PaletteIcon } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { applyTheme, GROUPS, loadTheme, PALETTES, tokens, type Palette, type ThemeState } from "@/theme"
import { cn } from "@/lib/utils"

type Ctx = ThemeState & { setPalette: (id: string) => void; setDark: (d: boolean) => void; cycle: (dir: 1 | -1) => void }
const ThemeCtx = createContext<Ctx | null>(null)
export const useTheme = () => {
  const c = useContext(ThemeCtx)
  if (!c) throw new Error("ThemeProvider missing")
  return c
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<ThemeState>(loadTheme)
  useEffect(() => applyTheme(t), [t])
  const cycle = (dir: 1 | -1) => setT((s) => {
    const i = PALETTES.findIndex((p) => p.id === s.palette)
    return { ...s, palette: PALETTES[(i + dir + PALETTES.length) % PALETTES.length].id }
  })
  return <ThemeCtx.Provider value={{ ...t, setPalette: (palette) => setT((s) => ({ ...s, palette })), setDark: (dark) => setT((s) => ({ ...s, dark })), cycle }}>{children}</ThemeCtx.Provider>
}

/** Strip of the colors that define a palette: drawer, page, card, primary, accent, status. */
export function Swatches({ p, dark, className }: { p: Palette; dark: boolean; className?: string }) {
  const t = tokens(p, dark)
  const cols = [t.sidebar, t.background, t.card, t.primary, t.accent, t["chart-2"], t["chart-3"]]
  return (
    <span className={cn("flex h-5 overflow-hidden rounded-md ring-1 ring-black/10 dark:ring-white/15", className)}>
      {cols.map((c, i) => <span key={i} className="h-full flex-1" style={{ background: c }} />)}
    </span>
  )
}

export function ThemeSelect() {
  const { palette, setPalette, dark } = useTheme()
  const cur = PALETTES.find((p) => p.id === palette) ?? PALETTES[0]
  return (
    <Select value={palette} onValueChange={setPalette}>
      <SelectTrigger className="w-48" aria-label="Color scheme">
        <PaletteIcon className="size-4 text-muted-foreground" />
        <SelectValue>{cur.name}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="min-w-64">
        {GROUPS.map((g, gi) => (
          <SelectGroup key={g.label}>
            {gi > 0 && <SelectSeparator />}
            <SelectLabel>{g.label}</SelectLabel>
            {PALETTES.slice(g.from, g.to).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span className="flex items-center gap-3"><Swatches p={p} dark={dark} className="w-16 shrink-0" />{p.name}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

export function AppearanceCard() {
  const { palette, setPalette, dark, setDark } = useTheme()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>Pick a color scheme. It applies instantly and is remembered. The same picker lives in the top bar.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">Mode</span>
          {[false, true].map((d) => (
            <button key={String(d)} onClick={() => setDark(d)} className={cn("rounded-lg border px-4 py-1.5 text-sm font-medium transition-colors", dark === d ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")}>{d ? "Dark" : "Light"}</button>
          ))}
        </div>
        {GROUPS.map((g) => (
          <div key={g.label} className="flex flex-col gap-3">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.label}</h3>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {PALETTES.slice(g.from, g.to).map((p) => (
              <button key={p.id} onClick={() => setPalette(p.id)} aria-pressed={p.id === palette}
                className={cn("flex flex-col gap-3 rounded-xl border p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-md", p.id === palette ? "border-primary ring-2 ring-primary/30" : "")}>
                <Swatches p={p} dark={dark} className="h-9" />
                <span className="flex items-center justify-between gap-2">
                  <span className="flex flex-col"><span className="text-sm font-semibold">{p.name}</span><span className="text-xs text-muted-foreground">{p.blurb}</span></span>
                  {p.id === palette && <CheckIcon className="size-4 shrink-0 text-primary" />}
                </span>
              </button>
            ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
