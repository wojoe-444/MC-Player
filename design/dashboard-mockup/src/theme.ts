// Palette suite. Each palette is a handful of parameters; applyTheme() expands them into the full shadcn token set
// (the same CSS variables index.css defines) for light or dark mode and writes them on <html>.
// Status colors (success / warning / destructive / info) stay the same hues in every palette so meaning never changes.

export type SidebarStyle = "dark" | "light" | "bold"
export type Palette = {
  id: string
  name: string
  blurb: string
  /** primary: hue and chroma */
  ph: number
  pc: number
  /** neutral tint: hue and chroma used for backgrounds, borders and text */
  nh: number
  nc: number
  sidebar: SidebarStyle
  /** hue for the sidebar when it is dark or bold (defaults to the neutral hue) */
  sh?: number
  /** page background shape: "soft" tinted page with white cards, "flat" near-white page */
  radius?: number
}

export const PALETTES: Palette[] = [
  { id: "indigo-ink", name: "Indigo Ink", blurb: "Navy chrome, indigo primary (the first draft)", ph: 277, pc: 0.23, nh: 265, nc: 0.01, sidebar: "dark" },
  { id: "paper-indigo", name: "Paper Indigo", blurb: "Light drawer, indigo primary, very MUI", ph: 277, pc: 0.23, nh: 265, nc: 0.008, sidebar: "light" },
  { id: "indigo-bold", name: "Indigo Bold", blurb: "The drawer itself is the brand color", ph: 272, pc: 0.21, nh: 270, nc: 0.01, sidebar: "bold" },
  { id: "ocean-teal", name: "Ocean Teal", blurb: "Deep sea chrome with a teal accent", ph: 192, pc: 0.12, nh: 220, nc: 0.01, sidebar: "dark", sh: 225 },
  { id: "emerald-forest", name: "Emerald Forest", blurb: "Green-black chrome, emerald primary", ph: 158, pc: 0.15, nh: 165, nc: 0.01, sidebar: "dark", sh: 170 },
  { id: "grass-block", name: "Grass Block", blurb: "Minecraft: grass green on warm earth", ph: 140, pc: 0.17, nh: 75, nc: 0.014, sidebar: "dark", sh: 60 },
  { id: "redstone", name: "Redstone", blurb: "Charcoal chrome, redstone-red primary", ph: 25, pc: 0.2, nh: 20, nc: 0.006, sidebar: "dark", sh: 20 },
  { id: "sunset-amber", name: "Sunset Amber", blurb: "Warm charcoal, orange-amber primary", ph: 52, pc: 0.17, nh: 60, nc: 0.012, sidebar: "dark", sh: 55 },
  { id: "rose-quartz", name: "Rose Quartz", blurb: "Plum chrome, rose primary", ph: 350, pc: 0.2, nh: 350, nc: 0.01, sidebar: "dark", sh: 335 },
  { id: "violet-dusk", name: "Violet Dusk", blurb: "Deep purple chrome, violet primary", ph: 305, pc: 0.22, nh: 300, nc: 0.012, sidebar: "dark", sh: 295 },
  { id: "slate-mono", name: "Slate Mono", blurb: "Quiet graphite, almost no color", ph: 255, pc: 0.035, nh: 255, nc: 0.008, sidebar: "dark", sh: 255 },
  { id: "graphite-light", name: "Graphite Light", blurb: "Neutral gray with a cool blue accent, light drawer", ph: 245, pc: 0.17, nh: 250, nc: 0.005, sidebar: "light" },
]

const o = (l: number, c: number, h: number, a?: number) => `oklch(${l} ${c} ${h}${a !== undefined ? ` / ${a}` : ""})`

