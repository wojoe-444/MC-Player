// Sample data only. Shapes mirror /api/progress, /api/acquired and the app's review state.
export type BotId = "ozo" | "smeo"
export const BOTS: Record<BotId, { name: string; role: string; online: boolean }> = {
  ozo: { name: "OzoGo444", role: "Miner", online: true },
  smeo: { name: "Smeo444", role: "Builder", online: true },
}

export type Vital = { hp: number; food: number; clock: string; pos: [number, number, number]; step: string; goal: string; held: string; dim: string }
export const VITALS: Record<BotId, Vital> = {
  ozo: { hp: 18, food: 15, clock: "Day 14 · 09:40", pos: [212, 11, -148], step: "mine-iron", goal: "Mine 24 iron ore at Y 11, smelt in the furnace bank, then craft the iron pickaxe.", held: "Stone Pickaxe", dim: "Overworld" },
  smeo: { hp: 20, food: 20, clock: "Day 14 · 09:40", pos: [196, 64, -131], step: "mobfarm-build", goal: "Finish the mob farm platform walls and light the surrounding dark spawn spots.", held: "Cobblestone", dim: "Overworld" },
}

export const KPIS = [
  { label: "Iron ingots", value: "142", delta: "+18 today", good: true, spark: [4, 6, 5, 9, 12, 11, 15, 18] },
  { label: "Diamonds", value: "7", delta: "+2 today", good: true, spark: [0, 0, 1, 1, 2, 3, 5, 7] },
  { label: "Deaths (7d)", value: "3", delta: "-2 vs last week", good: true, spark: [2, 1, 0, 1, 0, 0, 1, 0] },
  { label: "Stalled minutes", value: "11", delta: "+4 vs yesterday", good: false, spark: [3, 2, 4, 1, 2, 5, 7, 11] },
]

export type Ev = { t: string; bot: BotId; kind: "goal" | "mine" | "build" | "alert" | "death" | "craft" | "fight"; text: string }
export const EVENTS: Ev[] = [
  { t: "09:41", bot: "ozo", kind: "mine", text: "Picked up 6 raw iron at (214, 11, -150)" },
  { t: "09:38", bot: "smeo", kind: "build", text: "Placed wall segment 4 of 8 on the mob farm platform" },
  { t: "09:34", bot: "ozo", kind: "alert", text: "Stalled 40 s: ladder shaft blocked by gravel, dug around it" },
  { t: "09:29", bot: "ozo", kind: "craft", text: "Smelted 12 iron ingots in furnace bank B" },
  { t: "09:22", bot: "smeo", kind: "fight", text: "Killed 2 zombies near the shaft entrance, no damage taken" },
  { t: "09:15", bot: "smeo", kind: "goal", text: "New goal: finish mob farm walls, then light-up pass" },
  { t: "09:03", bot: "ozo", kind: "death", text: "Died to lava at (207, 9, -141). Respawned, gear chest restocked" },
  { t: "08:51", bot: "ozo", kind: "goal", text: "New goal: mine 24 iron ore at Y 11" },
]

