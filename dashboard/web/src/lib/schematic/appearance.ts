// How a block looks in the Schematics viewer. Original, procedurally painted 16x16 pixel tiles (no game assets): a block name picks a style (a colour and a pattern per face),
// `paintTile` paints it deterministically, `makeAtlas` packs the tiles a schematic needs into one texture. Pure TypeScript with erasable types only (node can load it in a test).
export type RGB = [number, number, number]
/** "kind|r,g,b|r,g,b" : the pattern and its one or two colours */
export type Spec = string
export type Style = { top: Spec; side: Spec; bottom: Spec; translucent?: boolean }

export const TILE = 16
const spec = (kind: string, c: RGB, c2?: RGB): Spec => `${kind}|${c.join(",")}${c2 ? "|" + c2.join(",") : ""}`
const dark = (c: RGB, f: number): RGB => [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f)]
const mix = (a: RGB, b: RGB, t: number): RGB => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]
const uniform = (s: Spec, translucent?: boolean): Style => ({ top: s, side: s, bottom: s, translucent })

const WOOD: Record<string, RGB> = {
  oak: [162, 130, 78], spruce: [114, 84, 48], birch: [192, 175, 121], jungle: [160, 115, 80], acacia: [168, 90, 50], dark_oak: [66, 43, 20], mangrove: [117, 54, 48],
  cherry: [226, 178, 172], pale_oak: [227, 215, 208], bamboo: [193, 173, 80], crimson: [101, 48, 70], warped: [43, 104, 99],
}
const BARK: Record<string, RGB> = { oak: [109, 85, 50], spruce: [58, 37, 16], birch: [216, 215, 210], jungle: [85, 67, 25], acacia: [103, 96, 86], dark_oak: [60, 46, 26], mangrove: [84, 56, 44], cherry: [54, 33, 44], pale_oak: [101, 88, 80], bamboo: [120, 130, 50], crimson: [92, 25, 29], warped: [53, 43, 64] }
const DYE: Record<string, RGB> = {
  white: [233, 236, 236], orange: [240, 118, 19], magenta: [189, 68, 179], light_blue: [58, 175, 217], yellow: [248, 197, 39], lime: [112, 185, 25], pink: [237, 141, 172], gray: [62, 68, 71],
  light_gray: [142, 142, 134], cyan: [21, 137, 145], purple: [121, 42, 172], blue: [53, 57, 157], brown: [114, 71, 40], green: [84, 109, 27], red: [160, 39, 34], black: [20, 21, 25],
}
const STONE: RGB = [125, 125, 125]
const DEEP: RGB = [78, 78, 84]
const ORE: Record<string, RGB> = { coal: [30, 30, 30], iron: [216, 175, 147], copper: [224, 120, 80], gold: [252, 238, 75], redstone: [220, 20, 20], lapis: [38, 78, 190], diamond: [92, 219, 213], emerald: [23, 190, 80] }
const METAL: Record<string, RGB> = { iron: [220, 220, 220], gold: [246, 208, 61], diamond: [98, 219, 213], emerald: [42, 203, 87], lapis: [31, 67, 140], redstone: [171, 27, 9], coal: [16, 16, 16], copper: [192, 107, 79], netherite: [66, 61, 63], amethyst: [133, 97, 191] }

