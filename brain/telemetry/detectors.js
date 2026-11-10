// brain/telemetry/detectors: pure functions over the telemetry ring. No bot, no clock, no files, so they are unit-testable with synthetic data.
// A sample is a 4 Hz snapshot { t, x, y, z, g, vy, yaw, h, mv, act, dg, tk, hp } (see index.js); an event is one of
//   { k:'jump', t }
//   { k:'dig',  t, block, x,y,z, held, need, have, ok, harvestOk }       (a dig started on `block` with `held` in hand)
//   { k:'place', t, block, x,y,z, sky, tk }
//   { k:'fail', t, what, note }                                          (what: noPath | timeout | digAbort | taskFailed)
// The reviewer (reviewer/) reads the flags and counters; Haiku reasons over those plus a few raw excerpts, not over raw logs.

const DEFAULTS = {
  jump: { perMin: 20, inPlaceBlocks: 8, spamPerMin: 40 },
  osc: { windowS: 30, minPath: 12, maxExtent: 3, reversals: 6, reversalExtent: 5 },
  stuck: { windowS: 20, maxExtent: 1.0, minMovingShare: 0.8 },
  idle: { windowS: 120, highS: 300, maxExtent: 1.5, unidentifiedS: 75, unidentifiedHighS: 180 },
  ladder: { windowS: 150, amplitude: 2, reversals: 4, maxExtent: 1.3, minLadderShare: 0.5 },
  tool: { minWrong: 2, minNoTool: 8 },
  stairs: { minLevels: 4, gapS: 60 },
  place: { windowS: 600, surfaceFiller: 4 },
  fail: { windowS: 300, count: 5, high: 10 },
  lava: { minSamples: 3, minSpeed: 0.5 },
  torch: { windowS: 600 },
  chat: { windowS: 60, tooFast: 2, perMin: 10, repeats: 3 },
  tier: { minOver: 3 },
  pillar: { windowS: 20, minJumps: 4, maxExtent: 1.5, minGain: 1.0, lookDown: 0.9 },
}
const FILLER = new Set(['cobblestone', 'dirt', 'stone', 'netherrack', 'cobbled_deepslate', 'gravel', 'andesite', 'diorite', 'granite', 'tuff', 'sand', 'deepslate'])

const merge = (base, over) => {
  const out = {}
  for (const k of Object.keys(base)) out[k] = over && over[k] ? { ...base[k], ...over[k] } : base[k]
  return out
}

// samples are time-ordered; return those with t >= since
function since(samples, t) {
  let i = samples.length
  while (i > 0 && samples[i - 1].t >= t) i--
  return samples.slice(i)
}
const evSince = (events, t, k) => events.filter(e => e.t >= t && (!k || e.k === k))

function extent(ss) {
  if (!ss.length) return 0
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const s of ss) { if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x; if (s.y < y0) y0 = s.y; if (s.y > y1) y1 = s.y; if (s.z < z0) z0 = s.z; if (s.z > z1) z1 = s.z }
  return Math.max(x1 - x0, y1 - y0, z1 - z0)
}
function hExtent(ss) {
  if (!ss.length) return 0
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const s of ss) { if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x; if (s.z < z0) z0 = s.z; if (s.z > z1) z1 = s.z }
  return Math.max(x1 - x0, z1 - z0)
}
function pathLength(ss, jitter = 0.03) {
  let d = 0
  for (let i = 1; i < ss.length; i++) {
    const dd = Math.hypot(ss[i].x - ss[i - 1].x, ss[i].z - ss[i - 1].z)
    if (dd > jitter) d += dd
  }
  return d
}
// the window must really be covered by samples (a bot that was offline for most of it proves nothing)
const covers = (ss, windowMs, share = 0.85) => ss.length > 1 && (ss[ss.length - 1].t - ss[0].t) >= windowMs * share