export function tokens(p: Palette, dark: boolean): Record<string, string> {
  const { ph, pc, nh, nc } = p
  const sh = p.sh ?? nh
  const base: Record<string, string> = dark
    ? {
        background: o(0.165, nc * 3, nh),
        foreground: o(0.95, 0.01, nh),
        card: o(0.205, nc * 3.5, nh),
        "card-foreground": o(0.95, 0.01, nh),
        popover: o(0.22, nc * 3.5, nh),
        "popover-foreground": o(0.95, 0.01, nh),
        primary: o(0.7, pc * 0.85, ph),
        "primary-foreground": o(0.16, 0.04, ph),
        secondary: o(0.27, nc * 4, nh),
        "secondary-foreground": o(0.95, 0.01, nh),
        muted: o(0.25, nc * 3.5, nh),
        "muted-foreground": o(0.7, 0.025, nh),
        accent: o(0.3, pc * 0.3, ph),
        "accent-foreground": o(0.95, 0.03, ph),
        border: o(1, 0, 0, 0.09),
        input: o(1, 0, 0, 0.13),
        ring: o(0.66, pc * 0.8, ph),
        destructive: o(0.7, 0.19, 17),
        success: o(0.74, 0.16, 158),
        warning: o(0.82, 0.15, 78),
        "warning-foreground": o(0.9, 0.1, 80),
        info: o(0.74, 0.13, 232),
      }
    : {
        background: o(0.975, nc * 0.7, nh),
        foreground: o(0.23, 0.03 + nc, nh),
        card: o(1, 0, 0),
        "card-foreground": o(0.23, 0.03 + nc, nh),
        popover: o(1, 0, 0),
        "popover-foreground": o(0.23, 0.03 + nc, nh),
        primary: o(0.52, pc, ph),
        "primary-foreground": o(0.985, 0.01, ph),
        secondary: o(0.955, nc * 1.5, nh),
        "secondary-foreground": o(0.3, 0.06, nh),
        muted: o(0.945, nc * 1.2, nh),
        "muted-foreground": o(0.5, 0.03, nh),
        accent: o(0.945, pc * 0.15, ph),
        "accent-foreground": o(0.36, pc * 0.65, ph),
        border: o(0.915, nc * 1.2, nh),
        input: o(0.9, nc * 1.4, nh),
        ring: o(0.6, pc * 0.85, ph),
        destructive: o(0.6, 0.22, 17),
        success: o(0.56, 0.15, 158),
        warning: o(0.78, 0.16, 75),
        "warning-foreground": o(0.45, 0.1, 65),
        info: o(0.58, 0.15, 235),
      }
  // charts: primary, then analogous / complementary hues
  const cl = dark ? 0.74 : 0.6
  const cc = dark ? 0.15 : 0.17
  Object.assign(base, {
    "chart-1": o(dark ? 0.7 : 0.55, Math.max(pc, 0.12), ph),
    "chart-2": o(cl + 0.02, cc - 0.03, ph + 150),
    "chart-3": o(cl + 0.06, cc, ph + 75),
    "chart-4": o(cl + 0.1, cc, ph + 215),
    "chart-5": o(cl + 0.02, cc + 0.03, ph + 290),
  })
  // sidebar
  if (p.sidebar === "light") {
    Object.assign(base, dark
      ? {
          sidebar: o(0.19, nc * 3, nh), "sidebar-foreground": o(0.82, 0.02, nh), "sidebar-primary": base.primary, "sidebar-primary-foreground": base["primary-foreground"],
          "sidebar-accent": o(0.27, pc * 0.25, ph), "sidebar-accent-foreground": o(0.97, 0.01, nh), "sidebar-border": o(1, 0, 0, 0.08), "sidebar-ring": base.ring,
        }
      : {
          sidebar: o(1, 0, 0), "sidebar-foreground": o(0.38, 0.03, nh), "sidebar-primary": base.primary, "sidebar-primary-foreground": base["primary-foreground"],
          "sidebar-accent": o(0.955, pc * 0.12, ph), "sidebar-accent-foreground": o(0.25, 0.04, nh), "sidebar-border": base.border, "sidebar-ring": base.ring,
        })
  } else if (p.sidebar === "bold") {
    Object.assign(base, {
      sidebar: dark ? o(0.3, pc * 0.8, sh) : o(0.42, pc, sh), "sidebar-foreground": o(0.93, 0.03, sh),
      "sidebar-primary": o(0.99, 0, 0), "sidebar-primary-foreground": o(0.3, pc, sh),
      "sidebar-accent": dark ? o(0.38, pc * 0.8, sh) : o(0.5, pc, sh), "sidebar-accent-foreground": o(0.99, 0.01, sh),
      "sidebar-border": o(1, 0, 0, 0.15), "sidebar-ring": o(0.9, 0.05, sh),
    })
  } else {
    Object.assign(base, {
      sidebar: dark ? o(0.14, 0.03, sh) : o(0.2, 0.05, sh), "sidebar-foreground": o(0.86, 0.02, sh),
      "sidebar-primary": o(0.64, Math.max(pc * 0.9, 0.05), ph), "sidebar-primary-foreground": o(0.99, 0, 0),
      "sidebar-accent": o(0.28, 0.06, sh), "sidebar-accent-foreground": o(0.98, 0.01, sh),
      "sidebar-border": dark ? o(1, 0, 0, 0.08) : o(0.3, 0.04, sh), "sidebar-ring": o(0.64, pc * 0.9, ph),
    })
  }
  return base
}

export type ThemeState = { palette: string; dark: boolean }
const KEY = "mock-palette"

export function loadTheme(): ThemeState {
  let palette = "indigo-ink"
  try { palette = localStorage.getItem(KEY) || palette } catch { /* ignore */ }
  if (!PALETTES.some((p) => p.id === palette)) palette = "indigo-ink"
  return { palette, dark: document.documentElement.classList.contains("dark") }
}

export function applyTheme({ palette, dark }: ThemeState) {
  const p = PALETTES.find((x) => x.id === palette) ?? PALETTES[0]
  const root = document.documentElement
  root.classList.toggle("dark", dark)
  root.dataset.palette = p.id
  for (const [k, v] of Object.entries(tokens(p, dark))) root.style.setProperty(`--${k}`, v)
  try { localStorage.setItem(KEY, p.id); localStorage.setItem("mock-theme", dark ? "dark" : "light") } catch { /* ignore */ }
}
