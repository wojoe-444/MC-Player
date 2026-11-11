import { useState } from "react"
import { Route, Routes, useLocation } from "react-router-dom"
import { MoonIcon, SunIcon } from "lucide-react"
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar, GROUPS } from "@/components/AppSidebar"
import { BotSelectionProvider, useBotSelection } from "@/bot"
import { DashboardProvider, useData } from "@/DashboardContext"
import { SimProvider } from "@/sim"
import { Behavior, Dashboard, Inventory, Live, Logs, Memory, Progress, Replay, Structure } from "@/pages/Monitor"
import { Reviews } from "@/pages/Reviews"
import { Settings } from "@/pages/Settings"
import { useFresh } from "@/components/BotParts"
import { Badge } from "@/components/ui/badge"
import { BOT_IDS } from "@/types"

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
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  const { pathname } = useLocation()
  const { bot, setBot } = useBotSelection()
  const group = GROUPS.find((g) => g.items.some((i) => i.to === pathname))
  const page = group?.items.find((i) => i.to === pathname)
  const toggle = () => {
    const next = !dark
    document.documentElement.classList.toggle("dark", next)
    localStorage.setItem("mock-theme", next ? "dark" : "light")
    setDark(next)
  }
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
          <Button variant="outline" size="icon" onClick={toggle} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>{dark ? <SunIcon /> : <MoonIcon />}</Button>
        </header>
        <main className="mx-auto flex w-full min-w-0 max-w-[96rem] flex-col gap-8 p-6 lg:p-8">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/progress" element={<Progress />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/live" element={<Live />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/replay" element={<Replay />} />
            <Route path="/behavior" element={<Behavior />} />
            <Route path="/structure" element={<Structure />} />
            <Route path="/memory" element={<Memory />} />
            <Route path="/reviews" element={<Reviews />} />
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
      <DashboardProvider>
        <BotSelectionProvider>
          <SimProvider>
            <Shell />
          </SimProvider>
        </BotSelectionProvider>
      </DashboardProvider>
    </TooltipProvider>
  )
}