// ---- tool whitelist, derived from the block data itself (minecraft-data: material, hardness, harvestTools), not hand-written per block ----
// material "mineable/axe" -> axes; "leaves;mineable/hoe" -> hoes and shears; wool -> shears; cobweb -> swords and shears; vine/glow lichen -> shears (and axes);
// hardness 0 breaks instantly with anything (saplings, flowers, torches); a block with harvestTools (stone, ores) only drops with those items.
const EXTRA = { leaves: ['hoe', 'shears'], wool: ['shears'], coweb: ['sword', 'shears'], vine_or_glow_lichen: ['shears'], sword_instantly_mines: ['sword'] }
const TOOL_CLASSES = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword', 'shears']
const toolClass = (name) => { const n = name || ''; return n === 'shears' ? 'shears' : (TOOL_CLASSES.find(c => c !== 'shears' && n.endsWith('_' + c)) || null) }
function allowedClasses(block) {
  const out = []
  for (const tok of String(block && block.material || '').split(';')) {
    const m = /^mineable\/(\w+)$/.exec(tok)
    for (const c of m ? [m[1]] : /^incorrect_for_/.test(tok) ? ['pickaxe'] : (EXTRA[tok] || [])) if (!out.includes(c)) out.push(c)   // ores are tagged incorrect_for_<tier>_tool: pickaxe blocks
  }
  return out
}
// block: { name, material, hardness, harvestTools }; held: { name, type } | null; inventory: [item names]
// -> { need (preferred class), allowed, ok (held item is whitelisted for this block), have (a whitelisted tool is in the bag), harvestOk (the block drops with this item) }
// tool tiers (Walter 2026-11-10: use the minimum tier that gets the job done; stone is the default, wood only very early, higher only when the block needs it)
const TIERS = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 }
const tierOf = (name) => { const m = /^(wooden|golden|stone|iron|diamond|netherite)_(pickaxe|axe|shovel|hoe)$/.exec(name || ''); return m ? TIERS[m[1]] : null }
// lowest tier whose tool still drops the block: from harvestTools item names when the block needs a tier (ores, obsidian), else stone
function neededTier(harvestNames) {
  const ts = (harvestNames || []).map(tierOf).filter(t => t !== null)
  return ts.length ? Math.max(1, Math.min(...ts)) : 1
}
function toolCheck(block, held, inventory, harvestNames) {
  const allowed = allowedClasses(block)
  const instant = block && block.hardness === 0
  const heldClass = toolClass(held && held.name)
  const ok = instant || !allowed.length || allowed.includes(heldClass)
  const have = !!allowed.length && (inventory || []).some(n => allowed.includes(toolClass(n)))
  let harvestOk = true
  if (block && block.harvestTools && Object.keys(block.harvestTools).length) harvestOk = !!(held && block.harvestTools[held.type])
  // overTier: a stone-or-better-than-needed tool is held although a tool of the same class at or above the needed tier but lower than the held one is in the bag
  const ht = tierOf(held && held.name), need = neededTier(harvestNames)
  let overTier = false
  if (!instant && ok && ht !== null && ht > need && heldClass) overTier = (inventory || []).some(n => n !== (held && held.name) && n.endsWith('_' + heldClass) && tierOf(n) !== null && tierOf(n) >= need && tierOf(n) < ht)
  return { need: instant ? null : (allowed[0] || null), allowed, ok, have, harvestOk, overTier, tier: ht, needTier: need }
}

// ---- individual detectors: each returns a flag or null ----
const NON_BLOCK = /(_sword|_pickaxe|_axe|_shovel|_hoe|^bow$|^crossbow$|^shield$|^fishing_rod$|^torch$|_bucket$|^$)/
const isBlockItem = (h) => !NON_BLOCK.test(h || '')

