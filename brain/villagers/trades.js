// Trade logic, pure (no bot calls): describe a mineflayer trade, parse enchantments, resolve what Walter asked for ("mending", "diamond
// pickaxe", "arrows"), and decide what is worth buying or selling under the price caps and the emerald budget.
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 }

// ---------- enchantments ----------
function normEnch(x, out = []) {
  if (!x) return out
  if (Array.isArray(x)) { for (const e of x) { if (e && (e.name || e.id)) out.push({ name: String(e.name || e.id).replace('minecraft:', ''), lvl: e.lvl ?? e.level ?? 1 }); else normEnch(e, out) } return out }
  if (typeof x === 'object') {
    if (x.enchantments || x.levels || x.stored_enchantments) return normEnch(x.enchantments || x.levels || x.stored_enchantments, out)
    for (const [k, v] of Object.entries(x)) if (Number.isFinite(v)) out.push({ name: k.replace('minecraft:', ''), lvl: v })
  }
  return out
}
function enchantsOf(item) {
  if (!item) return []
  const tries = [
    () => item.componentMap && item.componentMap.get && item.componentMap.get('stored_enchantments') && item.componentMap.get('stored_enchantments').data,
    () => Array.isArray(item.components) && (item.components.find((c) => c && (c.type === 'stored_enchantments' || c.type === 'minecraft:stored_enchantments')) || {}).data,
    () => item.storedEnchants,
    () => item.enchants
  ]
  for (const t of tries) { let r = []; try { r = normEnch(t()) } catch { r = [] } if (r.length) return r }
  return []
}

// ---------- describing a trade ----------
const slotOf = (s) => (s && s.name && s.count ? { name: s.name, count: s.count } : null)
function describeTrade(trade, index) {
  const in1 = slotOf(trade.inputItem1 && { ...trade.inputItem1, count: trade.realPrice ?? trade.inputItem1.count })
  const in2 = trade.hasItem2 ? slotOf(trade.inputItem2) : null
  const o = trade.outputItem
  const out = o ? { name: o.name, count: o.count, enchants: enchantsOf(o) } : null
  const max = trade.maximumNbTradeUses ?? 0, used = trade.nbTradeUses ?? 0
  return { index, in1, in2, out, uses: used, max, left: trade.tradeDisabled ? 0 : Math.max(0, max - used), disabled: !!trade.tradeDisabled || max - used <= 0 }
}
const emeraldCost = (d) => (d.in1 && d.in1.name === 'emerald' ? d.in1.count : 0) + (d.in2 && d.in2.name === 'emerald' ? d.in2.count : 0)

function label(d) {
  if (!d.out) return 'unknown'
  if (d.out.name === 'enchanted_book' && d.out.enchants && d.out.enchants.length) {
    return d.out.enchants.map((x) => `${x.name.replace(/_/g, ' ')}${x.lvl > 1 ? ' ' + x.lvl : ''}`).join(' + ') + ' book'
  }
  return `${d.out.count > 1 ? d.out.count + ' ' : ''}${d.out.name.replace(/_/g, ' ')}`
}
const price = (d) => [d.in1, d.in2].filter(Boolean)
  .map((s) => `${s.count} ${s.name.replace(/_/g, ' ')}${s.name === 'emerald' && s.count > 1 ? 's' : ''}`).join(' + ')

// ---------- what was asked for ----------
const STOP = /\b(a|an|the|some|any|me|book|books|enchanted|enchantment|enchant|of|level|lvl|from|villager|librarian|please)\b/g
function parseLevel(q) {
  let lvl = null
  q = q.replace(/\b(\d)\b/, (_, n) => { lvl = Number(n); return ' ' })
  q = q.replace(/\b(iv|iii|ii|i|v)\b/, (m) => { lvl = ROMAN[m]; return ' ' })
  return { q: q.replace(/\s+/g, ' ').trim(), lvl }
}
const singular = (w) => w.replace(/ies$/, 'y').replace(/(?<!s)s$/, '')

