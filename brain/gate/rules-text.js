// The rules of play as short text, generated from rules.json so there is one place a rule lives (docs/MEMORY-LOOP.md, phase 0).
// A model that plans for the bot reads these lines; the packet gate enforces the same file whatever a plan says. Pure: rules in, lines out.
'use strict'

const HOW = { enforce: 'enforced: the action is dropped', log: 'watched: a violation is recorded', off: 'off' }
const TEXT = {
  noArmor: () => 'No armor. Do not craft, wear or plan for armor (free mob-farm drops and a shield are fine). This flips only when the bots have diamond gear with Mending.',
  minToolTier: (r) => `Use the lowest tool tier that does the job. ${cap(r.floor || 'stone')} is the default; iron pickaxe only for diamond, gold, redstone and emerald, diamond pickaxe only for obsidian.`,
  permit: () => 'No digging or placing unless it is part of an agreed job (mining, the farms, building, lighting, crafting, safety). Torches are always allowed.',
  lavaWalk: () => 'Never move with a lava bucket selected.',
  torchSpacing: (r) => `Torches at least ${Math.max(1, (r.minDistance || 3) - 1)} air blocks apart.`,
  chatRate: (r) => `Chat is short and kind: at most one message per ${Math.round((r.minGapMs || 1000) / 1000) || 1} second, no repeats.`,
}
function cap(s) { s = String(s); return s.charAt(0).toUpperCase() + s.slice(1) }

// -> [{ id, mode, text }]
function rulesList(rulesJson) {
  const out = []
  for (const [id, r] of Object.entries((rulesJson && rulesJson.rules) || {})) {
    if (!r || r.mode === 'off') continue
    const text = TEXT[id] ? TEXT[id](r) : cap(String(r.note || id).split(/(?<=\.)\s/)[0])
    out.push({ id, mode: r.mode || 'log', text })
  }
  return out
}
// -> lines for a prompt or a memory file
function rulesText(rulesJson) { return rulesList(rulesJson).map(r => `- ${r.text} (${r.id}, ${HOW[r.mode] || r.mode})`) }

module.exports = { rulesList, rulesText }
