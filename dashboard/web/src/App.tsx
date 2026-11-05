import { useState } from "react"
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom"
import { MoonIcon, SunIcon } from "lucide-react"
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar } from "@/components/AppSidebar"
import { DashboardProvider } from "@/DashboardContext"
import { BotBehavior, BotInventory, BotLayout, BotLive, BotReplay, BotStructure, Logs, Memory, Overview } from "@/pages"

const NAMES: Record<string, string> = { ozo: "OzoGo444", smeo: "Smeo444", logs: "Logs", memory: "Memory and data" }
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function Crumbs() {
  const parts = useLocation().pathname.split("/").filter(Boolean)
  if (parts.length === 0) return <BreadcrumbPage>Overview</BreadcrumbPage>
  if (parts[0] === "bot") {
    return (
      <>
        <BreadcrumbItem><BreadcrumbLink asChild><Link to="/">Overview</Link></BreadcrumbLink></BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>{NAMES[parts[1]] ?? parts[1]}</BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem><BreadcrumbPage>{cap(parts[2] ?? "live")}</BreadcrumbPage></BreadcrumbItem>
      </>
    )
  }
  return <BreadcrumbPage>{NAMES[parts[0]] ?? cap(parts[0])}</BreadcrumbPage>
}

export default function App() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  const toggleTheme = () => {
    const next = !dark
    document.documentElement.classList.toggle("dark", next)
    localStorage.setItem("theme", next ? "dark" : "light")
    setDark(next)
  }
  return (
    <TooltipProvider>
      <DashboardProvider>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset className="min-w-0">
            <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur">
              <SidebarTrigger />
              <Separator orientation="vertical" className="h-5" />
              <Breadcrumb className="flex-1">
                <BreadcrumbList><Crumbs /></BreadcrumbList>
              </Breadcrumb>
              <Button variant="outline" size="icon-sm" onClick={toggleTheme} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>
                {dark ? <SunIcon /> : <MoonIcon />}
              </Button>
            </header>
            <main className="mx-auto w-full min-w-0 max-w-[96rem] p-6 lg:p-8">
              <Routes>
                <Route path="/" element={<Overview />} />
                <Route path="/logs" element={<Logs />} />
                <Route path="/memory" element={<Memory />} />
                <Route path="/bot/:id" element={<BotLayout />}>
                  <Route index element={<Navigate to="live" replace />} />
                  <Route path="live" element={<BotLive />} />
                  <Route path="inventory" element={<BotInventory />} />
                  <Route path="behavior" element={<BotBehavior />} />
                  <Route path="replay" element={<BotReplay />} />
                  <Route path="structure" element={<BotStructure />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </main>
          </SidebarInset>
        </SidebarProvider>
      </DashboardProvider>
    </TooltipProvider>
  )
}