const SHAPE_SUFFIX = /_(slab|stairs|wall|fence_gate|fence|button|pressure_plate|wall_sign|hanging_sign|sign|pane)$/
const ALIAS: Record<string, string> = { stone_brick: "stone_bricks", mossy_stone_brick: "mossy_stone_bricks", brick: "bricks", nether_brick: "nether_bricks", red_nether_brick: "red_nether_bricks", mud_brick: "mud_bricks", quartz: "quartz_block", smooth_quartz: "quartz_block", prismarine_brick: "prismarine_bricks", end_stone_brick: "end_stone_bricks", deepslate_brick: "deepslate_bricks", deepslate_tile: "deepslate_tiles", cracked_deepslate_bricks: "deepslate_bricks", cracked_deepslate_tiles: "deepslate_tiles", tuff_brick: "tuff_bricks", chiseled_tuff_bricks: "tuff_bricks", cracked_polished_blackstone_bricks: "polished_blackstone_bricks", chiseled_sandstone: "sandstone", waxed_copper_block: "copper_block", polished_blackstone_brick: "polished_blackstone_bricks", cut_sandstone: "sandstone", smooth_sandstone: "sandstone", cut_red_sandstone: "red_sandstone", smooth_red_sandstone: "red_sandstone", petrified_oak: "oak" }

/** plants and other things drawn as crossed flat quads */
export const isPlant = (name: string): boolean => /(grass|fern|bush|sapling|flower|tulip|dandelion|poppy|vine|lichen|cobweb|roots|sprouts|mushroom|azalea|berries|kelp|seagrass|allium|orchid|bluet|daisy|cornflower|lily|moss_carpet|wheat|carrots|potatoes|beetroots|sugar_cane)/.test(name) && !/(block|leaves)$/.test(name)