export type Item = { n: string; c: number; color: string }
export const HOTBAR: (Item | null)[] = [
  { n: "Stone Pickaxe", c: 1, color: "#8b8f98" }, { n: "Stone Sword", c: 1, color: "#9aa0aa" }, { n: "Torch", c: 48, color: "#f59e0b" },
  { n: "Cooked Beef", c: 22, color: "#b45309" }, { n: "Cobblestone", c: 64, color: "#6b7280" }, { n: "Oak Planks", c: 32, color: "#c08a4b" },
  { n: "Water Bucket", c: 1, color: "#38bdf8" }, null, { n: "Shield", c: 1, color: "#a16207" },
]
export const GRID: (Item | null)[] = [
  { n: "Raw Iron", c: 37, color: "#d6a98a" }, { n: "Iron Ingot", c: 42, color: "#cbd5e1" }, { n: "Coal", c: 58, color: "#334155" },
  { n: "Diamond", c: 4, color: "#22d3ee" }, { n: "Redstone", c: 31, color: "#ef4444" }, { n: "Lapis Lazuli", c: 14, color: "#3b82f6" },
  { n: "Bread", c: 9, color: "#d97706" }, { n: "Oak Log", c: 16, color: "#92400e" }, { n: "Gravel", c: 24, color: "#9ca3af" },
  { n: "Cobbled Deepslate", c: 64, color: "#475569" }, { n: "Cobbled Deepslate", c: 41, color: "#475569" }, { n: "Furnace", c: 3, color: "#78716c" },
  { n: "Chest", c: 2, color: "#b45309" }, { n: "Crafting Table", c: 1, color: "#a16207" }, { n: "Bed", c: 1, color: "#dc2626" },
  null, null, { n: "Lava Bucket", c: 1, color: "#f97316" }, null, null, null, null, null, null, null, null, null,
]
export const ARMOR: (Item | null)[] = [
  { n: "Iron Helmet", c: 1, color: "#cbd5e1" }, { n: "Iron Chestplate", c: 1, color: "#cbd5e1" }, { n: "Iron Leggings", c: 1, color: "#cbd5e1" }, null,
]

export type Acq = { item: string; ozo: number; smeo: number; color: string }
export const ACQUIRED: Record<string, Acq[]> = {
  "1h": [
    { item: "Raw Iron", ozo: 21, smeo: 0, color: "#d6a98a" }, { item: "Cobbled Deepslate", ozo: 96, smeo: 0, color: "#475569" },
    { item: "Coal", ozo: 11, smeo: 0, color: "#334155" }, { item: "Rotten Flesh", ozo: 0, smeo: 7, color: "#84cc16" }, { item: "Bone", ozo: 0, smeo: 4, color: "#e5e7eb" },
  ],
  "8h": [
    { item: "Cobbled Deepslate", ozo: 512, smeo: 64, color: "#475569" }, { item: "Raw Iron", ozo: 88, smeo: 3, color: "#d6a98a" },
    { item: "Coal", ozo: 64, smeo: 12, color: "#334155" }, { item: "Redstone", ozo: 31, smeo: 0, color: "#ef4444" },
    { item: "Rotten Flesh", ozo: 14, smeo: 38, color: "#84cc16" }, { item: "Bone", ozo: 6, smeo: 19, color: "#e5e7eb" },
    { item: "Diamond", ozo: 4, smeo: 0, color: "#22d3ee" }, { item: "Gunpowder", ozo: 0, smeo: 9, color: "#6b7280" },
  ],
  "24h": [
    { item: "Cobbled Deepslate", ozo: 1480, smeo: 192, color: "#475569" }, { item: "Raw Iron", ozo: 211, smeo: 8, color: "#d6a98a" },
    { item: "Coal", ozo: 160, smeo: 33, color: "#334155" }, { item: "Redstone", ozo: 74, smeo: 0, color: "#ef4444" },
    { item: "Rotten Flesh", ozo: 41, smeo: 96, color: "#84cc16" }, { item: "Bone", ozo: 17, smeo: 52, color: "#e5e7eb" },
    { item: "Diamond", ozo: 7, smeo: 0, color: "#22d3ee" }, { item: "Lapis Lazuli", ozo: 22, smeo: 0, color: "#3b82f6" }, { item: "Gunpowder", ozo: 0, smeo: 21, color: "#6b7280" },
  ],
  "7d": [
    { item: "Cobbled Deepslate", ozo: 6120, smeo: 880, color: "#475569" }, { item: "Raw Iron", ozo: 904, smeo: 31, color: "#d6a98a" },
    { item: "Coal", ozo: 640, smeo: 118, color: "#334155" }, { item: "Rotten Flesh", ozo: 120, smeo: 402, color: "#84cc16" },
    { item: "Redstone", ozo: 300, smeo: 0, color: "#ef4444" }, { item: "Bone", ozo: 64, smeo: 210, color: "#e5e7eb" },
    { item: "Diamond", ozo: 19, smeo: 0, color: "#22d3ee" },
  ],
  all: [
    { item: "Cobbled Deepslate", ozo: 9812, smeo: 1402, color: "#475569" }, { item: "Raw Iron", ozo: 1320, smeo: 52, color: "#d6a98a" },
    { item: "Coal", ozo: 990, smeo: 204, color: "#334155" }, { item: "Rotten Flesh", ozo: 220, smeo: 701, color: "#84cc16" },
    { item: "Diamond", ozo: 27, smeo: 0, color: "#22d3ee" },
  ],
}

