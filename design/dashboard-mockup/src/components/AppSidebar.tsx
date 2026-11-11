import { NavLink } from "react-router-dom"
import { BotIcon, ClipboardCheckIcon, LayoutDashboardIcon, PackageIcon, RouteIcon, SettingsIcon, SparklesIcon } from "lucide-react"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarRail,
} from "@/components/ui/sidebar"

const GROUPS = [
  { label: "Monitor", items: [
    { to: "/", label: "Dashboard", icon: LayoutDashboardIcon },
    { to: "/progress", label: "Progress", icon: RouteIcon },
  ] },
  { label: "Bots", items: [
    { to: "/inventory", label: "Inventory", icon: PackageIcon },
  ] },
  { label: "Automation", items: [
    { to: "/reviews", label: "Claude reviews", icon: SparklesIcon, badge: "2" },
  ] },
  { label: "System", items: [
    { to: "/settings", label: "Settings", icon: SettingsIcon },
  ] },
]

export function AppSidebar() {
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
                {g.items.map((i) => (
                  <SidebarMenuItem key={i.to}>
                    <NavLink to={i.to} end={i.to === "/"}>
                      {({ isActive }) => (
                        <SidebarMenuButton asChild isActive={isActive} tooltip={i.label} className="h-10 gap-3 px-3 data-[active=true]:bg-sidebar-primary data-[active=true]:text-sidebar-primary-foreground data-[active=true]:shadow-md data-[active=true]:shadow-sidebar-primary/25">
                          <span><i.icon /><span>{i.label}</span></span>
                        </SidebarMenuButton>
                      )}
                    </NavLink>
                    {"badge" in i && i.badge && <SidebarMenuBadge className="bg-warning/90 text-[11px] text-black">{i.badge}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-4 group-data-[collapsible=icon]:hidden">
        <div className="flex items-center gap-3 text-xs text-sidebar-foreground/70">
          <ClipboardCheckIcon className="size-4 text-success" />
          <div className="flex flex-col leading-tight"><span className="font-medium text-sidebar-accent-foreground">v0.9.4 · up to date</span><span>Design mockup, sample data</span></div>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