// Jumping on the spot is fine while pillaring up (a block lands under every jump); pillarFlag below judges that case, this one stays quiet while blocks land.
function jumpFlags(samples, events, now, cfg) {
  const t0 = now - 60000
  const jumps = evSince(events, t0, 'jump').length
  if (jumps < cfg.jump.perMin) return []
  const ss = since(samples, t0)
  const ext = hExtent(ss)
  const inPlace = ext < cfg.jump.inPlaceBlocks
  const placed = evSince(events, t0, 'place').length
  const held = (ss[ss.length - 1] || {}).h || ''
  if (inPlace && placed >= jumps * 0.5) return []                  // working pillar
  if (!inPlace && jumps < cfg.jump.spamPerMin) return []
  const out = [{ kind: 'jumping', sev: inPlace ? 'high' : 'med', t0, t1: now,
    msg: `${jumps} jumps in the last minute while covering only ${ext.toFixed(1)} blocks${inPlace ? ' (jumping on the spot)' : ' (bunny-hopping)'}; ${placed} block(s) placed, holding ${held || 'nothing'}`, data: { jumps, extent: +ext.toFixed(1), placed, held } }]
  return out
}

// Pillaring up (jump, place a block under yourself, repeat): count the jumps made while standing on one spot looking down and compare with the height gained.
// Failing = several jumps and no height, or a held item that cannot be placed. Walter 2026-11-10: Smeo444 jumped with a sword in hand and never got up.
function pillarFlag(samples, events, now, cfg) {
  const c = cfg.pillar, w = c.windowS * 1000, t0 = now - w
  const ss = since(samples, t0)
  if (ss.length < 20) return null
  const jumps = evSince(events, t0, 'jump').length
  if (jumps < 3 || hExtent(ss) > c.maxExtent) return null
  const lookingDown = ss.filter(s => typeof s.pit === 'number' && s.pit >= c.lookDown).length / ss.length >= 0.5
  const placed = evSince(events, t0, 'place').length
  if (!lookingDown && !placed) return null                       // jumping in place without aiming down is the plain jumping flag
  const gain = Math.max(0, ss[ss.length - 1].y - ss[0].y), peak = Math.max(...ss.map(s => s.y)) - Math.min(...ss.map(s => s.y))
  const held = ss[ss.length - 1].h || ''
  const data = { jumps, placed, heightGained: +Math.max(gain, 0).toFixed(1), peakRange: +peak.toFixed(1), held }
  if (!isBlockItem(held) && jumps >= 3) return { kind: 'pillar_failing', sev: 'high', t0, t1: now,
    msg: `trying to pillar up: ${jumps} jumps looking down in ${c.windowS}s with ${held || 'an empty hand'} in hand (not a placeable block), ${placed} placed, height gained ${data.heightGained}`, data }
  if (jumps >= c.minJumps && gain < c.minGain && placed < jumps * 0.5) return { kind: 'pillar_failing', sev: 'high', t0, t1: now,
    msg: `trying to pillar up: ${jumps} jumps looking down in ${c.windowS}s, ${placed} block(s) placed, height gained ${data.heightGained} (holding ${held})`, data }
  return null
}

function oscillationFlag(samples, now, cfg) {
  const w = cfg.osc.windowS * 1000, t0 = now - w
  const ss = since(samples, t0)
  if (!covers(ss, w)) return null
  const path = pathLength(ss), ext = hExtent(ss)
  // heading reversals on a 1 s grid: the bot walks one way, then back, then forth
  const grid = ss.filter((_, i) => i % 4 === 0)
  let rev = 0, prev = null
  for (let i = 1; i < grid.length; i++) {
    const v = [grid[i].x - grid[i - 1].x, grid[i].z - grid[i - 1].z]
    if (Math.hypot(v[0], v[1]) < 0.15) continue
    if (prev && (v[0] * prev[0] + v[1] * prev[1]) / (Math.hypot(...v) * Math.hypot(...prev)) < -0.5) rev++
    prev = v
  }
  const byPath = path >= cfg.osc.minPath && ext <= cfg.osc.maxExtent
  const byRev = rev >= cfg.osc.reversals && ext <= cfg.osc.reversalExtent
  if (!byPath && !byRev) return null
  return { kind: 'oscillating', sev: 'high', t0, t1: now,
    msg: `walked ${path.toFixed(0)} blocks in ${cfg.osc.windowS}s but never left a ${ext.toFixed(1)}-block area (${rev} direction reversals)`, data: { path: +path.toFixed(1), extent: +ext.toFixed(1), reversals: rev } }
}