// Returns { label, kind, match(desc), maxEmeralds, minLevel, wishName } or null when the words match nothing known.
function resolveWant(text, config, registry) {
  const raw = String(text || '').toLowerCase().replace(/[^a-z0-9\s_]/g, ' ')
  const { q, lvl } = parseLevel(raw.replace(STOP, ' '))
  if (!q) return null
  const wl = config.wishlist || []
  const cap = (entry) => (entry && entry.maxEmeralds) || config.budget.adHocMaxEmeralds
  const words = q.replace(/\s+/g, '_')
  // 1. an enchantment (book): exact registry name, a wishlist alias, or a display name
  const ench = (registry.enchantmentsByName && (registry.enchantmentsByName[words] || registry.enchantmentsByName[singular(words)])) ? words : null
  const wishEnch = wl.find((w) => w.kind === 'book' && (w.name.replace(/ /g, '_') === words || w.enchant === words))
  const enchName = ench || (wishEnch && wishEnch.enchant)
  if (enchName) {
    const entry = wl.find((w) => w.kind === 'book' && w.enchant === enchName)
    const minLevel = lvl || (entry && entry.minLevel) || 1
    return { label: `${enchName.replace(/_/g, ' ')}${minLevel > 1 ? ' ' + minLevel : ''} book`, kind: 'book', minLevel, maxEmeralds: cap(entry), wishName: entry && entry.name,
      match: (d) => !!d.out && d.out.name === 'enchanted_book' && d.out.enchants.some((e) => e.name === enchName && e.lvl >= minLevel) }
  }
  // 2. any item by registry name ("diamond pickaxe", "arrows", "bell")
  const itemName = [words, singular(words)].find((n) => registry.itemsByName && registry.itemsByName[n])
  if (itemName) {
    const entry = wl.find((w) => w.kind === 'item' && w.item === itemName)
    return { label: itemName.replace(/_/g, ' '), kind: 'item', minLevel: 1, maxEmeralds: cap(entry), wishName: entry && entry.name,
      match: (d) => !!d.out && d.out.name === itemName }
  }
  // 3. "diamond gear" / "diamond tools" / "diamond armor"
  const gear = /^diamond_(gear|tools?|armou?r)$/.exec(words)
  if (gear) {
    const set = gear[1].startsWith('tool') ? /^diamond_(pickaxe|axe|shovel|sword|hoe)$/ : gear[1].startsWith('arm') ? /^diamond_(helmet|chestplate|leggings|boots)$/ : /^diamond_(pickaxe|axe|shovel|sword|helmet|chestplate|leggings|boots)$/
    return { label: `diamond ${gear[1]}`, kind: 'item', minLevel: 1, maxEmeralds: config.budget.adHocMaxEmeralds, wishName: null, match: (d) => !!d.out && set.test(d.out.name) }
  }
  return null
}

// ---------- buying ----------
const wishWant = (config, registry) => (config.wishlist || []).map((w) => resolveWant(w.name, config, registry)).filter(Boolean)

// inv: { itemName: count }. Returns { ok, why, times, emeralds } for buying `desc` against `want`, with `budgetLeft` emeralds free to spend.
function evaluateBuy(desc, want, inv, budgetLeft, { times = 1 } = {}) {
  if (!want.match(desc)) return { ok: false, why: 'not what we want' }
  if (desc.disabled) return { ok: false, why: 'sold out for now' }
  const cost = emeraldCost(desc)
  if (!cost) return { ok: false, why: 'not an emerald trade' }
  if (cost > want.maxEmeralds) return { ok: false, why: `${cost} emeralds is over my limit of ${want.maxEmeralds}` }
  const n = Math.max(1, Math.min(times, desc.left))
  for (const s of [desc.in1, desc.in2].filter(Boolean)) {
    if ((inv[s.name] || 0) < s.count) return { ok: false, why: `I need ${s.count} ${s.name.replace(/_/g, ' ')} and have ${inv[s.name] || 0}`, short: s.name }
  }
  if (cost > budgetLeft) return { ok: false, why: `${cost} emeralds is over what is left of this trip's budget (${budgetLeft})`, over: true }
  let k = n
  for (const s of [desc.in1, desc.in2].filter(Boolean)) k = Math.min(k, Math.floor((inv[s.name] || 0) / s.count))
  k = Math.min(k, Math.floor(budgetLeft / cost)) || 1
  return { ok: true, times: k, emeralds: cost * k }
}

// ---------- selling ----------
// A trade where the villager pays emeralds for one thing we have a surplus of. Returns { ok, times, gets } or { ok:false }.
function evaluateSell(desc, inv, sellCfg) {
  if (!desc.out || desc.out.name !== 'emerald' || !desc.in1 || desc.in2 || desc.disabled) return { ok: false }
  if (!sellCfg.items.includes(desc.in1.name)) return { ok: false }
  const spare = (inv[desc.in1.name] || 0) - (sellCfg.keep[desc.in1.name] || 0)
  const times = Math.min(Math.floor(spare / desc.in1.count), desc.left)
  return times > 0 ? { ok: true, times, gets: times * desc.out.count } : { ok: false }
}

module.exports = { enchantsOf, describeTrade, emeraldCost, label, price, resolveWant, wishWant, evaluateBuy, evaluateSell }
