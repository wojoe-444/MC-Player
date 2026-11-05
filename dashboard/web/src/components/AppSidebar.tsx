import { NavLink, useLocation } from "react-router-dom"
import {
  BoxesIcon, ClapperboardIcon, BrainCircuitIcon, DatabaseIcon, EyeIcon, LayoutDashboardIcon, NetworkIcon, PackageIcon, ScrollTextIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail,
} from "@/components/ui/sidebar"
import { useData } from "@/DashboardContext"
import { BOT_IDS } from "@/types"

const BOT_PAGES = [
  { slug: "live", label: "Live", icon: EyeIcon },
  { slug: "inventory", label: "Inventory", icon: PackageIcon },
  { slug: "replay", label: "Replay", icon: ClapperboardIcon },
  { slug: "behavior", label: "Behavior", icon: NetworkIcon },
  { slug: "structure", label: "Structure", icon: BrainCircuitIcon },
]

function Item({ to, label, icon: Icon }: { to: string; label: string; icon: typeof EyeIcon }) {
  const { pathname } = useLocation()
  const active = to === "/" ? pathname === "/" : pathname.startsWith(to)
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={label}>
        <NavLink to={to}><Icon /><span>{label}</span></NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export function AppSidebar() {
  const { connected, snap } = useData()
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <BoxesIcon />
          <span className="font-semibold tracking-tight group-data-[collapsible=icon]:hidden">Bot Dashboard</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Dashboard</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <Item to="/" label="Overview" icon={LayoutDashboardIcon} />
              <Item to="/logs" label="Logs" icon={ScrollTextIcon} />
              <Item to="/memory" label="Memory and data" icon={DatabaseIcon} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {BOT_IDS.map((id) => (
          <SidebarGroup key={id}>
            <SidebarGroupLabel>{snap ? snap[id].name : id}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {BOT_PAGES.map((p) => <Item key={p.slug} to={`/bot/${id}/${p.slug}`} label={`${p.label}`} icon={p.icon} />)}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <div className="px-2 pb-1 group-data-[collapsible=icon]:hidden">
          <Badge variant={connected ? "secondary" : "destructive"}>{connected ? "live" : "reconnecting"}</Badge>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
