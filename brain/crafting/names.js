// Item / block name resolution for "craft <item>" and "find <thing>". Pure: takes lists of registry names, no bot access.
//
// The legacy find stripped a trailing "s" from everything, so "find glass" searched for "glas". Here the name is tried exactly
// first, and plural forms are only compared token by token ("glass" stays "glass"; "planks" matches oak_planks).
//
//   resolve(names, 'glass panes')   -> { rank:1, matches:['glass_pane'] }
//   resolve(names, 'planks')        -> { rank:2, matches:['acacia_planks', 'bamboo_planks', ...] }
//   resolve(names, 'galss')         -> { rank:3, matches:['glass'] }            (typo, only when nothing else matches)
//   resolve(names, 'zzz')           -> { rank:null, matches:[] }
//
// rank 0 = exact registry name, 1 = same words (plural/underscore differences), 2 = the words appear inside the name
// ("bed" -> red_bed), 3 = close spelling.

const FILLER = /\b(?:any|some|all|a|an|the|more|of|my|few|couple|nearest|closest|nearby|near me|around here|around)\b/g
const TRAILING = /\b(?:in (?:my |the )?(?:chests?|storage|inventory|bag)|near me|nearby|around(?: here)?|please)\b\s*$/

// Words people say that are not registry names.
const ALIASES = { table: 'crafting_table', 'work bench': 'crafting_table', workbench: 'crafting_table', cobble: 'cobblestone', 'pick axe': 'pickaxe' }

function variants(w) {
  const out = new Set([w])
  if (w.endsWith('ies') && w.length > 4) out.add(w.slice(0, -3) + 'y')
  if (w.endsWith('oes') && w.length > 4) out.add(w.slice(0, -2))
  if (w.endsWith('ves') && w.length > 4) { out.add(w.slice(0, -3) + 'f'); out.add(w.slice(0, -1)) }
  if (w.endsWith('es') && w.length > 3) out.add(w.slice(0, -2))
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 2) out.add(w.slice(0, -1))
  return out
}
// "pickaxes" vs "pickaxe", "torches" vs "torch", "glass" vs "glass" (but never "glass" vs "glas")
const sameWord = (a, b) => a === b || variants(a).has(b) || variants(b).has(a)

// Optimal-string-alignment distance: a swapped neighbour pair ("galss") costs 1.
function lev(a, b) {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  const d = Array.from({ length: m + 1 }, (_, i) => { const r = new Array(n + 1).fill(0); r[0] = i; return r })
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[m][n]
}

// Clean up what Walter typed: "some glass panes" -> ['glass','pane']. Returns the word list.
function words(query) {
  let q = String(query == null ? '' : query).toLowerCase().replace(/[^a-z0-9_\s'-]/g, ' ').replace(/['’]/g, '')
  q = q.replace(TRAILING, ' ').replace(FILLER, ' ').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return q ? q.split(' ') : []
}

// names that contain the given words one after another (and are longer than them)
function insideOf(set, ws) {
  const out = []
  for (const n of set) {
    const t = n.split('_')
    if (t.length <= ws.length) continue
    for (let i = 0; i + ws.length <= t.length; i++) if (ws.every((w, j) => sameWord(t[i + j], w))) { out.push(n); break }
  }
  return out.sort((a, b) => a.length - b.length || (a < b ? -1 : 1))
}

function resolve(names, query, { fuzzy = true } = {}) {
  let ws = words(query)
  if (!ws.length) return { rank: null, matches: [], inside: [] }
  const joined = ws.join('_')
  const set = names instanceof Set ? names : new Set(names)
  if (set.has(joined)) return { rank: 0, matches: [joined], inside: insideOf(set, joined.split('_')) }
  const alias = ALIASES[ws.join(' ')]
  if (alias && set.has(alias)) return { rank: 1, matches: [alias], inside: [] }
  if (alias === 'pickaxe') ws = ['pickaxe']

  const list = [...set]
  const toks = new Map(list.map(n => [n, n.split('_')]))
  const inside = insideOf(set, ws)
  // rank 1: same words in the same order
  const same = list.filter(n => { const t = toks.get(n); return t.length === ws.length && t.every((w, i) => sameWord(w, ws[i])) })
  if (same.length) return { rank: 1, matches: same.sort(), inside }
  if (inside.length) return { rank: 2, matches: inside, inside }
  if (!fuzzy) return { rank: null, matches: [], inside }
  // rank 3: typo. Only for words of 4+ letters; distance budget grows with the length.
  const q = joined
  const budget = q.length <= 5 ? 1 : q.length <= 9 ? 2 : 3
  if (q.length < 4) return { rank: null, matches: [], inside }
  let best = Infinity, hit = []
  for (const n of list) {
    if (Math.abs(n.length - q.length) > budget) continue
    const d = lev(q, n)
    if (d <= budget) { if (d < best) { best = d; hit = [n] } else if (d === best) hit.push(n) }
  }
  return hit.length ? { rank: 3, matches: hit.sort(), inside } : { rank: null, matches: [], inside }
}

const pretty = (name) => String(name).replace(/_/g, ' ')

// Splits "3 torches" / "torches 3" / "x16 glass pane" / "glass pane x 16" / "a stack of sticks" into { count, what }.
const STACKS = /\b(?:a|one|1) stack of\b/
function parseCount(text, max = 2304) {
  let t = String(text || '').trim()
  let count = null
  let m
  if (STACKS.test(t)) { count = 64; t = t.replace(STACKS, ' ') }
  else if ((m = /^(?:x\s*)?(\d{1,4})\s*(?:x\s+|of\s+)?(.+)$/.exec(t))) { count = Number(m[1]); t = m[2] }
  else if ((m = /^(.+?)\s+(?:x\s*)?(\d{1,4})$/.exec(t))) { count = Number(m[2]); t = m[1] }
  else if ((m = /^(.+?)\s+(?:x\s*)?(\d{1,4})\s+(?:please|pls)$/.exec(t))) { count = Number(m[2]); t = m[1] }
  return { count: count == null ? 1 : Math.max(1, Math.min(max, count)), explicit: count != null, what: t.replace(/\s+/g, ' ').trim() }
}

module.exports = { resolve, words, parseCount, pretty, sameWord, variants, lev }