export type Phase = { id: string; name: string; blurb: string; done: number; open: number; unmeasured: number; items: { id: string; title: string; status: "done" | "open" | "unmeasured"; needs?: string }[] }
export const ROADMAP: Phase[] = [
  { id: "1", name: "Subsistence", blurb: "Food, stone tools, bed, shelter, torches", done: 6, open: 0, unmeasured: 0, items: [
    { id: "1.1", title: "Steady food supply", status: "done" }, { id: "1.2", title: "Stone tool set", status: "done" }, { id: "1.3", title: "Bed placed and used", status: "done" },
    { id: "1.4", title: "Shelter with a door", status: "done" }, { id: "1.5", title: "Torches kept stocked", status: "done" }, { id: "1.6", title: "Safe respawn point", status: "done" } ] },
  { id: "2", name: "Industry and structure", blurb: "Shaft, storage room, farms, lit area, mob farm", done: 4, open: 2, unmeasured: 1, items: [
    { id: "2.1", title: "Main shaft to Y 11", status: "done" }, { id: "2.2", title: "Storage room with chests", status: "done" }, { id: "2.3", title: "Wheat farm", status: "done" },
    { id: "2.4", title: "Lit base area", status: "done" }, { id: "2.5", title: "Mob farm walls", status: "open" }, { id: "2.6", title: "Mob farm passes inspection", status: "open" },
    { id: "2.7", title: "Auto-sorter", status: "unmeasured", needs: "a sorter record in the registry" } ] },
  { id: "3", name: "Structured mining base", blurb: "A mining room at one Y level, diamond pickaxe, villager hall", done: 1, open: 3, unmeasured: 2, items: [
    { id: "3.1", title: "Mining room at Y 11", status: "done" }, { id: "3.2", title: "Iron pickaxe", status: "open" }, { id: "3.3", title: "Diamond pickaxe", status: "open" },
    { id: "3.4", title: "Villager hall", status: "open" }, { id: "3.5", title: "Trading post", status: "unmeasured", needs: "a trade log" }, { id: "3.6", title: "Mending", status: "unmeasured", needs: "an enchant record" } ] },
  { id: "3.5", name: "Nether portal", blurb: "Portal with a safe shell on the far side", done: 0, open: 1, unmeasured: 2, items: [
    { id: "3.5.1", title: "Obsidian collected", status: "open" }, { id: "3.5.2", title: "Portal lit", status: "unmeasured", needs: "a portal record" }, { id: "3.5.3", title: "Far-side shell", status: "unmeasured", needs: "a portal record" } ] },
  { id: "4", name: "Enchanting and potions", blurb: "Bookshelves, Mending, brewing, then diamond gear", done: 0, open: 0, unmeasured: 4, items: [] },
  { id: "5", name: "Endgame", blurb: "Stronghold, dragon kit, the Ender Dragon", done: 0, open: 0, unmeasured: 5, items: [] },
]

