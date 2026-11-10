// brain/autopilot/pursue.js: long goals by recipe tree (Walter 2026-11-04: plain iron pickaxes are inefficient -> enchanting).
// A goal is an item. Its recipe tree comes from minecraft-data, so nothing per item is hard-coded except how raw things are obtained
// (SOURCES: which ore at which depth, which mob drops it, which plant). The step picks the first missing raw material it can get now,
// gets it with the existing primitives (tunnel at the ore's depth, hunt, gather), and crafts upward whenever a level becomes craftable.
// Goals live in brain/state/goals.json: ["enchanting_table", "diamond_pickaxe", ...] (first unmet one is pursued).
const fs = require('fs')

const SOURCES = {
  diamond: { ore: /^(deepslate_)?diamond_ore$/, y: -54, tool: 3 },
  lapis_lazuli: { ore: /^(deepslate_)?lapis_ore$/, y: -2, tool: 2 },
  redstone: { ore: /^(deepslate_)?redstone_ore$/, y: -54, tool: 3 },
  raw_iron: { ore: /^(deepslate_)?iron_ore$/, y: 16, tool: 2 },
  raw_gold: { ore: /^(deepslate_)?gold_ore$/, y: -16, tool: 3 },
  coal: { ore: /^(deepslate_)?coal_ore$/, y: 48, tool: 1 },
  emerald: { ore: /^(deepslate_)?emerald_ore$/, y: 100, tool: 3 },
  obsidian: { ore: /^obsidian$/, y: -40, tool: 4 },            // found by lava pools deep down; needs a diamond pickaxe
  leather: { mob: /^cow$/ }, feather: { mob: /^chicken$/ }, string: { mob: /^(spider|cave_spider)$/ }, white_wool: { mob: /^sheep$/ },
  sugar_cane: { plant: /^sugar_cane$/ }, wheat: { plant: /^wheat$/ }
}
const SMELT = { iron_ingot: 'raw_iron', gold_ingot: 'raw_gold' }