function stuckFlag(samples, now, cfg) {
  const w = cfg.stuck.windowS * 1000, t0 = now - w
  const ss = since(samples, t0)
  if (!covers(ss, w)) return null
  const moving = ss.filter(s => s.mv && !s.act).length / ss.length
  if (moving < cfg.stuck.minMovingShare || extent(ss) >= cfg.stuck.maxExtent) return null
  return { kind: 'stuck', sev: 'high', t0, t1: now,
    msg: `trying to move (pathfinder/controls active ${Math.round(moving * 100)}% of ${cfg.stuck.windowS}s) but did not leave a ${extent(ss).toFixed(1)}-block spot`, data: { task: ss[ss.length - 1].tk || null } }
}

// Standing still with nothing productive going on. "Productive" is any sign of work in the window: busy bits (digging, swinging, eating, a container open, sleeping),
// dig/place events (so reseeding a farm, planting saplings or tidying never counts as idle), picking items up, opening a container, or the autopilot moving to a new step.
// A task that cannot be identified (no scheduler task, no autopilot step) is judged sooner than one that names itself but shows no sign of work at all.
const UNNAMED = new Set(['', 'idle', '(none)'])
function idleFlag(samples, events, now, cfg) {
  const c = cfg.idle
  const last = samples[samples.length - 1]
  const named = !!last && (!UNNAMED.has(last.tk || '') || !!last.st)
  const levels = named ? [[c.highS, 'high'], [c.windowS, 'med']] : [[c.unidentifiedHighS, 'high'], [c.unidentifiedS, 'med']]
  for (const [sec, sev] of levels) {
    const w = sec * 1000, t0 = now - w
    const ss = since(samples, t0)
    if (!covers(ss, w)) continue
    if (ss.some(s => s.act)) continue
    if (extent(ss) >= c.maxExtent) continue
    if (evSince(events, t0).some(e => e.k === 'dig' || e.k === 'place' || e.k === 'work')) continue
    if (new Set(ss.map(s => s.st || '')).size > 1) continue              // the autopilot went from one step to another: it is deciding things
    return { kind: 'idle', sev, t0, t1: now,
      msg: `standing still for ${sec}s with no sign of work (no digging, placing, picking up, container, eating or sleeping; no step change); ${named ? `task "${last.tk || '-'}"${last.st ? `, step "${last.st}"` : ''} gives no visible output` : 'no identifiable task'}`,
      data: { seconds: sec, task: last.tk || null, step: last.st || null, identified: named } }
  }
  return null
}

// Bobbing on a ladder: up and down the same ladder column again and again with nothing done there. A trip down a shaft (and back up) is one or two long legs;
// bobbing is four or more turns of 2+ blocks inside 2.5 minutes, on a ladder, in one column, with no digging or placing.
function zigzag(ys, thr) {
  let hi = ys[0], lo = ys[0], dir = 0, rev = 0
  for (const y of ys) {
    if (y > hi) hi = y
    if (y < lo) lo = y
    if (dir <= 0 && y - lo >= thr) { if (dir === -1) rev++; dir = 1; hi = lo = y }
    else if (dir >= 0 && hi - y >= thr) { if (dir === 1) rev++; dir = -1; hi = lo = y }
  }
  return rev
}
function ladderBobFlag(samples, events, now, cfg) {
  const c = cfg.ladder, w = c.windowS * 1000, t0 = now - w
  const ss = since(samples, t0)
  if (!covers(ss, w) || hExtent(ss) > c.maxExtent) return null
  if (ss.filter(s => s.ld).length / ss.length < c.minLadderShare) return null
  if (evSince(events, t0).some(e => e.k === 'dig' || e.k === 'place')) return null
  const rev = zigzag(ss.filter((_, i) => i % 4 === 0).map(s => s.y), c.amplitude)
  if (rev < c.reversals) return null
  const ys = ss.map(s => s.y), last = ss[ss.length - 1]
  return { kind: 'ladder_bobbing', sev: 'high', t0, t1: now,
    msg: `went up and down the same ladder ${rev + 1} times in ${c.windowS}s (y ${Math.min(...ys).toFixed(0)} to ${Math.max(...ys).toFixed(0)}, column ${Math.floor(last.x)},${Math.floor(last.z)}) with nothing dug or placed`,
    data: { turns: rev, yRange: [+Math.min(...ys).toFixed(1), +Math.max(...ys).toFixed(1)], column: [Math.floor(last.x), Math.floor(last.z)], task: last.tk || null, step: last.st || null } }
}