export type Build = { label: string; kind: string; pos: [number, number, number]; by: string; when: string; status: "passes" | "faults" | "unchecked" | "working" | "built"; detail: string; faults?: string[] }
export const BUILDS: Build[] = [
  { label: "Mob farm", kind: "mob-farm", pos: [196, 64, -131], by: "Smeo444", when: "12 min ago", status: "faults", detail: "8 deep · 2 chests", faults: ["Spawning platform wall missing at (198, 66, -129)", "Hopper under the kill chamber not connected"] },
  { label: "Main shaft", kind: "shaft", pos: [210, 64, -145], by: "OzoGo444", when: "3 h ago", status: "built", detail: "53 deep" },
  { label: "Storage room", kind: "room", pos: [208, 11, -146], by: "OzoGo444", when: "5 h ago", status: "built", detail: "4 chests · reset-gear chest" },
  { label: "Wheat farm", kind: "farm", pos: [184, 63, -120], by: "Smeo444", when: "2 d ago", status: "unchecked", detail: "9x9 plot" },
  { label: "Iron tunnel A", kind: "tunnel", pos: [214, 11, -152], by: "OzoGo444", when: "now", status: "working", detail: "38 blocks long" },
]

export type GameDay = { day: number; iron: number; ingots: number; tunnels: number; deaths: number; armor: string; commit: string; done: boolean }
export const GAME_DAYS: GameDay[] = [
  { day: 14, iron: 21, ingots: 12, tunnels: 1, deaths: 1, armor: "iron", commit: "a56fc39", done: false },
  { day: 13, iron: 34, ingots: 30, tunnels: 3, deaths: 0, armor: "iron", commit: "2afd9f8", done: true },
  { day: 12, iron: 27, ingots: 26, tunnels: 2, deaths: 1, armor: "leather", commit: "992b0b5", done: true },
  { day: 11, iron: 12, ingots: 9, tunnels: 1, deaths: 2, armor: "none", commit: "97a8f82", done: true },
  { day: 10, iron: 8, ingots: 8, tunnels: 1, deaths: 0, armor: "none", commit: "1c1e996", done: true },
]

export const REVIEW_TRIGGERS = [
  { id: "review", title: "Spectator review", enabled: true, every: 10, last: "2 min ago", next: "in 8 min", ok: true, summary: "2 open findings across both bots, 1 resolved since last run." },
  { id: "drive", title: "Drive the bots", enabled: false, every: 5, last: "never", next: "off", ok: true, summary: "" },
  { id: "journal", title: "Daily journal rollup", enabled: true, every: 60, last: "34 min ago", next: "in 26 min", ok: true, summary: "Journal written for 2026-11-10: 2 bots, 1 death, 11 stalled minutes." },
]
export const FINDINGS = [
  { bot: "OzoGo444", sev: "high" as const, title: "Repeated lava deaths near Y 9", evidence: "3 deaths in 6 days within 4 blocks of (207, 9, -141); the lava bucket reflex fired late twice.", suggestion: "Place a block over lava before mining past it; widen the scan radius to 5.", kind: "safety", seen: 3, since: "Nov 4" },
  { bot: "OzoGo444", sev: "med" as const, title: "Gravel stalls the ladder shaft", evidence: "Stalled 40 s at (210, 22, -145) when gravel fell into the shaft.", suggestion: "Dig around falling blocks instead of waiting for the unstuck timer.", kind: "stall", seen: 5, since: "Nov 8" },
  { bot: "Smeo444", sev: "low" as const, title: "Torches placed on the spawning platform", evidence: "2 torches found on the mob farm platform during the inspection.", suggestion: "Skip the platform's cells in the light-up pass.", kind: "build", seen: 1, since: "Nov 10" },
]
export const RECENT_REVIEWS = [
  { at: "Today 09:38", text: "OzoGo444 mined steadily for 9 minutes and smelted a full stack of iron. One stall at the gravel shaft cleared on its own. Smeo444 is on the mob farm walls and made progress, no problems seen." },
  { at: "Today 09:28", text: "Both bots active. Ozo lost 40 seconds to a gravel stall. Smeo killed two zombies without damage and kept building." },
  { at: "Today 09:18", text: "Ozo died to lava at Y 9 after respawning into the same tunnel. Gear chest restocked. Recommend a pause before returning to that corridor." },
]
