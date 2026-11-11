import { NavLink } from "react-router-dom"
import {
  BotIcon, BrainCircuitIcon, ClapperboardIcon, DatabaseIcon, EyeIcon, LayoutDashboardIcon, NetworkIcon, PackageIcon,
  ScrollTextIcon, SettingsIcon, RepeatIcon, SparklesIcon, TrendingUpIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarRail,
} from "@/components/ui/sidebar"
import { useData } from "@/DashboardContext"
import { updatePending, useApp } from "@/botapp"

type Entry = { to: string; label: string; icon: typeof EyeIcon; dot?: boolean; badge?: string }

export const GROUPS: { label: string; items: Omit<Entry, "dot" | "badge">[] }[] = [
  { label: "Monitor", items: [
    { to: "/", label: "Dashboard", icon: LayoutDashboardIcon },
    { to: "/progress", label: "Progress", icon: TrendingUpIcon },
    { to: "/logs", label: "Logs", icon: ScrollTextIcon },
  ] },
  { label: "Selected bot", items: [
    { to: "/live", label: "Live view", icon: EyeIcon },
    { to: "/inventory", label: "Inventory", icon: PackageIcon },
    { to: "/replay", label: "Replay", icon: ClapperboardIcon },
    { to: "/behavior", label: "Behavior", icon: NetworkIcon },
    { to: "/structure", label: "Structure", icon: BrainCircuitIcon },
    { to: "/memory", label: "Memory and data", icon: DatabaseIcon },
  ] },
  { label: "Automation", items: [
    { to: "/reviews", label: "Claude reviews", icon: SparklesIcon },
    { to: "/loop", label: "Memory loop", icon: RepeatIcon },
  ] },
  { label: "System", items: [{ to: "/settings", label: "Settings", icon: SettingsIcon }] },
]

export function AppSidebar() {
  const { connected } = useData()
  const { update, reviewer, info } = useApp()
  const openFindings = (reviewer?.bots ?? []).reduce((n, b) => n + (b.findings?.open.length ?? 0), 0)
  const updateDot = updatePending(update)
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="h-16 justify-center border-b border-sidebar-border px-4">
        <div className="flex items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground shadow-md shadow-sidebar-primary/30"><BotIcon className="size-4.5" /></div>
          <div className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-semibold text-sidebar-accent-foreground">Bot Dashboard</span>
            <span className="truncate text-xs text-sidebar-foreground/60">OzoGo444 · Smeo444</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent className="gap-0 px-2 py-4">
        {GROUPS.map((g) => (
          <SidebarGroup key={g.label} className="py-2">
            <SidebarGroupLabel className="px-3 text-[11px] font-semibold tracking-wider text-sidebar-foreground/50 uppercase">{g.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {g.items.map((i) => {
                  const badge = i.to === "/reviews" && openFindings ? String(openFindings) : undefined
                  const dot = i.to === "/settings" && updateDot
                  return (
                    <SidebarMenuItem key={i.to}>
                      <NavLink to={i.to} end={i.to === "/"} title={dot ? "An update is available" : undefined}>
                        {({ isActive }) => (
                          <SidebarMenuButton asChild isActive={isActive} tooltip={i.label} className="h-10 gap-3 px-3 data-[active=true]:bg-sidebar-primary data-[active=true]:text-sidebar-primary-foreground data-[active=true]:shadow-md data-[active=true]:shadow-sidebar-primary/25">
                            <span><i.icon /><span>{i.label}</span></span>
                          </SidebarMenuButton>
                        )}
                      </NavLink>
                      {badge && <SidebarMenuBadge className="top-2.5 right-3 bg-warning/90 text-[11px] text-black">{badge}</SidebarMenuBadge>}
                      {dot && <SidebarMenuBadge className="top-2.5 right-3"><span className="size-2 rounded-full bg-warning" /></SidebarMenuBadge>}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-4 group-data-[collapsible=icon]:hidden">
        <div className="flex items-center justify-between text-xs text-sidebar-foreground/70">
          <span>{info ? `Version ${info.version}` : "Bot Dashboard"}</span>
          <Badge variant={connected ? "success" : "destructive"}>{connected ? "live" : "reconnecting"}</Badge>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
