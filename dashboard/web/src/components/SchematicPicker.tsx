import { useMemo, useRef, useState } from "react"
import { ChevronDownIcon, SearchIcon, XIcon } from "lucide-react"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { categoryCounts, filterEntries, groupEntries } from "@/lib/schematic/catalog"
import type { SchematicSummary } from "@/lib/schematic/types"
import { cn } from "@/lib/utils"

type Mode = "all" | "functional" | "aesthetic"
/** The picker's own state (search, filters, shut groups, scroll) lives with the page, not the picker: the picker is drawn inside the panel of the schematic being viewed, which is rebuilt on every pick. */
export function useCatalogState() {
  const [q, setQ] = useState("")
  const [mode, setMode] = useState<Mode>("all")
  const [cats, setCats] = useState<ReadonlySet<string>>(new Set())
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set())
  const scroll = useRef(0)
  return { q, setQ, mode, setMode, cats, setCats, shut, setShut, scroll }
}
export type CatalogState = ReturnType<typeof useCatalogState>

type Props = { list: SchematicSummary[]; currentId: string | null; onPick: (id: string) => void; state: CatalogState }

/** The catalog: a searchable list grouped by category, with a category filter and a functional / exact filter. */
export function SchematicPicker({ list, currentId, onPick, state }: Props) {
  const { q, setQ, mode, setMode, cats, setCats, shut, setShut, scroll } = state
  const counts = useMemo(() => categoryCounts(list), [list])
  const shown = useMemo(() => filterEntries(list, { q, mode, categories: cats }), [list, q, mode, cats])
  const groups = useMemo(() => groupEntries(shown), [shown])
  const filtering = q.trim() !== "" || mode !== "all" || cats.size > 0
  const toggle = (set: ReadonlySet<string>, k: string) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${list.length} schematics`} aria-label="Search schematics" className="pr-8 pl-8"
          onKeyDown={(e) => { if (e.key === "Enter" && shown[0]) onPick(shown[0].id); if (e.key === "Escape") setQ("") }} />
        {q && <button onClick={() => setQ("")} aria-label="Clear the search" className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><XIcon className="size-3.5" /></button>}
      </div>
      <ToggleGroup type="single" value={mode} onValueChange={(v) => setMode((v || "all") as Mode)} variant="outline" size="sm" spacing={0} className="grid w-full grid-cols-3" aria-label="Kind of build">
        <ToggleGroupItem value="all">All</ToggleGroupItem>
        <ToggleGroupItem value="functional" title="Walls accept any solid block">Functional</ToggleGroupItem>
        <ToggleGroupItem value="aesthetic" title="Every block exactly as drawn">Exact</ToggleGroupItem>
      </ToggleGroup>
      {counts.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categories">
          {counts.map((c) => (
            <button key={c.category} onClick={() => setCats(toggle(cats, c.category))} aria-pressed={cats.has(c.category)}
              className={cn("rounded-full border px-2 py-0.5 text-xs transition-colors hover:bg-accent", cats.has(c.category) && "border-primary bg-primary text-primary-foreground hover:bg-primary/90")}>
              {c.label} <span className="opacity-70">{c.n}</span>
            </button>
          ))}
        </div>
      )}
      <div ref={(el) => { if (el && el.scrollTop !== scroll.current) el.scrollTop = scroll.current }} onScroll={(e) => { scroll.current = e.currentTarget.scrollTop }} className="max-h-64 overflow-y-auto rounded-lg border" role="listbox" aria-label="Schematics">
        {groups.length === 0 && (
          <div className="flex flex-col items-start gap-1 p-3 text-sm text-muted-foreground">
            No schematic matches.
            <button className="underline underline-offset-2 hover:text-foreground" onClick={() => { setQ(""); setMode("all"); setCats(new Set()) }}>Clear the filters</button>
          </div>
        )}
        {groups.map((g) => {
          const open = filtering || !shut.has(g.category)
          return (
            <div key={g.category} className="border-b last:border-b-0">
              <button onClick={() => setShut(toggle(shut, g.category))} aria-expanded={open} className="flex w-full items-center gap-1.5 bg-muted/50 px-2.5 py-1 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase hover:bg-muted">
                <ChevronDownIcon className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
                <span className="flex-1">{g.label}</span><span className="tabular-nums">{g.items.length}</span>
              </button>
              {open && g.items.map((e) => (
                <button key={e.id} role="option" title={e.name} aria-selected={e.id === currentId} onClick={() => onPick(e.id)}
                  className={cn("flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-accent", e.id === currentId && "bg-accent font-medium")}>
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{e.size[0]}×{e.size[2]}×{e.size[1]}</span>
                  {e.mode === "aesthetic" && <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">exact</span>}
                </button>
              ))}
            </div>
          )
        })}
      </div>
      {filtering && <div className="text-xs text-muted-foreground">{shown.length} of {list.length} shown</div>}
    </div>
  )
}
