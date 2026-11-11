import { useState } from "react"
import { Route, Routes, useLocation } from "react-router-dom"
import { BellIcon, MoonIcon, SunIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar } from "@/components/AppSidebar"
import { Dashboard } from "@/pages/Dashboard"
import { Progress } from "@/pages/Progress"
import { Inventory } from "@/pages/Inventory"
import { Reviews } from "@/pages/Reviews"
import { Settings } from "@/pages/Settings"

const TITLES: Record<string, [string, string]> = {
  "/": ["Monitor", "Dashboard"],
  "/progress": ["Monitor", "Progress"],
  "/inventory": ["Bots", "Inventory"],
  "/reviews": ["Automation", "Claude reviews"],
  "/settings": ["System", "Settings"],
}

export default function App() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  const { pathname } = useLocation()
  const [group, page] = TITLES[pathname] ?? TITLES["/"]
  const toggle = () => {
    const next = !dark
    document.documentElement.classList.toggle("dark", next)
    localStorage.setItem("mock-theme", next ? "dark" : "light")
    setDark(next)
  }
  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-4 border-b bg-background/85 px-6 backdrop-blur">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-6" />
            <Breadcrumb className="flex-1">
              <BreadcrumbList>
                <BreadcrumbItem className="text-muted-foreground">{group}</BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem><BreadcrumbPage className="font-medium">{page}</BreadcrumbPage></BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <div className="hidden items-center gap-2 md:flex">
              <Badge variant="success"><span className="size-1.5 rounded-full bg-success" />OzoGo444 online</Badge>
              <Badge variant="success"><span className="size-1.5 rounded-full bg-success" />Smeo444 online</Badge>
            </div>
            <Button variant="ghost" size="icon" aria-label="Notifications" className="relative">
              <BellIcon /><span className="absolute top-2 right-2 size-2 rounded-full bg-destructive ring-2 ring-background" />
            </Button>
            <Button variant="outline" size="icon" onClick={toggle} aria-label="Toggle theme">{dark ? <SunIcon /> : <MoonIcon />}</Button>
          </header>
          <main className="mx-auto flex w-full min-w-0 max-w-[88rem] flex-col gap-8 p-6 lg:p-8">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/progress" element={<Progress />} />
              <Route path="/inventory" element={<Inventory />} />
              <Route path="/reviews" element={<Reviews />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Dashboard />} />
            </Routes>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