function toolFlags(events, now) {
  const out = []
  const t0 = now - 300000
  const digs = evSince(events, t0, 'dig')
  const cannot = digs.filter(d => d.harvestOk === false)
  if (cannot.length) out.push({ kind: 'cannot_harvest', sev: 'high', t0, t1: now,
    msg: `dug ${cannot.length} block(s) that drop nothing with the held item (e.g. ${cannot[cannot.length - 1].block} with ${cannot[cannot.length - 1].held || 'bare hand'})`, data: { n: cannot.length, example: cannot[cannot.length - 1] } })
  return out
}
function wrongToolFlag(events, now, cfg) {
  const t0 = now - 300000
  const digs = evSince(events, t0, 'dig').filter(d => d.need && d.harvestOk !== false)
  const tally = (list) => { const m = {}; for (const d of list) { const k = `${d.block} with ${d.held || 'bare hand'}`; m[k] = (m[k] || 0) + 1 } return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} x${n}`).join(', ') }
  const wrong = digs.filter(d => !d.ok && d.have)
  if (wrong.length >= cfg.tool.minWrong) {
    const last = wrong[wrong.length - 1]
    return { kind: 'wrong_tool', sev: 'med', t0, t1: now,
      msg: `${wrong.length} of ${digs.length} digs in 5 min used an item that is not whitelisted for the block although a ${last.need} was in the bag: ${tally(wrong)}`, data: { wrong: wrong.length, digs: digs.length, example: last } }
  }
  const noTool = digs.filter(d => !d.ok && !d.have)
  if (noTool.length >= cfg.tool.minNoTool) {
    const last = noTool[noTool.length - 1]
    return { kind: 'no_tool', sev: 'low', t0, t1: now, msg: `${noTool.length} digs in 5 min with no suitable tool in the bag at all: ${tally(noTool)}`, data: { n: noTool.length, example: last } }
  }
  return null
}

// a descending (or ascending) staircase: successive new y levels dug one step sideways in a constant direction
function stairsFlag(events, now, cfg) {
  const t0 = now - 600000
  const digs = evSince(events, t0, 'dig').filter(d => Number.isFinite(d.x))
  let chain = [], best = []
  let dir = 0
  const consider = () => { if (chain.length > best.length) best = chain }
  for (const d of digs) {
    const last = chain[chain.length - 1]
    if (!last) { chain = [d]; dir = 0; continue }
    if (d.t - last.t > cfg.stairs.gapS * 1000) { consider(); chain = [d]; dir = 0; continue }
    if (d.y === last.y) continue
    const dy = d.y - last.y, dx = d.x - last.x, dz = d.z - last.z
    const stepOk = Math.abs(dy) === 1 && Math.abs(dx) + Math.abs(dz) >= 1 && Math.abs(dx) + Math.abs(dz) <= 2
    const sameDir = !dir || dy === dir
    if (stepOk && sameDir) { dir = dy; chain.push(d); continue }
    consider(); chain = [d]; dir = 0
  }
  consider()
  if (best.length < cfg.stairs.minLevels) return null
  const a = best[0], b = best[best.length - 1]
  const drift = Math.abs(b.x - a.x) + Math.abs(b.z - a.z)
  if (drift < best.length - 1) return null    // straight shaft: not a staircase
  return { kind: 'staircase', sev: 'med', t0, t1: now,
    msg: `dug a ${dir < 0 ? 'descending' : 'ascending'} staircase of ${best.length} levels from ${a.x},${a.y},${a.z} to ${b.x},${b.y},${b.z}`, data: { levels: best.length, from: [a.x, a.y, a.z], to: [b.x, b.y, b.z] } }
}

function placementFlag(events, now, cfg) {
  const t0 = now - cfg.place.windowS * 1000
  const ps = evSince(events, t0, 'place').filter(p => FILLER.has(p.block))
  const surface = ps.filter(p => p.sky)
  if (surface.length < cfg.place.surfaceFiller) return null
  const last = surface[surface.length - 1]
  const tasks = [...new Set(surface.map(p => p.tk).filter(Boolean))].join(', ')
  return { kind: 'surface_blocks', sev: 'med', t0, t1: now,
    msg: `placed ${surface.length} filler blocks (${[...new Set(surface.map(p => p.block))].join(', ')}) in the open air in ${Math.round(cfg.place.windowS / 60)} min, last at ${last.x},${last.y},${last.z}${tasks ? `; tasks: ${tasks}` : ''}`, data: { n: surface.length, last: [last.x, last.y, last.z] } }
}

// Walter 2026-11-10: torches keep at least two blocks between them on a line (torch, air, air, torch is the minimum). A torch at the same height that is
// adjacent (also diagonally) or on the same axis line less than 3 blocks away is too close. Flag only: the bots tidy up themselves, and must check that
// the remaining torches still keep the area lit (no hostile spawns) before removing one.
function torchTooClose(p, q) {
  if (p.y !== q.y) return false
  const dx = Math.abs(p.x - q.x), dz = Math.abs(p.z - q.z)
  if (dx === 0 && dz === 0) return false
  return (dx <= 1 && dz <= 1) || ((dx === 0 || dz === 0) && Math.max(dx, dz) < 3)
}
function torchFlag(events, now, cfg) {
  const t0 = now - cfg.torch.windowS * 1000
  const bad = evSince(events, t0, 'torch').filter(e => e.near && e.near.length)
  if (!bad.length) return null
  const e = bad[bad.length - 1], n = e.near[0]
  return { kind: 'torch_spacing', sev: 'med', t0, t1: now,
    msg: `${bad.length} torch(es) placed closer than torch-air-air-torch (e.g. ${e.block} at ${e.x},${e.y},${e.z} is ${n[3]} block(s) from another at ${n[0]},${n[1]},${n[2]}${e.tk ? `, task ${e.tk}` : ''}); remove one only if the rest still keeps the area lit`, data: { n: bad.length, at: [e.x, e.y, e.z], near: n } }
}

function failFlags(events, now, cfg) {
  const t0 = now - cfg.fail.windowS * 1000
  const by = {}
  for (const e of evSince(events, t0, 'fail')) (by[e.what] = by[e.what] || []).push(e)
  const out = []
  for (const [what, list] of Object.entries(by)) {
    if (list.length < cfg.fail.count) continue
    out.push({ kind: 'repeated_failure', sev: list.length >= cfg.fail.high ? 'high' : 'med', t0, t1: now,
      msg: `${list.length}x ${what} in ${Math.round(cfg.fail.windowS / 60)} min${list[list.length - 1].note ? ` (last: ${list[list.length - 1].note})` : ''}`, data: { what, n: list.length } })
  }
  return out
}

function lavaFlag(samples, now, cfg) {
  const t0 = now - 20000
  const ss = since(samples, t0)
  let n = 0
  for (let i = 1; i < ss.length; i++) {
    if (ss[i].h !== 'lava_bucket') continue
    const dt = (ss[i].t - ss[i - 1].t) / 1000
    if (dt > 0 && Math.hypot(ss[i].x - ss[i - 1].x, ss[i].z - ss[i - 1].z) / dt > cfg.lava.minSpeed) n++
  }
  if (n < cfg.lava.minSamples) return null
  return { kind: 'lava_in_hand', sev: 'high', t0, t1: now, msg: 'walking with a lava bucket selected (Walter\'s rule 2)', data: { samples: n } }
}

// ---- rule flags (Walter's rules of play): state and event based, no model ----
const ARMOR = /_(helmet|chestplate|leggings|boots)$/
const ARMOR_SLOTS = { 5: 'head', 6: 'chest', 7: 'legs', 8: 'feet' }
// state.worn: [{ slot, name, mending }]. No armor (Walter 2026-11-10) except diamond/netherite with Mending, or a mob-farm drop (state.farmDrops: names allowed by brain/state/telemetry/rules.json).
function armorFlag(state, now) {
  const bad = ((state && state.worn) || []).filter(a => ARMOR.test(a.name) && !(/^(diamond|netherite)_/.test(a.name) && a.mending) && !(state.farmDrops || []).includes(a.name))
  if (!bad.length) return null
  return { kind: 'armor_equipped', sev: 'high', t0: now - 60000, t1: now,
    msg: `wearing armor, which is banned (${bad.map(a => `${a.name} on ${ARMOR_SLOTS[a.slot] || 'slot ' + a.slot}`).join(', ')}); only diamond with Mending or a mob-farm drop is allowed`, data: { worn: bad } }
}
// armor in the bag, not worn: crafted or picked up against the no-armor rule (the 05:16 review found four iron pieces carried). med, and not for Mending diamond or listed farm drops.
function armorCarriedFlag(state, now) {
  const bad = ((state && state.carried) || []).filter(a => ARMOR.test(a.name) && !(/^(diamond|netherite)_/.test(a.name) && a.mending) && !(state.farmDrops || []).includes(a.name))
  if (!bad.length) return null
  return { kind: 'armor_carried', sev: 'med', t0: now - 60000, t1: now,
    msg: `carrying armor in the bag (${bad.map(a => `${a.name} x${a.count || 1}`).join(', ')}); armor is banned, so it should not be crafted or kept (stash it, or only keep Mending diamond / mob-farm drops)`, data: { carried: bad } }
}
function tierFlag(events, now, cfg) {
  const t0 = now - 300000
  const over = evSince(events, t0, 'dig').filter(d => d.overTier)
  if (over.length < cfg.tier.minOver) return null
  const m = {}; for (const d of over) { const k = `${d.block} with ${d.held}`; m[k] = (m[k] || 0) + 1 }
  const top = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} x${n}`).join(', ')
  return { kind: 'tool_tier', sev: 'med', t0, t1: now, msg: `${over.length} digs in 5 min with a higher tool tier than the block needs although a lower suitable one was in the bag (stone is the default, iron only for diamond/gold/redstone/emerald, diamond only for obsidian): ${top}`, data: { n: over.length, example: over[over.length - 1] } }
}
// own chat lines: events { k:'chat', t, text }. Rule 5: at most one message per second, never spam
function chatFlag(events, now, cfg) {
  const t0 = now - cfg.chat.windowS * 1000
  const ch = evSince(events, t0, 'chat')
  if (ch.length < 3) return null
  let fast = 0; for (let i = 1; i < ch.length; i++) if (ch[i].t - ch[i - 1].t < 1000) fast++
  const rep = {}; for (const c of ch) rep[c.text] = (rep[c.text] || 0) + 1
  const [txt, n] = Object.entries(rep).sort((a, b) => b[1] - a[1])[0]
  if (n >= cfg.chat.repeats) return { kind: 'chat_spam', sev: 'high', t0, t1: now, msg: `said the same line ${n}x in ${cfg.chat.windowS}s: "${String(txt).slice(0, 60)}"`, data: { n, text: txt } }
  if (fast >= cfg.chat.tooFast || ch.length >= cfg.chat.perMin) return { kind: 'chat_spam', sev: 'med', t0, t1: now, msg: `${ch.length} chat lines in ${cfg.chat.windowS}s, ${fast} of them less than 1 s after the previous one (rule: one message per second at most, short)`, data: { n: ch.length, fast } }
  return null
}

