// brain/autopilot/reflect.js: the bot's own failure-pattern statistics and its persistent strategy (Walter 2026-11-02: "exercise more abstract thinking").
// No item rules live here. Two generic things:
//   patterns(): facts about the bot's own history (how it died, what it was missing when it died, how often it stalled, which progress it never reached).
//   strategy:   a short persistent text of standing policies the planner reads on every step and rewrites itself (revise_strategy) when a pattern repeats.
// The planner (think.js) turns patterns into capabilities and processes; this file only keeps the evidence and the memory.
const fs = require('fs')
const path = require('path')

module.exports = function makeReflect(api) {
  const state = (f) => api.statePath(f)
  const stratFile = state('strategy.md'), histFile = state('strategy-history.jsonl')
  const read = (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

  function deaths(n = 25) {
    const out = []
    for (const line of read(state('safety.log')).split('\n')) {
      const m = /DIED \(OzoGo444 (.*?)\) at (-?\d+),(-?\d+),(-?\d+),( underground,)? light (\d+)\..*?Doing: (.*?)\s*\(.*?Had: (no sword|sword), (\d+) torches, (\d+) filler blocks, (\d+) food, armor (\d+)\/4/.exec(line)
      if (m) out.push({ cause: m[1].replace(/^(was )?(slain|shot|blown up|killed) by /, '$2 by ').replace(/^was /, ''), y: +m[4], under: !!m[5], light: +m[6], doing: m[7].trim(), sword: m[8] === 'sword', torches: +m[9], filler: +m[10], food: +m[11], armor: +m[12] })
    }
    return out.slice(-n)
  }
  const pct = (a, f) => a.length ? Math.round(100 * a.filter(f).length / a.length) : 0

  function patterns() {
    const d = deaths(), lines = []
    if (!d.length) lines.push('no deaths recorded yet')
    else {
      const causes = {}
      for (const x of d) causes[x.cause] = (causes[x.cause] || 0) + 1
      lines.push(`last ${d.length} deaths by cause: ` + Object.entries(causes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} x${v}`).join(', '))
      lines.push(`at death: no sword ${pct(d, x => !x.sword)}%, 0 torches ${pct(d, x => x.torches === 0)}%, 0 filler blocks ${pct(d, x => x.filler === 0)}%, 0 food ${pct(d, x => x.food === 0)}%, no armor ${pct(d, x => x.armor === 0)}%, no shield n/a (not recorded: check inventory yourself)`)
      lines.push(`where: underground ${pct(d, x => x.under)}%, in darkness (light 0-4) ${pct(d, x => x.light <= 4)}%; doing when it happened: ` + Object.entries(d.reduce((a, x) => { const k = x.doing.split(' ')[0] || '?'; a[k] = (a[k] || 0) + 1; return a }, {})).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} x${v}`).join(', '))
    }
    const stalls = (read(state('lessons.md')).match(/STALL A\d+: [^\s]+/g) || []).slice(-30)
    if (stalls.length) { const c = {}; for (const s of stalls) { const k = s.replace(/STALL A\d+: /, ''); c[k] = (c[k] || 0) + 1 } lines.push('recent stalls: ' + Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} x${v}`).join(', ')) }
    try {
      const s = JSON.parse(read(state('survival-summary.json')) || '{}'), lv = (s.lives || []).slice(-40)
      if (lv.length) {
        const reached = {}; for (const l of lv) for (const k of Object.keys(l.milestones || {})) reached[k] = (reached[k] || 0) + 1
        const all = ['log', 'crafting_table', 'wooden_pickaxe', 'cobblestone', 'stone_pickaxe', 'stone_sword', 'furnace', 'food', 'coal', 'torch', 'bed', 'iron_ingot', 'iron_pickaxe', 'armor', 'shield']
        lines.push(`progress over last ${lv.length} lives (lives that reached it): ` + all.map(k => `${k} ${reached[k] || 0}`).join(', '))
        const t = lv.filter(l => l.survivedTicks).map(l => l.survivedTicks).sort((a, b) => a - b)
        if (t.length) lines.push(`survival ticks: median ${t[Math.floor(t.length / 2)]}, best ${t[t.length - 1]} (24000 = one day)`)
      }
    } catch {}
    return lines.join('\n').slice(0, 1500)
  }

  const SEED = [
    '# STRATEGY (standing policies; rewrite with revise_strategy when evidence says so)',
    'Each policy: WHY (evidence) | PROCESS (repeatable, durable) | CHECK (how I will know it works).',
    '1. Vision: most deaths happen where it is dark. | Carry torches as a staple (make charcoal/coal into torches whenever below a stack); light the work area, the way in and the shelter before working; prefer to work in lit places. | CHECK: deaths in darkness < 20%.',
    '2. Armed before afield: deaths with no sword/armor/shield are avoidable. | After every respawn and before any trip, first rebuild the basic kit (stone sword, shield, armor when affordable) at the base; do not walk to the death spot unarmed. | CHECK: no sword at death < 10%.',
    '3. Renewable supply: wood and charcoal must not depend on luck. | Keep a planted, lit grove of saplings at the base and replant every tree I fell; smelt spare logs into charcoal. | CHECK: logs obtainable without searching.',
    '4. Sustenance: running out of food shortens every trip. | Keep a stock of cooked food and a food source (animals penned or crops) near the base. | CHECK: 0 food at death < 20%.',
    '5. Learn: when a death cause repeats, spend the next calm minutes on infrastructure that removes the cause instead of repeating the attempt.'
  ].join('\n')
  const strategy = () => { const t = read(stratFile).trim(); return t || SEED }
  function revise(text, why) {
    const t = String(text || '').trim().slice(0, 2400)
    if (t.length < 40) return false
    try { fs.appendFileSync(histFile, JSON.stringify({ t: new Date().toISOString(), why: String(why || '').slice(0, 200), prev: strategy().slice(0, 2400) }) + '\n') } catch {}
    fs.writeFileSync(stratFile, t + '\n')
    return true
  }
  if (!read(stratFile).trim()) { try { fs.writeFileSync(stratFile, SEED + '\n') } catch {} }
  return { patterns, strategy, revise, deaths }
}