module.exports = function pursue(G, S, M, api, log, helpers) {
  const bot = S.bot, { goals } = S, v = S.v
  const st = G.state
  const mc = require('minecraft-data')(bot.version)
  const note = (m) => { try { G.note(m) } catch { log('PURSUE', m) } }
  const file = api.statePath('goals.json')
  const goalList = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [] } }
  const cnt = (n) => S.count(n)

  // the cheapest recipe for an item (fewest distinct ingredients, prefer ones we already hold)
  function recipeOf(name) {
    const it = mc.itemsByName[name]; if (!it) return null
    const rs = mc.recipes[it.id]; if (!rs || !rs.length) return null
    const need = (r) => { const m = {}; const add = (id) => { if (id == null || id === -1) return; const i = typeof id === 'object' ? (id.id ?? id[0]) : id; const n = mc.items[i] && mc.items[i].name; if (n) m[n] = (m[n] || 0) + 1 }
      if (r.inShape) for (const row of r.inShape) for (const c of row) add(c); if (r.ingredients) for (const c of r.ingredients) add(c); return m }
    let best = null
    for (const r of rs) { const m = need(r); const score = Object.keys(m).reduce((s, k) => s + (cnt(k) ? 0 : 1), 0); if (!best || score < best.score) best = { m, out: (r.result && r.result.count) || 1, score } }
    return best
  }
  // walk the tree: returns the raw materials still missing, as [{name, n}]
  function missing(name, n, depth = 0, seen = new Set()) {
    const have = cnt(name); if (have >= n) return []
    const short = n - have
    if (SMELT[name]) return missing(SMELT[name], short, depth + 1, seen)
    if (SOURCES[name] || depth > 6 || seen.has(name)) return [{ name, n: short }]
    const r = recipeOf(name); if (!r) return [{ name, n: short }]
    seen = new Set([...seen, name])
    const times = Math.ceil(short / r.out), out = []
    for (const [k, c] of Object.entries(r.m)) out.push(...missing(k, c * times, depth + 1, seen))
    return out
  }
  // craft upward: try the goal, then its intermediates, whenever ingredients are present
  async function craftUp(name, n, depth = 0) {
    if (cnt(name) >= n || depth > 6) return cnt(name) >= n
    if (SMELT[name] && cnt(SMELT[name])) { await S.smelt(SMELT[name], Math.min(cnt(SMELT[name]), n - cnt(name))) }
    const r = recipeOf(name)
    if (r) for (const [k, c] of Object.entries(r.m)) await craftUp(k, c * Math.ceil((n - cnt(name)) / r.out), depth + 1)
    if (r) await S.craft(name, n)
    return cnt(name) >= n
  }
  const ironUnitsLow = () => (cnt('raw_iron') + cnt('iron_ingot') + cnt('iron_block') * 9) < 32   // the iron step mines while below this
  function current() { for (const g of goalList()) { const [name, n] = Array.isArray(g) ? g : [g, 1]; if (cnt(name) < n && !(st.goalsDone || []).includes(name)) return { name, n } } return null }

  // the pickaxe each tool tier needs (SOURCES[..].tool): a goal blocked by tier pursues that pickaxe first
  const TIER_PICK = { 2: 'stone_pickaxe', 3: 'iron_pickaxe', 4: 'diamond_pickaxe' }
  const step = { id: 'pursue', budget: 600000, cool: 120000, need: () => { const c = current(); return !!c && S.toolTier('pickaxe') >= 2 && S.count('torch') >= 12 && S.foodPoints() >= 6 && helpers.daylightOk() }, run: async () => work(current(), 0) }
  async function work(goal, depth) {
    if (!goal) return false
    if (await craftUp(goal.name, goal.n)) { note(`pursue: made ${goal.name}`); if (!depth) { st.goalsDone = (st.goalsDone || []).concat([goal.name]); G.save() } return true }
    const miss = missing(goal.name, goal.n)
    const plan = miss.map(m => ({ ...m, src: SOURCES[m.name] })).filter(m => m.src)
    note(`pursue ${goal.name}: missing ${miss.map(m => m.n + ' ' + m.name).join(', ') || 'nothing raw'}`)
    // the first raw material we can get with the tools we have now
    // iron-tier ores are searched for with the stone pickaxe: the iron one is made in the tunnel only when such an ore is in sight (Walter 2026-11-06)
    const next = plan.find(m => !m.src.tool || S.toolTier('pickaxe') >= m.src.tool || (m.src.tool === 3 && S.toolTier('pickaxe') >= 2 && S.count('iron_ingot') + S.count('raw_iron') >= 3))
    if (!next) {
      const tierNeed = Math.min(...plan.map(m => m.src.tool || 0)), pick = TIER_PICK[tierNeed]
      if (pick && depth < 2 && pick !== goal.name && cnt(pick) === 0) { note(`pursue ${goal.name}: needs a ${pick} first`); return work({ name: pick, n: 1 }, depth + 1) }
      note(`pursue ${goal.name}: blocked (needs a better pickaxe for ${plan.map(m => m.name).join(', ')})`); return false
    }
    const src = next.src, before = cnt(next.name)
    if (src.ore) {
      // with a mine, ores come from the iron step's trips (its stairs, its dusk and dawn rules, its 20-block tunnels): pursue's own walk
      // down by a cave route and 48-block tunnel kept it below at nightfall, and creepers at the shaft entry killed it (14:42)
      if (st.mine && st.mine.bottom && (st.mine.path || []).length > 3 && ironUnitsLow()) { note(`pursue ${goal.name}: ${next.name} comes from the mine trips`); G.cool.pursue = Date.now() + 20 * 60000; return false }
      // ores come through the one established shaft (the iron step digs it); without it, digging down from wherever the bot stands breached
      // new holes and ran into water
      if (!(st.mine && st.mine.bottom) && Math.floor(bot.entity.position.y) > src.y + 6) { note(`pursue ${goal.name}: waiting for the mine shaft`); G.cool.pursue = Date.now() + 10 * 60000; return false }
      // through the established shaft first (no new surface breach), then deeper from its bottom
      if (st.mine && st.mine.bottom && Math.floor(bot.entity.position.y) > 56) { const e = v(...st.mine.entry), b = v(...st.mine.bottom); await S.goto(new goals.GoalNear(e.x, e.y, e.z, 2), { dig: false, ms: 120000 }); await S.goto(new goals.GoalNear(b.x, b.y, b.z, 2), { dig: false, ms: 150000 }) }
      if (Math.floor(bot.entity.position.y) > src.y + 6) {
        // Walter's taste (2026-11-10): one laddered shaft per area, no staircases. With a laddered shaft the way down to the ore's depth is the shaft
        // itself, extended with ladders from its bottom (the reviewer's HIGH finding: a 30-step stair from y46 to y14 at 07:55)
        const sh = st.mine && st.mine.ladder && M.LD ? M.LD.shafts().find(q => q.id === st.mine.shaft) : null
        if (sh && sh.bottom) {
          const bottom = v(...sh.bottom)
          await M.LD.clearPlug(sh).catch(() => 0)
          if (Math.floor(bot.entity.position.y) > sh.bottom[1] + 1) await M.LD.down(sh).catch(() => false)
          if (S.dist(bottom.offset(0.5, 0, 0.5)) < 4) { const d = await M.LD.dig(bottom, src.y, { into: sh }); note(`pursue: the shaft goes down to y${sh.bottom ? sh.bottom[1] : '?'} for ${next.name} (${d && d.end || 'done'})`) }
          else { note(`pursue ${goal.name}: could not reach the shaft bottom, no stairs`); G.cool.pursue = Date.now() + 10 * 60000; return false }
          if (Math.floor(bot.entity.position.y) > src.y + 6) { G.cool.pursue = Date.now() + 10 * 60000; return false }
        } else { const r = await M.descend(src.y, { maxSteps: 200 }); note(`pursue: down to y${Math.floor(bot.entity.position.y)} for ${next.name} ${JSON.stringify(r)}`) }
      }
      st.pursueDir = ((st.pursueDir || 0) + 1) % 4
      const t = await M.tunnel(st.pursueDir, 48, { targets: src.ore, torchEvery: 6, stop: () => S.freeSlots() <= 4 || S.count('torch') < 4 || bot.food <= 8 || cnt(next.name) >= before + next.n })
      note(`pursue: tunnel ${t.len} for ${next.name}, +${cnt(next.name) - before} (${t.reason})`)
    } else if (src.mob) {
      const e = Object.values(bot.entities).filter(x => x && x.name && src.mob.test(x.name) && x.position.distanceTo(bot.entity.position) < 48).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      if (!e) return false
      await S.kill(e); await S.pickup(8, 4000)
    } else if (src.plant) {
      await S.gather(src.plant, next.n, { radius: 40, ms: 120000, filter: (b) => b.position.y > (st.home ? st.home[1] - 15 : 0) })
      await S.pickup(8, 4000)
    }
    await craftUp(goal.name, goal.n)
    return cnt(next.name) > before
  }
  return step
}