function analyze(samples, events, now, over, state) {
  const cfg = merge(DEFAULTS, over)
  const flags = [
    ...jumpFlags(samples, events, now, cfg), pillarFlag(samples, events, now, cfg), ladderBobFlag(samples, events, now, cfg), oscillationFlag(samples, now, cfg), stuckFlag(samples, now, cfg), idleFlag(samples, events, now, cfg),
    wrongToolFlag(events, now, cfg), stairsFlag(events, now, cfg), placementFlag(events, now, cfg), torchFlag(events, now, cfg), lavaFlag(samples, now, cfg), armorFlag(state, now), armorCarriedFlag(state, now), tierFlag(events, now, cfg), chatFlag(events, now, cfg),
    ...toolFlags(events, now), ...failFlags(events, now, cfg),
  ].filter(Boolean)
  return flags
}

// compact numbers for the reviewer: what the bot did in the last `windowMs`
function counters(samples, events, now, windowMs) {
  const t0 = now - windowMs
  const ss = since(samples, t0), ev = evSince(events, t0)
  const tasks = {}, held = {}
  let idleS = 0, hpMin = null
  for (let i = 1; i < ss.length; i++) {
    const dt = Math.min(2, (ss[i].t - ss[i - 1].t) / 1000)
    const tk = ss[i].tk || '(none)', h = ss[i].h || '(empty hand)'
    tasks[tk] = (tasks[tk] || 0) + dt     // rounded once after the loop: rounding each 0.25 s step to 0.1 drifted the sums about 10% over the window (the reviewer reported it as a bug for 10 hours)
    held[h] = (held[h] || 0) + dt
    if (!ss[i].act && Math.hypot(ss[i].x - ss[i - 1].x, ss[i].z - ss[i - 1].z) < 0.02 && Math.abs(ss[i].y - ss[i - 1].y) < 0.02) idleS += dt
    if (typeof ss[i].hp === 'number') hpMin = hpMin === null ? ss[i].hp : Math.min(hpMin, ss[i].hp)
  }
  for (const k of Object.keys(tasks)) tasks[k] = +tasks[k].toFixed(1)
  for (const k of Object.keys(held)) held[k] = +held[k].toFixed(1)
  const digs = ev.filter(e => e.k === 'dig'), mins = Math.max(windowMs / 60000, 1e-6)
  const spanMin = ss.length > 1 ? (ss[ss.length - 1].t - ss[0].t) / 60000 : 0
  const fails = {}
  for (const e of ev.filter(e => e.k === 'fail')) fails[e.what] = (fails[e.what] || 0) + 1
  return {
    windowMin: +mins.toFixed(1), coveredMin: +spanMin.toFixed(1),
    jumps: ev.filter(e => e.k === 'jump').length, jumpsPerMin: spanMin ? +(ev.filter(e => e.k === 'jump').length / spanMin).toFixed(1) : 0,
    blocksWalked: +pathLength(ss).toFixed(0), idleSeconds: +idleS.toFixed(0),
    digs: digs.length, digsWithWrongTool: digs.filter(d => d.need && !d.ok && d.have).length, digsThatDropNothing: digs.filter(d => d.harvestOk === false).length,
    placed: ev.filter(e => e.k === 'place').length, placedOpenAir: ev.filter(e => e.k === 'place' && e.sky && FILLER.has(e.block)).length,
    failures: fails, minHp: hpMin, secondsByTask: tasks, secondsByHeldItem: held,
    yRange: ss.length ? [+Math.min(...ss.map(s => s.y)).toFixed(0), +Math.max(...ss.map(s => s.y)).toFixed(0)] : null,
  }
}

// a 1 Hz excerpt around a flagged window, small enough to hand to a model
function excerpt(samples, t0, t1, maxPoints = 60) {
  const ss = samples.filter(s => s.t >= t0 - 5000 && s.t <= t1 + 1000)
  const step = Math.max(1, Math.ceil(ss.length / maxPoints))
  return ss.filter((_, i) => i % step === 0).map(s => [Math.round((s.t - t0) / 1000), +s.x.toFixed(1), +s.y.toFixed(1), +s.z.toFixed(1), s.g, s.h || '', s.tk || '', s.dg || ''])
}
excerpt.columns = ['sec', 'x', 'y', 'z', 'onGround', 'held', 'task', 'digging']

module.exports = { zigzag, torchTooClose, evSince, covers, isBlockItem, NON_BLOCK, DEFAULTS, FILLER, analyze, counters, excerpt, toolCheck, tierOf, neededTier, armorFlag, armorCarriedFlag, since, extent, hExtent, pathLength, merge }