/** the style of a block (by its name; properties do not change how it is painted) */
export function styleOf(name: string): Style {
  const n = String(name || "").replace(/^minecraft:/, "")
  const woods = Object.keys(WOOD).join("|")
  const dyes = Object.keys(DYE).join("|")
  let m: RegExpMatchArray | null
  if (n === "water") return uniform(spec("water", [49, 99, 210]), true)
  if (n === "lava") return uniform(spec("lava", [226, 96, 20]))
  if ((m = n.match(new RegExp(`^(stripped_)?(${woods})_(log|wood|stem|hyphae)$`)))) {
    const planks = WOOD[m[2]], bark = m[1] ? planks : BARK[m[2]]
    return { top: spec("logtop", planks, dark(bark, 0.85)), side: spec("logside", bark), bottom: spec("logtop", planks, dark(bark, 0.85)) }
  }
  if (n.endsWith("_trapdoor")) { const w = WOOD[n.replace(/_trapdoor$/, "")] || [150, 150, 150]; return uniform(spec("trapdoor", w)) }
  if (n.endsWith("_door")) { const w = WOOD[n.replace(/_door$/, "")]; return uniform(spec("trapdoor", w || [200, 200, 200])) }
  if (n === "torch" || n === "wall_torch") return uniform(spec("torch", [120, 90, 50], [255, 190, 60]))
  if (n === "soul_torch" || n === "soul_wall_torch") return uniform(spec("torch", [120, 90, 50], [90, 220, 230]))
  if (n === "ladder") return uniform(spec("ladder", [143, 109, 61]))
  if (n === "hopper") return { top: spec("hopper", [58, 58, 62]), side: spec("hopper", [74, 74, 78]), bottom: spec("hopper", [58, 58, 62]) }
  if (n === "chest" || n === "trapped_chest" || n === "ender_chest") return uniform(spec("chest", n === "ender_chest" ? [30, 50, 55] : [152, 108, 44]))
  if (n === "barrel") return uniform(spec("planks", dark(WOOD.oak, 0.85)))
  if (n === "crafting_table") return { top: spec("planks", dark(WOOD.oak, 0.9)), side: spec("planks", WOOD.oak, [90, 60, 30]), bottom: spec("planks", WOOD.oak) }
  if (/^(furnace|blast_furnace|smoker)$/.test(n)) return uniform(spec("cobble", [110, 110, 110]))
  if (/^(glass|tinted_glass)$/.test(n)) return uniform(spec("glass", n === "glass" ? [200, 230, 240] : [70, 50, 80]), true)
  if (new RegExp(`^(${dyes})_stained_glass(_pane)?$`).test(n)) return uniform(spec("glass", DYE[n.split("_stained")[0]]), true)
  if (n.endsWith("glass_pane")) return uniform(spec("glass", [200, 230, 240]), true)
  if (n === "ice" || n === "packed_ice" || n === "blue_ice") return uniform(spec("glass", n === "ice" ? [150, 190, 255] : [120, 170, 240]), n === "ice")
  if ((m = n.match(new RegExp(`^(${dyes})_(wool|carpet)$`)))) return uniform(spec("noise", DYE[m[1]]))
  if ((m = n.match(new RegExp(`^(${dyes})_(concrete|concrete_powder|shulker_box|glazed_terracotta)$`)))) return uniform(spec(m[2] === "shulker_box" ? "metal" : "flat", DYE[m[1]]))
  if ((m = n.match(new RegExp(`^(${dyes})_(terracotta)$`)))) return uniform(spec("flat", mix(DYE[m[1]], [150, 92, 66], 0.55)))
  if ((m = n.match(new RegExp(`^(${dyes})_(bed|banner|wall_banner)$`)))) return uniform(spec("noise", DYE[m[1]]))
  if ((m = n.match(/^(deepslate_)?(coal|iron|copper|gold|redstone|lapis|diamond|emerald)_ore$/))) return uniform(spec("ore", m[1] ? DEEP : STONE, ORE[m[2]]))
  if ((m = n.match(/^(?:raw_)?(iron|gold|diamond|emerald|lapis|redstone|coal|copper|netherite|amethyst)_block$/))) return uniform(spec(n.startsWith("raw_") ? "noise" : "metal", METAL[m[1]]))
  if (/_leaves$/.test(n)) { const w = n.replace(/_leaves$/, ""); const c: RGB = w === "spruce" ? [54, 90, 54] : w === "birch" ? [110, 150, 70] : w === "cherry" ? [236, 168, 196] : w === "dark_oak" ? [40, 110, 30] : w === "azalea" ? [90, 130, 50] : [66, 120, 40]; return uniform(spec("leaves", c)) }
  if (isPlant(n)) {
    return uniform(spec("plant", /vine|lichen|moss/.test(n) ? [56, 120, 46] : /berries|berry/.test(n) ? [60, 110, 50] : [88, 150, 56], /berr/.test(n) ? [200, 60, 60] : undefined))
  }
  if (n === "grass_block") return { top: spec("noise", [100, 160, 62]), side: spec("grassside", [100, 160, 62], [134, 96, 67]), bottom: spec("noise", [134, 96, 67]) }
  if (n === "podzol" || n === "mycelium") return { top: spec("noise", n === "podzol" ? [92, 64, 30] : [111, 98, 105]), side: spec("grassside", n === "podzol" ? [92, 64, 30] : [111, 98, 105], [134, 96, 67]), bottom: spec("noise", [134, 96, 67]) }
  // ---- shaped blocks: look like the block they are cut from
  const shaped = n.replace(SHAPE_SUFFIX, "")
  const base = ALIAS[shaped] || shaped
  if (WOOD[base]) return uniform(spec("planks", WOOD[base]))
  if (/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_(planks|mosaic)$/.test(base)) { const w = base.split(/_(planks|mosaic)/)[0]; return uniform(spec("planks", WOOD[w])) }
  switch (base) {
    case "stone": case "smooth_stone": return uniform(spec("noise", base === "stone" ? STONE : [158, 158, 158]))
    case "cobblestone": return uniform(spec("cobble", [118, 118, 118]))
    case "mossy_cobblestone": return uniform(spec("cobble", [104, 122, 96]))
    case "stone_bricks": case "cracked_stone_bricks": case "chiseled_stone_bricks": return uniform(spec("bricks", [124, 124, 124], [96, 96, 96]))
    case "mossy_stone_bricks": return uniform(spec("bricks", [112, 128, 104], [90, 100, 84]))
    case "bricks": return uniform(spec("bricks", [150, 97, 83], [166, 160, 150]))
    case "nether_bricks": return uniform(spec("bricks", [64, 32, 36], [30, 14, 18]))
    case "red_nether_bricks": return uniform(spec("bricks", [110, 24, 28], [50, 10, 12]))
    case "mud_bricks": return uniform(spec("bricks", [137, 104, 79], [110, 80, 60]))
    case "deepslate": return uniform(spec("noise", DEEP))
    case "cobbled_deepslate": return uniform(spec("cobble", [76, 76, 82]))
    case "deepslate_bricks": case "deepslate_tiles": return uniform(spec("bricks", [70, 70, 74], [48, 48, 52]))
    case "tuff": return uniform(spec("noise", [108, 109, 102]))
    case "granite": return uniform(spec("noise", [149, 103, 85]))
    case "polished_granite": return uniform(spec("flat", [154, 107, 89]))
    case "polished_diorite": return uniform(spec("flat", [193, 193, 195]))
    case "polished_andesite": return uniform(spec("flat", [132, 135, 134]))
    case "polished_deepslate": return uniform(spec("flat", [72, 72, 74]))
    case "chiseled_deepslate": return uniform(spec("bricks", [60, 60, 63], [38, 38, 41]))
    case "polished_tuff": return uniform(spec("flat", [98, 101, 93]))
    case "chiseled_tuff": return uniform(spec("bricks", [104, 106, 98], [76, 78, 70]))
    case "tuff_bricks": return uniform(spec("bricks", [101, 103, 95], [76, 78, 71]))
    case "campfire": case "soul_campfire": return uniform(spec("logside", [96, 66, 38], n === "campfire" ? [226, 130, 40] : [70, 190, 200]))
    case "quartz_bricks": return uniform(spec("bricks", [235, 229, 222], [204, 198, 190]))
    case "quartz_pillar": return uniform(spec("flat", [236, 231, 225]))
    case "moss_block": return uniform(spec("noise", [89, 109, 45]))
    case "dark_prismarine": return uniform(spec("noise", [52, 92, 76]))
    case "packed_mud": return uniform(spec("noise", [142, 106, 79]))
    case "farmland": return uniform(spec("noise", [110, 70, 40]))
    case "oxidized_cut_copper": return uniform(spec("flat", [82, 162, 132]))
    case "copper_block": return uniform(spec("flat", [192, 107, 79]))
    case "pearlescent_froglight": return uniform(spec("noise", [240, 224, 236]))
    case "ochre_froglight": return uniform(spec("noise", [243, 230, 170]))
    case "verdant_froglight": return uniform(spec("noise", [229, 244, 228]))
    case "shroomlight": return uniform(spec("noise", [240, 146, 70]))
    case "chiseled_polished_blackstone": return uniform(spec("bricks", [48, 43, 50], [28, 24, 30]))
    case "gilded_blackstone": return uniform(spec("ore", [42, 36, 41], [250, 210, 80]))
    case "redstone_lamp": return uniform(spec("noise", [150, 90, 40]))
    case "piston": case "sticky_piston": case "observer": case "dispenser": case "dropper": return uniform(spec("cobble", [117, 117, 117]))
    case "note_block": case "jukebox": return uniform(spec("planks", [110, 70, 45]))
    case "budding_amethyst": case "amethyst_block": return uniform(spec("noise", [130, 95, 190]))
    case "smithing_table": case "anvil": case "chipped_anvil": case "damaged_anvil": return uniform(spec("flat", [60, 60, 66]))
    case "stonecutter": return uniform(spec("cobble", [130, 128, 125]))
    case "lectern": case "cartography_table": return uniform(spec("planks", [120, 85, 55]))
    case "fletching_table": case "loom": return uniform(spec("planks", [180, 150, 100]))
    case "cauldron": return uniform(spec("metal", [50, 50, 56]))
    case "water_cauldron": return uniform(spec("water", [49, 99, 210]))
    case "brewing_stand": return uniform(spec("metal", [150, 150, 150]))
    case "enchanting_table": return uniform(spec("noise", [110, 30, 40]))
    case "beacon": return uniform(spec("glass", [120, 220, 215]), true)
    case "chain": return uniform(spec("metal", [40, 42, 46]))
    case "lantern": return uniform(spec("noise", [214, 150, 70]))
    case "soul_lantern": return uniform(spec("noise", [70, 200, 210]))
    case "end_rod": return uniform(spec("flat", [240, 240, 240]))
    case "iron_bars": return uniform(spec("glass", [130, 130, 135]), true)
    case "nether_portal": return uniform(spec("glass", [110, 30, 190]), true)
    case "rail": case "powered_rail": case "detector_rail": case "activator_rail": return uniform(spec("noise", [130, 110, 90]))
    case "redstone_wire": return uniform(spec("flat", [180, 20, 20]))
    case "repeater": case "comparator": return uniform(spec("flat", [160, 160, 160]))
    case "composter": return uniform(spec("planks", [122, 90, 48], [86, 62, 30]))
    case "grindstone": return uniform(spec("noise", [146, 146, 150]))
    case "diorite": return uniform(spec("noise", [188, 188, 188]))
    case "andesite": return uniform(spec("noise", [136, 136, 136]))
    case "dirt": case "coarse_dirt": case "rooted_dirt": return uniform(spec("noise", [134, 96, 67]))
    case "sand": return uniform(spec("noise", [219, 207, 163]))
    case "red_sand": return uniform(spec("noise", [190, 102, 33]))
    case "sandstone": return uniform(spec("noise", [216, 203, 155]))
    case "red_sandstone": return uniform(spec("noise", [181, 98, 31]))
    case "gravel": return uniform(spec("cobble", [131, 127, 126]))
    case "clay": return uniform(spec("flat", [160, 166, 179]))
    case "terracotta": return uniform(spec("flat", [152, 94, 67]))
    case "obsidian": return uniform(spec("noise", [20, 18, 30]))
    case "crying_obsidian": return uniform(spec("noise", [40, 10, 80]))
    case "bedrock": return uniform(spec("cobble", [60, 60, 60]))
    case "netherrack": return uniform(spec("noise", [100, 40, 40]))
    case "soul_sand": return uniform(spec("noise", [81, 62, 50]))
    case "blackstone": case "polished_blackstone": return uniform(spec("noise", [42, 36, 41]))
    case "polished_blackstone_bricks": return uniform(spec("bricks", [48, 43, 50], [28, 24, 30]))
    case "basalt": case "smooth_basalt": return uniform(spec("noise", [73, 72, 78]))
    case "calcite": return uniform(spec("noise", [223, 224, 220]))
    case "quartz_block": case "chiseled_quartz_block": return uniform(spec("flat", [235, 229, 222]))
    case "end_stone": return uniform(spec("noise", [219, 222, 158]))
    case "end_stone_bricks": return uniform(spec("bricks", [218, 224, 162], [190, 196, 140]))
    case "prismarine": return uniform(spec("noise", [99, 171, 158]))
    case "prismarine_bricks": return uniform(spec("bricks", [99, 171, 158], [60, 120, 110]))
    case "purpur_block": return uniform(spec("flat", [169, 125, 169]))
    case "snow": case "snow_block": case "powder_snow": return uniform(spec("flat", [249, 254, 254]))
    case "glowstone": return uniform(spec("noise", [240, 196, 100]))
    case "sea_lantern": return uniform(spec("noise", [172, 199, 190]))
    case "hay_block": return uniform(spec("logside", [197, 164, 24]))
    case "bone_block": return uniform(spec("logside", [229, 225, 207]))
    case "melon": return uniform(spec("logside", [141, 171, 40]))
    case "pumpkin": case "carved_pumpkin": case "jack_o_lantern": return uniform(spec("logside", [198, 118, 24]))
    case "bookshelf": return uniform(spec("planks", [120, 95, 55], [140, 40, 40]))
    case "tnt": return uniform(spec("bricks", [219, 68, 52], [230, 230, 230]))
    case "spawner": case "trial_spawner": return uniform(spec("hopper", [30, 40, 60]))
    case "sponge": case "wet_sponge": return uniform(spec("noise", [195, 192, 74]))
    case "slime_block": return uniform(spec("glass", [100, 200, 90]), true)
    case "honey_block": return uniform(spec("glass", [251, 185, 52]), true)
    case "oak": return uniform(spec("planks", WOOD.oak))
  }
  // anything else: a colour taken from the name, so unknown blocks are still told apart
  let h = 0; for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0
  const hue = h % 360, c = hsl(hue / 360, 0.35, 0.5)
  return uniform(spec("noise", c))
}
function hsl(h: number, s: number, l: number): RGB {
  const f = (k: number) => { const a = s * Math.min(l, 1 - l), t = (k + h * 12) % 12; return l - a * Math.max(-1, Math.min(t - 3, 9 - t, 1)) }
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

// ---- painting
function seeded(s: string) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return () => { h = (h + 0x6d2b79f5) >>> 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const parse = (s: string): { kind: string; c: RGB; c2: RGB | null } => {
  const [kind, a, b] = s.split("|")
  return { kind, c: a.split(",").map(Number) as RGB, c2: b ? (b.split(",").map(Number) as RGB) : null }
}

/** A tile as RGBA, 16 x 16, row 0 at the top. Deterministic: the same spec always paints the same pixels. */
export function paintTile(sp: Spec): Uint8ClampedArray {
  const { kind, c, c2 } = parse(sp), rnd = seeded(sp)
  const px = new Uint8ClampedArray(TILE * TILE * 4)
  const put = (x: number, y: number, col: RGB, f = 1, a = 255) => {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return
    const o = (y * TILE + x) * 4
    px[o] = Math.min(255, col[0] * f); px[o + 1] = Math.min(255, col[1] * f); px[o + 2] = Math.min(255, col[2] * f); px[o + 3] = a
  }
  const noise = (amp: number) => 1 + (rnd() - 0.5) * 2 * amp
  const each = (fn: (x: number, y: number) => void) => { for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) fn(x, y) }
  switch (kind) {
    case "flat": each((x, y) => put(x, y, c, noise(0.025))); break
    case "noise": {
      each((x, y) => put(x, y, c, noise(0.07)))
      for (let i = 0; i < 14; i++) { const x = (rnd() * TILE) | 0, y = (rnd() * TILE) | 0, f = rnd() < 0.5 ? 0.86 : 1.1; put(x, y, c, f); if (rnd() < 0.4) put(x + 1, y, c, f) }
      break
    }
    case "cobble": {
      let y = 0
      while (y < TILE) {
        const h = 4 + ((rnd() * 3) | 0); let x = 0
        while (x < TILE) {
          const w = 4 + ((rnd() * 4) | 0), f = 0.8 + rnd() * 0.34
          for (let yy = y; yy < Math.min(TILE, y + h); yy++) for (let xx = x; xx < Math.min(TILE, x + w); xx++) {
            const edge = yy === y + h - 1 || xx === x + w - 1 || (yy === y && rnd() < 0.3)
            put(xx, yy, c, edge ? f * 0.62 : f * (1 + (rnd() - 0.5) * 0.08))
          }
          x += w
        }
        y += h
      }
      break
    }
    case "bricks": {
      const mortar = c2 || [160, 160, 160]
      each((x, y) => {
        const row = (y / 4) | 0, off = (row % 2) * 4
        if (y % 4 === 3 || (x + off) % 8 === 7) put(x, y, mortar, noise(0.04))
        else put(x, y, c, 0.9 + ((((((x + off) / 8) | 0) * 7 + row * 13) % 5) / 5) * 0.2 + (rnd() - 0.5) * 0.05)
      })
      break
    }
    case "planks": {
      const line = c2 || dark(c, 0.62)
      const shade = [0, 1, 2, 3].map(() => 0.92 + rnd() * 0.16)
      const brk = [0, 1, 2, 3].map(() => (rnd() * 12 + 2) | 0)
      each((x, y) => {
        const b = (y / 4) | 0
        if (y % 4 === 3) put(x, y, line, 1)
        else if (x === brk[b]) put(x, y, c, 0.7)
        else put(x, y, c, shade[b] * (y % 4 === 0 ? 1.05 : 1) * noise(0.035))
      })
      if (c2) for (let i = 0; i < 3; i++) put(3 + i * 4, 1 + ((rnd() * 8) | 0), c2, 1)
      break
    }
    case "logside": { const col = Array.from({ length: TILE }, () => 0.82 + rnd() * 0.3); each((x, y) => put(x, y, c, col[x] * noise(0.05) * (y % 5 === 0 && rnd() < 0.3 ? 0.88 : 1))); break }
    case "logtop": {
      const bark = c2 || dark(c, 0.7)
      each((x, y) => {
        const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5))
        if (d > 6.9) put(x, y, bark, noise(0.05))
        else put(x, y, c, (Math.floor(d) % 2 ? 0.86 : 1.02) * noise(0.03))
      })
      break
    }
    case "grassside": {
      const dirt = c2 || [134, 96, 67]
      each((x, y) => put(x, y, dirt, noise(0.08)))
      each((x, y) => { if (y < 3 || (y === 3 && rnd() < 0.55) || (y === 4 && rnd() < 0.2)) put(x, y, c, noise(0.08)) })
      break
    }
    case "leaves": each((x, y) => put(x, y, c, rnd() < 0.22 ? 0.62 : rnd() < 0.3 ? 1.22 : noise(0.08))); break
    case "ore": {
      each((x, y) => put(x, y, c, noise(0.07)))
      const sp2 = c2 || [220, 220, 220]
      for (let i = 0; i < 6; i++) { const x = 1 + ((rnd() * 13) | 0), y = 1 + ((rnd() * 13) | 0); put(x, y, sp2, 1); put(x + 1, y, sp2, 0.92); if (rnd() < 0.7) put(x, y + 1, sp2, 0.85) }
      break
    }
    case "glass": {
      const a = 70
      each((x, y) => { const edge = x === 0 || y === 0 || x === 15 || y === 15; put(x, y, edge ? mix(c, [255, 255, 255], 0.5) : c, 1, edge ? 235 : a) })
      for (let i = 2; i < 7; i++) put(i, 14 - i, [255, 255, 255], 1, 150)
      break
    }
    case "metal": {
      each((x, y) => {
        const f = x === 0 || y === 0 ? 1.12 : x === 15 || y === 15 ? 0.78 : noise(0.025)
        put(x, y, c, f)
      })
      break
    }
    case "water": each((x, y) => put(x, y, c, 0.92 + 0.12 * Math.sin((x + y * 2) * 0.9 + rnd()), 150)); break
    case "lava": each((x, y) => put(x, y, rnd() < 0.2 ? [255, 200, 70] : c, noise(0.15))); break
    case "hopper": each((x, y) => { const rim = x < 2 || y < 2 || x > 13 || y > 13; put(x, y, c, rim ? 0.72 : noise(0.07)) }); break
    case "chest": {
      each((x, y) => { const edge = x === 0 || y === 0 || x === 15 || y === 15; put(x, y, c, edge ? 0.62 : (y === 5 ? 0.78 : noise(0.05))) })
      for (let y = 4; y < 8; y++) for (let x = 7; x < 9; x++) put(x, y, [220, 200, 150], 1)
      break
    }
    case "trapdoor": {
      const line = dark(c, 0.6)
      each((x, y) => {
        const edge = x === 0 || y === 0 || x === 15 || y === 15, bar = (y >= 2 && y <= 3) || (y >= 12 && y <= 13) || (x >= 7 && x <= 8 && y > 3 && y < 12)
        put(x, y, edge ? line : bar ? dark(c, 0.82) : c, noise(0.04))
      })
      break
    }
    case "torch": {
      for (let y = 7; y < 16; y++) for (let x = 7; x < 9; x++) put(x, y, c, noise(0.06) * (x === 7 ? 1 : 0.8))
      const flame = c2 || [255, 190, 60]
      for (let y = 5; y < 7; y++) for (let x = 7; x < 9; x++) put(x, y, flame, y === 5 ? 1.0 : 0.88)
      break
    }
    case "ladder": {
      for (let y = 0; y < TILE; y++) for (const x of [2, 3, 12, 13]) put(x, y, c, noise(0.06))
      for (const y of [2, 6, 10, 14]) for (let x = 4; x < 12; x++) put(x, y, c, 0.9 + (x % 2) * 0.06)
      break
    }
    case "plant": {
      for (let i = 0; i < 22; i++) {
        const x = (rnd() * TILE) | 0, h = 4 + ((rnd() * 10) | 0)
        for (let y = TILE - 1; y > TILE - 1 - h; y--) put(x, y, c, 0.75 + rnd() * 0.45)
      }
      if (c2) for (let i = 0; i < 5; i++) put((rnd() * TILE) | 0, 3 + ((rnd() * 8) | 0), c2, 1)
      break
    }
    default: each((x, y) => put(x, y, c, noise(0.06)))
  }
  return px
}

