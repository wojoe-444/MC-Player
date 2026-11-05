import { useState } from "react"
import { BoxesIcon, MoonIcon, SunIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { TooltipProvider } from "@/components/ui/tooltip"
import { BotCard } from "@/components/BotCard"
import { useDashboard } from "@/useDashboard"
import { BOT_IDS } from "@/types"

type Layout = "both" | "ozo" | "smeo"

export default function App() {
  const { connected, ready, snap, logs } = useDashboard()
  const [layout, setLayout] = useState<Layout>(() => (localStorage.getItem("layout") as Layout) || "both")
  const change = (v: string) => {
    if (!v) return
    setLayout(v as Layout)
    localStorage.setItem("layout", v)
  }
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  const toggleTheme = () => {
    const next = !dark
    document.documentElement.classList.toggle("dark", next)
    localStorage.setItem("theme", next ? "dark" : "light")
    setDark(next)
  }
  const shown = BOT_IDS.filter((id) => layout === "both" || layout === id)

  return (
    <TooltipProvider>
      <div className="min-h-svh bg-background text-foreground">
        <header className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background/90 px-5 py-3 backdrop-blur">
          <div className="flex items-center gap-3">
            <BoxesIcon />
            <h1 className="text-base font-semibold tracking-tight">Bot Dashboard</h1>
            <Badge variant={connected ? "secondary" : "destructive"}>{connected ? "live" : "reconnecting"}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <ToggleGroup type="single" variant="outline" size="sm" value={layout} onValueChange={change}>
              <ToggleGroupItem value="both">Both</ToggleGroupItem>
              <ToggleGroupItem value="ozo">OzoGo444</ToggleGroupItem>
              <ToggleGroupItem value="smeo">Smeo444</ToggleGroupItem>
            </ToggleGroup>
            <Button variant="outline" size="icon-sm" onClick={toggleTheme} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>
              {dark ? <SunIcon /> : <MoonIcon />}
            </Button>
          </div>
        </header>
        <Separator />
        <main className={`grid items-start gap-4 p-5 ${shown.length > 1 ? "xl:grid-cols-2" : ""}`}>
          {!ready || !snap
            ? BOT_IDS.map((id) => <Skeleton key={id} className="h-96 w-full" />)
            : shown.map((id) => <BotCard key={id} bot={snap[id]} logs={logs[id]} />)}
        </main>
      </div>
    </TooltipProvider>
  )
}
