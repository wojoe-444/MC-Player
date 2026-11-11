import { lazy, Suspense, useEffect } from "react"
import { Route, Routes, useLocation, useNavigate } from "react-router-dom"
import { Loader2Icon, MoonIcon, SunIcon } from "lucide-react"
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar, GROUPS } from "@/components/AppSidebar"
import { BotSelectionProvider, useBotSelection } from "@/bot"
import { DashboardProvider, useData } from "@/DashboardContext"
import { AppProvider, useApp } from "@/botapp"
import { Behavior, Dashboard, Inventory, Live, Logs, Memory, Progress, Replay, Structure } from "@/pages/Monitor"
import { Loop } from "@/pages/Loop"
import { Arenas } from "@/pages/Arenas"
import { Reviews } from "@/pages/Reviews"
import { Settings } from "@/pages/Settings"
import { useFresh } from "@/components/BotParts"
import { PageHeader } from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { BOT_IDS } from "@/types"
import { ThemeProvider, ThemeSelect, useTheme } from "@/components/ThemePicker"

// three.js is large: the Bases page loads on first visit
const Bases = lazy(() => import("@/pages/Bases").then((m) => ({ default: m.Bases })))

const Schematics = lazy(() => import("@/pages/Schematics").then((m) => ({ default: m.Schematics })))

// Shown while the Bases page chunk downloads (heading first, so the page never sits empty)
function BasesFallback() {
  return (
    <>
      <PageHeader title="Bases" description="A base as a metal cast: the space the bots dug and built, with the solid world taken away, like casting metal into an ant colony. A base is a waypoint." />
      <div className="dark flex h-[34rem] items-center justify-center rounded-xl bg-zinc-950 text-zinc-400 xl:h-[40rem]" role="status" aria-live="polite">
        <Loader2Icon className="size-8 animate-spin" />
      </div>
    </>
  )
}

const PER_BOT = ["/progress", "/live", "/inventory", "/replay", "/behavior", "/structure", "/memory"]

function BotStatusPills() {
  const { snap } = useData()
  if (!snap) return null
  return (
    <div className="hidden items-center gap-2 lg:flex">
      {BOT_IDS.map((id) => <Pill key={id} id={id} />)}
    </div>
  )
}
function Pill({ id }: { id: "ozo" | "smeo" }) {
  const { snap } = useData()
  const { live } = useFresh(snap![id])
  return <Badge variant={live ? "success" : "destructive"}><span className={`size-1.5 rounded-full ${live ? "bg-success" : "bg-destructive"}`} />{snap![id].name} {live ? "live" : "stale"}</Badge>
}

function Shell() {
  const { dark, setDark } = useTheme()
  const { pathname } = useLocation()
  const { bot, setBot } = useBotSelection()
  const navigate = useNavigate()
  const { onNavigate } = useApp()
  // the app's menu shortcuts (Ctrl+1..4) ask the page to switch
  useEffect(() => onNavigate((page) => navigate(page)), [onNavigate, navigate])
  const group = GROUPS.find((g) => g.items.some((i) => i.to === pathname))
  const page = group?.items.find((i) => i.to === pathname)
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-4 border-b bg-background/85 px-6 backdrop-blur">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-6" />
          <Breadcrumb className="flex-1">
            <BreadcrumbList>
              <BreadcrumbItem className="text-muted-foreground">{group?.label ?? "Monitor"}</BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem><BreadcrumbPage className="font-medium">{page?.label ?? "Dashboard"}</BreadcrumbPage></BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          {PER_BOT.includes(pathname) && (
            <ToggleGroup type="single" variant="outline" size="sm" value={bot} onValueChange={(v) => v && setBot(v as "ozo" | "smeo")} aria-label="Selected bot">
              <ToggleGroupItem value="ozo">OzoGo444</ToggleGroupItem>
              <ToggleGroupItem value="smeo">Smeo444</ToggleGroupItem>
            </ToggleGroup>
          )}
          <BotStatusPills />
          <ThemeSelect />
          <Button variant="outline" size="icon" onClick={() => setDark(!dark)} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>{dark ? <SunIcon /> : <MoonIcon />}</Button>
        </header>
        <main className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-8 p-6 lg:p-8">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/progress" element={<Progress />} />
            <Route path="/bases" element={<Suspense fallback={<BasesFallback />}><Bases /></Suspense>} />
            <Route path="/schematics" element={<Suspense fallback={<BasesFallback />}><Schematics /></Suspense>} />
            <Route path="/arenas" element={<Arenas />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/live" element={<Live />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/replay" element={<Replay />} />
            <Route path="/behavior" element={<Behavior />} />
            <Route path="/structure" element={<Structure />} />
            <Route path="/memory" element={<Memory />} />
            <Route path="/reviews" element={<Reviews />} />
            <Route path="/loop" element={<Loop />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Dashboard />} />
          </Routes>
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default function App() {
  return (
    <TooltipProvider>
      <ThemeProvider>
      <DashboardProvider>
        <BotSelectionProvider>
          <AppProvider>
            <Shell />
          </AppProvider>
        </BotSelectionProvider>
      </DashboardProvider>
      </ThemeProvider>
    </TooltipProvider>
  )
}
