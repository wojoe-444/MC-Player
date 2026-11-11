// The Schematics catalog: search, filter and group the list. Pure; erasable TypeScript only (a test loads it).
export type Entry = { id: string; name: string; kind: string; category: string; tags: string[]; mode: string; purpose: string; size: number[]; world: string | null }
export type Query = { q: string; mode: "all" | "functional" | "aesthetic"; categories: ReadonlySet<string> }
export type Group = { category: string; label: string; items: Entry[] }

const LABELS: Record<string, string> = { mobfarm: "Mob farms", farm: "Farms", house: "Houses", base: "Bases", shaft: "Shafts", room: "Rooms", tunnel: "Tunnels", mine: "Mines", build: "Other builds", import: "Imported", tower: "Towers", wall: "Walls", bridge: "Bridges", statue: "Statues", garden: "Gardens", storage: "Storage" }
/** 'mobfarm' -> 'Mob farms'; a category nobody named gets its own words capitalised */
export const categoryLabel = (c: string): string => LABELS[c] ?? (c ? c[0].toUpperCase() + c.slice(1).replace(/[_-]+/g, " ") : "Other builds")

const haystack = (e: Entry) => [e.name, e.kind, e.category, categoryLabel(e.category), e.mode === "aesthetic" ? "exact aesthetic" : "functional", e.purpose, e.world ?? "", ...e.tags].join(" ").toLowerCase()

/** every word typed must appear somewhere in the entry's name, category, tags, purpose or world */
export function filterEntries(list: Entry[], f: Query): Entry[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean)
  return list.filter((e) => (f.mode === "all" || e.mode === f.mode) && (f.categories.size === 0 || f.categories.has(e.category)) && words.every((w) => haystack(e).includes(w)))
}

/** groups by category, by label; the entries of a group by name */
export function groupEntries(list: Entry[]): Group[] {
  const by = new Map<string, Entry[]>()
  for (const e of list) by.set(e.category, [...(by.get(e.category) ?? []), e])
  return [...by.entries()]
    .map(([category, items]) => ({ category, label: categoryLabel(category), items: items.slice().sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** the categories with how many entries each has, for the filter chips */
export const categoryCounts = (list: Entry[]): { category: string; label: string; n: number }[] => groupEntries(list).map((g) => ({ category: g.category, label: g.label, n: g.items.length }))