// ---- atlas
export type Atlas = {
  width: number
  height: number
  /** RGBA, row 0 at the BOTTOM (what a three.js DataTexture expects): tile rows are stored upside down so that v = 1 is the top of a tile */
  pixels: Uint8Array
  index: Map<Spec, number>
  /** u0, v0, u1, v1 of a tile */
  uv: (spec: Spec) => [number, number, number, number]
}
export function makeAtlas(specs: Spec[]): Atlas {
  const uniq = [...new Set(specs)]
  const cols = Math.max(1, Math.ceil(Math.sqrt(uniq.length))), rows = Math.max(1, Math.ceil(uniq.length / cols))
  const width = cols * TILE, height = rows * TILE
  const pixels = new Uint8Array(width * height * 4), index = new Map<Spec, number>()
  uniq.forEach((sp, i) => {
    index.set(sp, i)
    const t = paintTile(sp), tx = i % cols, ty = (i / cols) | 0
    for (let r = 0; r < TILE; r++) for (let x = 0; x < TILE; x++) {
      const src = (r * TILE + x) * 4, dst = ((ty * TILE + (TILE - 1 - r)) * width + tx * TILE + x) * 4
      pixels[dst] = t[src]; pixels[dst + 1] = t[src + 1]; pixels[dst + 2] = t[src + 2]; pixels[dst + 3] = t[src + 3]
    }
  })
  const uv = (sp: Spec): [number, number, number, number] => {
    const i = index.get(sp) ?? 0, tx = i % cols, ty = (i / cols) | 0, e = 0.02 / width
    return [(tx * TILE) / width + e, (ty * TILE) / height + e, ((tx + 1) * TILE) / width - e, ((ty + 1) * TILE) / height - e]
  }
  return { width, height, pixels, index, uv }
}

/** the 16 x 16 icon of a block for lists: its side tile (the top for logs) as a data URL. Browser only. */
export function iconOf(block: string): string {
  const st = styleOf(block), t = paintTile(/^(.*_)?(log|wood)$|^hay_block$/.test(block) ? st.top : st.side)
  const cv = document.createElement("canvas"); cv.width = TILE; cv.height = TILE
  const ctx = cv.getContext("2d"); if (!ctx) return ""
  ctx.putImageData(new ImageData(new Uint8ClampedArray(t), TILE, TILE), 0, 0)
  return cv.toDataURL()
}
