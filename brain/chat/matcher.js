// Local fuzzy intent matcher for Walter's in-game chat. No network, no model, no bot access: everything it needs from the world
// (waypoint names, block/item names, registered commands, clock) is injected, so it runs and tests offline.
//
//   const m = create({ getWaypoints, getBlockNames, getItemNames, getCommands, getPosition, now })
//   m.parse(user, text)   -> null | { intent, canonical, risk, score, level, slots, alts, instant, info }   (reads memory only)
//   m.decide(user, text)  -> { type:'run', canonical, result }      dispatch `canonical` now
//                          | { type:'ask', question, result }       say `question`, wait for yes/no
//                          | { type:'say', text }                   say `text` (answer to a yes/no, or "which one?")
//                          | { type:'none', best }                  not for us (best = closest guess, for the near-miss log)
//   m.resolvePending(user, text)  answer to our own question, or null
//   m.remember(user, canonical)   after a successful dispatch (feeds "do that again" / "go there")
//
// canonical strings are what the brain command table / legacy handleCommand already understand ("follow me", "go to 10 64 -3").

const T = require('./text')
const { INTENTS } = require('./intents')

const MOTION = new Set('go goto walk run head travel come meet get take bring move navigate teleport tp return back visit fly swing'.split(' '))
const NEG_TOKENS = new Set(['dont', 'not', 'never', 'no', 'without', 'cant', 'wont'])
const CONFIRM_TTL_MS = 30000
const YES = new Set('yes y yeah yep yup ya sure ok okay correct right do it go ahead please affirmative aye yea yessir si thats exactly'.split(' '))
const NO = new Set('no n nope nah nay cancel dont never mind nevermind wrong not that'.split(' '))
const ORDINALS = { first: 0, '1': 0, '1st': 0, one: 0, second: 1, '2': 1, '2nd': 1, two: 1, third: 2, '3': 2, '3rd': 2, three: 2, nearest: 0, closest: 0, last: -1 }
// "go home" -> House. Only used when the alias target exists as a waypoint.
const PLACE_ALIASES = { home: ['house', 'home'], base: ['the first base'], 'my house': ['house'], 'the house': ['house'] }
// Phrases dropped before matching ("go ahead and", "for a second", "if you could"...).
const DROP = [
  /\bgo ahead(?: and)?\b/g,
  /\bfor (?:a|one|just a) (?:sec|second|moment|minute|min|bit|while|little)\b/g,
  /\b(?:if|when) (?:you|u) (?:could|can|would|get a chance)\b/g,
  /\b(?:as soon as possible|right now|right away|real quick|if possible|thank you|thanks|for me|when you can|i guess|or something|by the way|btw)\b/g,
  /\b(?:i|we) (?:would|d) like (?:you )?to\b/g,
  /\b(?:i|we) (?:need|want) you to\b/g,
  /\bwould you mind\b/g
]
// Politeness / mood lead-ins, removed so the first real word tells whether the line is an order ("can you please go to the farm").
const LEAD = /^(?:(?:can|could|would|will) (?:you|u)|please|pls|plz|tell me|let me know|i wonder|just|lets|let us|we should|we can|we could|we need to|time to|you should|you can|you may|you could|now|then)\s+/
const singular = (w) => /ies$/.test(w) ? w.replace(/ies$/, 'y') : /(?:ses|xes|ches|shes|oes)$/.test(w) ? w.slice(0, -2) : w.replace(/s$/, '')
const INFO_LEAD = new Set('show list tell give check display print say what which whats please'.split(' '))
const BSb = String.fromCharCode(92) + 'b'
const risk0 = (it) => it.risk
const NOUN_JUNK = /^(?:me|you|it|yourself|there|here|that|this|them|one|something|anything|someone|him|her|us|out|up|again|now|nearby|around)$/

function compile(list) {
  const vocab = new Set()
  const intents = list.map(it => ({
    ...it,
    compiled: it.phrases.map(ph => {
      const toks = []
      let neg = false
      for (const raw of ph.split(/\s+/)) {
        const key = raw.startsWith('*'); const w = raw.replace('*', '')
        if (NEG_TOKENS.has(w)) neg = true
        if (T.STOP.has(w)) continue
        toks.push({ w, key }); vocab.add(w)
      }
      return { toks, neg }
    })
  }))
  return { intents, vocab, words: [...vocab] }
}

function create(opts = {}) {
  const getWaypoints = opts.getWaypoints || (() => [])
  const getBlockNames = opts.getBlockNames || (() => [])
  const getItemNames = opts.getItemNames || (() => [])
  const getCommands = opts.getCommands || null
  const getPosition = opts.getPosition || (() => null)
  const now = opts.now || Date.now
  const memory = new Map()    // user -> { last, lastRisk, target, lastAt }
  const pending = new Map()   // user -> { kind:'confirm'|'choice', canonical?, options?, expires }
  const stats = { parsed: 0, run: 0, asked: 0, none: 0 }

  // ---- compiled tables (rebuilt only when the registered command set changes) ----
  let sig = null, C = null
  function table() {
    let cmds = null
    try { cmds = getCommands ? getCommands() : null } catch { cmds = null }
    const s = cmds ? cmds.map(c => `${c.name}:${(c.canonical || []).join('|')}`).sort().join(';') : '-'
    if (C && s === sig) return C
    sig = s
    let list = INTENTS
    if (cmds) {
      const have = new Set(); for (const c of cmds) for (const k of (c.canonical || [])) have.add(String(k).toLowerCase())
      // brain-native intents are only offered when the command really exists
      list = INTENTS.filter(it => !it.brain || have.has(it.canonical.toLowerCase()))
      // commands registered by other modules become intents too (help: "canonical | alt phrase | alt phrase")
      const known = new Set(INTENTS.map(i => i.canonical.toLowerCase()))
      for (const c of cmds) {
        const alts = [...new Set([...(c.canonical || []), ...String(c.help || '').split('|')].map(x => String(x).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean))]
        const canon = (c.canonical && c.canonical[0]) || alts[0]
        if (!canon || known.has(String(canon).toLowerCase()) || !alts.length) continue
        if (/[<\[]/.test(String(c.help || '')) || /[<\[]/.test(String(canon))) continue   // "craft <item> [count]", "find <item>": handled by slot rules below
        list = list.concat([{ id: 'cmd:' + c.name, canonical: canon, risk: c.risk === 'high' ? 'high' : 'low', phrases: alts.slice(0, 12), dynamic: true }])
      }
    }
    C = compile(list)
    // slot-rule commands registered by brain/crafting: offered when the command list says so (or when there is no list, e.g. unit tests)
    const reg = (name, re) => !cmds || cmds.some(c => c.name === name || (c.canonical || []).some(k => re.test(String(k))))
    C.craftItem = reg('craft-item', /^craft\s*[<\[]/i)
    C.findItem = reg('find-item', /^find\s*[<\[]/i)
    return C
  }

  // ---- token repair: slang table, typo repair against the phrase vocabulary, glued words ("followme") ----
  let fuzzyCount = 0   // typo repairs / glued-word splits in the last repair(): exact phrases may run a risky job, fuzzy ones are confirmed
  function repair(tokens, vocab, vwords) {
    const out = []
    fuzzyCount = 0
    for (const t of tokens) {
      if (t in T.FIX) { out.push(...T.FIX[t].split(' ').filter(Boolean)); continue }
      if (vocab.has(t) || T.STOP.has(t) || /^-?\d/.test(t) || t.length <= 3) { out.push(t); continue }
      const lim = T.typoBudget(t.length)
      let best = null, bd = Infinity
      for (const w of vwords) {
        if (w[0] !== t[0] || Math.abs(w.length - t.length) > lim || w.startsWith(t) || t.startsWith(w)) continue   // "sleepy" is not a typo of "sleep"
        const d = T.dl(t, w)
        if (d <= lim && d < bd) { bd = d; best = w }
      }
      if (best) { fuzzyCount++; out.push(best); continue }
      let split = null
      if (t.length >= 6) for (let i = 3; i <= t.length - 3 && !split; i++) if (vocab.has(t.slice(0, i)) && vocab.has(t.slice(i))) split = [t.slice(0, i), t.slice(i)]
      if (split) fuzzyCount++
      out.push(...(split || [t]))
    }
    return out.filter(t => t !== '' && !T.STOP.has(t))
  }
  const tokEq = (u, p) => u === p || T.stem(u) === T.stem(p) || (u.length >= 5 && p.length >= 5 && u[0] === p[0] && !u.startsWith(p) && !p.startsWith(u) && T.dl(u, p) <= T.typoBudget(Math.min(u.length, p.length)))

  function scorePhrase(U, P, soft, info) {
    let total = 0, got = 0, keyMiss = false, soundalike = 0
    const used = new Set()
    for (const p of P.toks) {
      const w = p.key ? 3 : 1; total += w
      const i = U.findIndex((u, k) => !used.has(k) && tokEq(u, p.w))
      if (i >= 0) { used.add(i); got += w; if (U[i] !== p.w) soundalike++ } else if (p.key) keyMiss = true
    }
    if (keyMiss || !got) return { s: 0 }
    const missing = P.toks.length - used.size
    // question/report lead words ("what is your health", "list waypoints") are free for read-only intents
    const extra = U.filter((u, k) => !used.has(k) && !(info && INFO_LEAD.has(u))).length
    // Words the phrase does not explain cost a lot: "this is the room we need to excavate the ceiling from" must not read as "excavate".
    // Stop/stay-style intents (soft) are forgiving: "stop doing that" is still a stop.
    let sc = (got / total) * (1 - Math.min(soft ? 0.5 : 0.84, (soft ? 0.15 : 0.28) * extra)) * (1 - 0.12 * missing)   // phrase words the user did not say cost a little
    if (!soft && P.toks.length <= 1 && extra >= 1) sc *= 0.75   // a lone keyword plus other words ("good job", "time flies") is chatter
    return { s: sc, extra, fuzzy: soundalike }
  }

  // ---- places (waypoints) ----
  const placeNorm = (s) => String(s).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(?:the|my|our|a|an)\s+/, '').trim()
  function waypointList() {
    let raw = []
    try { raw = getWaypoints() || [] } catch { raw = [] }
    if (!Array.isArray(raw)) raw = Object.entries(raw).map(([name, v]) => ({ name, ...v }))
    return raw.map(w => typeof w === 'string' ? { name: w } : w).filter(w => w && w.name).map(w => ({ ...w, key: placeNorm(w.name), toks: placeNorm(w.name).split(' ').filter(Boolean) }))
  }
  function matchPlaces(query) {
    const q = placeNorm(query)
    if (!q || q.length < 2) return []
    const qt = q.split(' ').filter(w => !T.STOP.has(w))
    if (!qt.length) return []
    const out = []
    const aliasKeys = (PLACE_ALIASES[q] || []).map(placeNorm)
    for (const w of waypointList()) {
      let s = 0
      if (w.key === q) s = 1
      else if (aliasKeys.includes(w.key)) s = 0.95
      else {
        s = T.sim(q, w.key)
        const used = new Set(); let ok = true
        for (const u of qt) { const i = w.toks.findIndex((p, k) => !used.has(k) && tokEq(u, p)); if (i < 0) { ok = false; break } used.add(i) }
        if (ok) s = Math.max(s, used.size === w.toks.length ? 0.9 : 0.62 + 0.2 * (used.size / w.toks.length))
      }
      if (s >= 0.62) out.push({ w, score: s })
    }
    out.sort((a, b) => b.score - a.score)
    return out
  }
  // The legacy handleCommand can only look up names made of [a-z0-9 -] without a leading "the"; everything else is sent as coordinates.
  const legacyName = (n) => /^[a-z0-9][a-z0-9 -]*$/.test(n) && !/^the /.test(n)
  function placeCanonical(w) {
    const lower = w.name.toLowerCase()
    if (legacyName(lower)) return `go to ${lower}`
    if (w.x != null && w.z != null) return w.y != null ? `go to ${Math.round(w.x)} ${Math.round(w.y)} ${Math.round(w.z)}` : `go to ${Math.round(w.x)} ${Math.round(w.z)}`
    return `go to ${lower}`
  }
  const dist2 = (w, p) => p && w.x != null ? (w.x - p.x) ** 2 + (w.z - p.z) ** 2 : 0

  // ---- block / item names ----
  function matchBlock(query) {
    const q = query.toLowerCase().replace(/\b(?:any|some|all|a|an|the|nearby|near|closest|nearest|more|of|my|few|couple)\b/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!q || NOUN_JUNK.test(q)) return null
    const base = q.replace(/\s+/g, '_')
    const sing = singular(base)
    let names = []
    try { names = getBlockNames() || [] } catch { names = [] }
    if (!names.length) return null   // cannot validate without the registry
    const set = new Set(names)
    for (const b of [base, sing]) {
      if (set.has(b)) return { name: b, score: 1 }
      if (set.has(b + '_ore')) return { name: b + '_ore', score: 0.95 }
    }
    const partial = names.filter(n => n.endsWith('_' + sing) || n.startsWith(sing + '_') || n.includes('_' + sing + '_')).sort((a, b) => a.length - b.length)
    if (partial.length) return { name: partial.length > 1 ? sing : partial[0], score: 0.85 }   // several matches (red_bed, black_bed...): the legacy find command accepts the partial name
    let best = null, bs = 0
    for (const n of names) { const s = Math.max(T.sim(sing, n), T.sim(base, n)); if (s > bs) { bs = s; best = n } }
    return best && bs >= 0.78 ? { name: best, score: bs } : null
  }
  function matchItem(query) {
    const q = query.toLowerCase().replace(/\b(?:any|some|all|a|an|the|more|of|my|few|couple)\b/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!q || NOUN_JUNK.test(q)) return null
    let names = []
    try { names = [...(getItemNames() || []), ...(getBlockNames() || [])] } catch { names = [] }
    const base = q.replace(/\s+/g, '_'), sing = singular(base)
    for (const b of [base, sing]) if (names.includes(b)) return { name: b, score: 1 }
    const partial = names.filter(n => n.endsWith('_' + sing) || n.includes('_' + sing + '_') || n.startsWith(sing + '_')).sort((a, b) => a.length - b.length)
    if (partial.length) return { name: partial.length > 1 ? sing : partial[0], score: 0.85, family: partial.length > 1 }
    if (/^(?:food|tools?|stuff|items?|blocks?|anything|everything)$/.test(q)) return { name: q, score: 0.8, generic: true }
    return null
  }

  // ---- crafting: item and count slots ----
  const CRAFT_RE = /^(?:craft|make|create)\s+(?:(?:me|us|yourself|ourselves)\s+)?(.+?)\s*(?:please|pls)?\s*[.!?]*$/
  const TOOLSET_RE = /^(?:(?:a|the|my|basic|stone|wooden|full|new|some)\s+)*(?:tool ?sets?|tool ?kits?|tools)$/
  const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, couple: 2, few: 3 }
  function craftTarget(q) {
    let names = []
    try { names = getItemNames() || [] } catch { names = [] }
    if (!names.length) return null
    const base = q.replace(/\s+/g, '_'), sing = singular(base)
    const set = new Set(names)
    for (const b of [base, sing]) if (set.has(b)) return { name: b }
    for (const x of [base, sing]) {
      const fam = names.filter(n => n.endsWith('_' + x) || n.startsWith(x + '_'))
      if (fam.length > 1) return { name: x, family: true }   // "planks", "pickaxe": brain/crafting asks which one
      if (fam.length === 1) return { name: fam[0], fuzzy: true }   // one partial hit ("item" -> item_frame): confirm
    }
    if (sing.length >= 4) {
      let best = null, bs = 0
      for (const n of names) { if (n[0] !== sing[0]) continue; const s = Math.max(T.sim(sing, n), T.sim(base, n)); if (s > bs) { bs = s; best = n } }
      if (best && bs >= 0.82) return { name: best, fuzzy: true }
    }
    return null
  }
  function parseCraft(c2) {
    const m = CRAFT_RE.exec(c2)
    if (!m) return null
    let rest = m[1].replace(/^(?:yourself|me)\s+/, '')
    if (TOOLSET_RE.test(rest)) return null   // the legacy tool-set job has its own intent
    let count = 1, explicit = false, k
    if ((k = /\b(?:a|one|1) stack of\b/.exec(rest))) { count = 64; explicit = true; rest = rest.replace(k[0], ' ') }
    else if ((k = /^(?:x\s*)?(\d{1,4})\s*(?:x\s+|of\s+)?(.+)$/.exec(rest))) { count = Number(k[1]); explicit = true; rest = k[2] }
    else if ((k = /^(.+?)\s+(?:x\s*)?(\d{1,4})$/.exec(rest))) { count = Number(k[2]); explicit = true; rest = k[1] }
    else if ((k = /^(?:a\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|couple|few)\s+(?:of\s+)?(.+)$/.exec(rest))) { count = COUNT_WORDS[k[1]]; explicit = true; rest = k[2] }
    if (!(count >= 1) || count > 2304) return null
    rest = rest.replace(/\b(?:some|a|an|the|more|another|extra|bunch of|lots of|of)\b/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!rest || NOUN_JUNK.test(rest) || rest.split(' ').length > 4) return null
    const item = craftTarget(rest)
    return item ? { item, count, explicit } : null
  }

  // ---- coordinates ----
  const num =(s) => Math.floor(Number(s))
  function coordsOf(c) {
    let m = /\bx\s*[:=]?\s*(-?\d+(?:\.\d+)?)[\s,;/]+(?:y\s*[:=]?\s*(-?\d+(?:\.\d+)?)[\s,;/]+)?z\s*[:=]?\s*(-?\d+(?:\.\d+)?)/.exec(c)
    if (m) return { nums: m[2] != null ? [num(m[1]), num(m[2]), num(m[3])] : [num(m[1]), num(m[3])], labelled: true }
    m = /(?:^|[\s(\[])(-?\d+(?:\.\d+)?)\s*(?:,\s*|\s+|\/)\s*(-?\d+(?:\.\d+)?)(?:\s*(?:,\s*|\s+|\/)\s*(-?\d+(?:\.\d+)?))?(?=$|[\s)\].,!?;])/.exec(c)
    if (!m) return null
    const nums = m[3] != null ? [num(m[1]), num(m[2]), num(m[3])] : [num(m[1]), num(m[2])]
    if (nums.length === 3 && (nums[1] < -64 || nums[1] > 400)) return null
    if (nums.some(n => !Number.isFinite(n) || Math.abs(n) > 30000000)) return null
    const bare = c.replace(m[0], ' ').replace(/[^a-z]+/g, ' ').trim()
    return { nums, labelled: false, bare: !bare || /^(?:coordinates|coords|at|to|position)$/.test(bare) }
  }

  // ---- parse ----
  // Walter often states context first and asks last ("... can you come meet me at the farm?"), so a multi-sentence line is judged
  // sentence by sentence. Exactly one confident sentence wins (a stop wins over anything); two different ones means "not sure".
  const confident = (r) => r && !r._miss && (r.score >= 0.8 || (r.instant && r.score >= 0.55 && (r.slots.ntok || 0) <= 6))
  function parse(user, text) {
    const raw = String(text == null ? '' : text)
    if (!raw.trim() || raw.length > 400) return null
    const sentences = raw.split(/(?<=[.!?])\s+(?=[A-Za-z@"'(])/).map(x => x.trim()).filter(Boolean)
    if (sentences.length < 2) return parseOne(user, raw)
    const rs = sentences.map(sn => parseOne(user, sn)).filter(r => confident(r) && !r.solo)
    const stay = rs.find(r => r.intent === 'stay')
    if (stay) return stay
    const kinds = new Set(rs.map(r => r.canonical))
    if (kinds.size === 1) return rs[0]
    return kinds.size ? { _miss: true, best: { intent: rs[0].intent, score: 0.4 } } : parseOne(user, raw)
  }

  function parseOne(user, raw) {
    if (!raw.trim() || raw.length > 400) return null
    if (/^\s*\//.test(raw)) return null   // never treat slash commands as chat
    if (/^(?:hi|hello|hey|yo|sup|hiya|howdy|greetings)(?: (?:there|bot|ozogo444|ozogo|claude|buddy|friend|everyone))?[!. ]*$/.test(T.clean(raw))) return { intent: 'hello', canonical: 'hi', risk: 'low', score: 0.9, level: 'high', slots: {}, alts: [], instant: false, info: true, solo: true }
    let c = T.stripAddress(T.clean(raw))
    for (const re of DROP) c = c.replace(re, ' ')
    c = c.replace(/\s+/g, ' ').trim()
    if (!c || c.length > 260) return null
    const tab = table()
    const mem = memory.get(user) || {}
    const cw = T.words(c)
    let c2 = c; for (let i = 0; i < 4; i++) c2 = c2.replace(LEAD, '')
    const cw2 = T.words(c2)
    const hasMotion = !!cw2.length && (MOTION.has(cw2[0]) || (cw2[0] === 'meet' && cw2[1] === 'me') || ((cw2[0] === 'take' || cw2[0] === 'bring') && cw2[1] === 'me'))
    const negRaw = cw.some(w => NEG_TOKENS.has(w))
    const mk = (intent, canonical, risk, score, extra = {}) => ({ intent, canonical, risk, score: +Math.min(1, score).toFixed(2), level: score >= 0.8 ? 'high' : 'medium', slots: {}, alts: [], instant: false, info: false, ...extra })

    // 1. coordinates
    const co = coordsOf(c2)
    if (co && !negRaw && (hasMotion || co.labelled || co.bare) && !/\b(?:follow|stay|stop|wait)\b/.test(c)) {
      const sc = hasMotion || co.labelled ? 0.95 : 0.7   // bare "100 64 200" is confirmed first
      return mk('goto-coords', `go to ${co.nums.join(' ')}`, 'low', sc, { slots: { coords: co.nums } })
    }

    // 2. save a waypoint
    const sv = /\b(?:remember|save|mark|bookmark|set|add|name)\b.*?\b(?:as|called|named)\s+["']?([a-z0-9][a-z0-9 -]{0,28}?)["']?\s*[.!?]*$/.exec(c) || /\b(?:save|add|set|make|create) (?:a )?waypoint\s+(?:called |named |for )?["']?([a-z0-9][a-z0-9 -]{0,28}?)["']?\s*[.!?]*$/.exec(c)
    if (sv && !negRaw && /\b(?:waypoint|this (?:place|spot|location)|here|location)\b/.test(c)) {
      const name = sv[1].replace(/^(?:the|a|an)\s+/, '').trim()
      if (name && !/^(?:here|this|that|it)$/.test(name)) return mk('save-waypoint', `save waypoint ${name}`, 'low', 0.9, { slots: { name } })
    }

    // 2b. craft <item> [count] (brain/crafting): "make me some torches", "can u craft 10 glass panes", "craft glass pane x16"
    if (tab.craftItem && !negRaw) {
      const cr = parseCraft(c2)
      if (cr) return mk('craft-item', `craft ${cr.item.name.replace(/_/g, ' ')}${cr.explicit ? ' ' + cr.count : ''}`, 'high', cr.item.fuzzy ? 0.85 : 0.98, { slots: { item: cr.item.name, count: cr.count, family: !!cr.item.family, fuzzy: !!cr.item.fuzzy } })
    }

    // 3. go to a place by name (waypoint). Only for orders that START with a movement verb, so "you would take buckets to the depot" is ignored.
    const tokens = repair(cw, tab.vocab, tab.words)
    const hasFollow = cw.some(w => /^(?:follow|folow|fllow|followe)/.test(w))
    if (hasMotion && !hasFollow && !negRaw) {
      const clause = c2.replace(/\bwhere i am(?: now)?,?\s*/g, ' ').replace(/\s+/g, ' ').trim()
      const cands = []
      const re = /\b(?:to|at|near|toward|towards|over at|back to|visit)\s+(?:the\s+|my\s+|our\s+)?([a-z0-9][a-z0-9 ()-]*?)\s*(?=[.!?]*\s*$|[,;]|\band\b|\bthen\b|\bplease\b)/g
      for (const m of clause.matchAll(re)) cands.push(m[1])
      const m3 = /^(?:go|head|walk|travel|run)\s+(?!(?:to|at)\b)(?:the\s+)?([a-z0-9][a-z0-9 -]*?)\s*[.!?]*$/.exec(clause)
      if (m3 && !cands.length) cands.push(m3[1])
      for (const placeQ of cands.reverse()) {
        const pq = placeQ.trim()
        if (/^(?:me|you|here|it|sleep|bed|my bed|back|away|outside|inside|home base)$/.test(pq)) continue
        if (/^(?:there|that place|the same place|back there|where we were)$/.test(pq)) { if (mem.target) return mk('goto-coords', mem.target, 'low', 0.85); continue }
        const hits = matchPlaces(pq)
        if (!hits.length) continue
        const top = hits[0]
        const ties = hits.filter(h => top.score - h.score < 0.04 && h.score >= 0.7)
        if (ties.length > 1) {
          const pos = getPosition()
          const near = ties.map(t => t.w).sort((x, y) => dist2(x, pos) - dist2(y, pos)).slice(0, 4)
          return mk('goto-choice', placeCanonical(near[0]), 'low', 0.6, { slots: { place: pq, options: near.map(o => o.name) }, choice: near })
        }
        return mk('goto-waypoint', placeCanonical(top.w), 'low', top.score >= 0.97 ? 0.95 : top.score * 0.95, { slots: { waypoint: top.w.name } })
      }
    }

    // 4. item questions: "do you have any torches", "how many torches do you have"
    let invItem = null
    const iq = /^(?:do you have|have you got|have you|got any|you got any|how many|how much)\s+(?:any\s+|of\s+)?(.+?)(?:\s+(?:do you have|have you got|do you got|you got|on you|left|in your (?:inventory|bag|pockets)))?\s*[.!?]*$/.exec(c2)
    if (iq) { const it = matchItem(iq[1]); if (it) invItem = it }

    // 5. find <thing> (blocks within range + chest index)
    let findHit = null
    if (!invItem) {
      const f = /^(?:find|locate|search for|look for|hunt for|go find|go look for|where(?:s| is| are)(?: the| any| all| a| an)?|do you see(?: any| a| the)?|is there(?: any| a)?|are there any|how far is(?: the)?|any)\s+(.+?)\s*[.!?]*$/.exec(c2)
      const what = f && f[1].replace(/^me\s+/, '')
      if (f && !/^(?:you|me|it|your|there)\b/.test(what)) {
        const wp = matchPlaces(what)
        const b = matchBlock(what)
        if (b && !(wp.length && wp[0].score > b.score)) findHit = { b, q: what }
        else if (!b && tab.findItem && !wp.length) {   // brain/crafting's find also searches the bag and the chest index for plain items
          const it = matchItem(what)
          if (it && !it.generic) findHit = { b: it, q: what }
        }
      }
    }

    // 6. bag of words against the phrase table
    let best = null; const alts = []
    for (const it of tab.intents) {
      let s = 0, neg = false, fz = 0, extra = 0
      for (const P of it.compiled) { const r = scorePhrase(tokens, P, !!it.instant, !!it.info); if (r.s > s) { s = r.s; neg = P.neg; fz = r.fuzzy; extra = r.extra } }
      if (s > 0) alts.push({ intent: it.id, score: +s.toFixed(2) })
      if (!best || s > best.s) best = { it, s, neg, fz, extra }
    }
    alts.sort((a, b) => b.score - a.score)

    const bowScore = best ? best.s : 0
    if (invItem && bowScore < 0.95) return mk('inventory', 'inventory', 'low', 0.88, { info: true, slots: { item: invItem.name } })
    if (findHit && bowScore < 0.9) {
      return mk('find', `find ${findHit.b.name.replace(/_/g, ' ')}`, 'low', Math.min(0.95, 0.5 + findHit.b.score / 2), { info: true, slots: { thing: findHit.b.name } })
    }
    if (!best || best.s < 0.35) return { _miss: true, best: null }
    let { it, s } = best
    if (risk0(it) === 'high' && (best.fz + fuzzyCount) > 0) s = Math.min(s, 0.9)   // typos: confirm before any risky job
    // "the stop sign is red": an instant word inside a statement is not an order
    if (it.instant && best.extra >= 1 && new RegExp(BSb + '(?:is|are|was|were|has|have|had)' + BSb).test(c2) && !/^(?:stop|wait|hold|halt|freeze|stay|pause|cancel|abort)\b/.test(c2)) s *= 0.5
    let intentId = it.id, canonical = it.canonical, risk = it.risk, instant = !!it.instant, info = !!it.info

    // questions about *how* to do something, past-tense questions, and negations are not commands
    const first = cw[0] || ''
    if (!it.question && /^(?:how|why|when|which|whether)$/.test(first)) s *= 0.6
    if (/^(?:did|were|was|why)$/.test(first) || /^(?:have you|has it|had you)\b/.test(c)) s *= 0.5
    if (/\b(?:you should have|you shouldnt|you didnt|you never|i told you|i said)\b/.test(c)) s *= 0.5
    if (negRaw && !best.neg) {
      if (it.id === 'follow' || it.id === 'come') { intentId = 'stay'; canonical = 'stay'; risk = 'low'; instant = true; info = false; s = Math.max(s, 0.85) }
      else if (it.id === 'stay') s = 0   // "don't stop", "don't wait": not a stop
      else if (!it.info) s = 0           // "don't harvest", "no need to sleep": nothing to do
    }
    // two intents too close to call: never guess a risky one
    const close = alts[1] && alts[0].score - alts[1].score < 0.05 && alts[0].intent === it.id
    if (close && risk === 'high') s = Math.min(s, 0.7)
    if (s < 0.55) return { _miss: true, best: { intent: intentId, score: +s.toFixed(2) } }

    if (canonical === '@again') {
      if (!mem.last) return null
      return mk('again', mem.last, mem.lastRisk || 'low', Math.max(0.85, s), { alts: alts.slice(0, 3) })
    }
    return mk(intentId, canonical, risk, s, { alts: alts.slice(0, 3), instant, info, solo: !!it.solo, slots: { ntok: tokens.length } })
  }

  const publicParse = (user, text) => { const r = parse(user, text); stats.parsed++; return r && !r._miss ? r : null }

  // ---- yes/no and "which one" answers ----
  function answerOf(text) {
    const w = T.words(T.clean(text).replace(/[!?.,]/g, ' ')).filter(x => x !== 'please')
    if (!w.length || w.length > 4) return null
    if (w.every(x => YES.has(x))) return 'yes'
    if (w.every(x => NO.has(x))) return 'no'
    return null
  }

  // Answer to our own yes/no or "which one?" question. Returns a decision, or null when the line is not an answer (the question is then dropped).
  function resolvePending(user, text) {
    const t = now()
    const pend = pending.get(user)
    if (pend && pend.expires < t) pending.delete(user)
    const p = pending.get(user)
    if (!p) return null
    const a = answerOf(text)
    if (p.kind === 'confirm' && a === 'yes') { pending.delete(user); stats.run++; return { type: 'run', canonical: p.canonical, result: p.result, confirmed: true } }
    if (p.kind === 'confirm' && a === 'no') { pending.delete(user); return { type: 'say', text: 'OK, cancelled.' } }
    if (p.kind === 'choice') {
      const w = T.words(T.clean(text).replace(/[!?.,]/g, ' '))
      let pick = null
      const ord = w.map(x => ORDINALS[x]).find(x => x !== undefined)
      if (ord !== undefined && w.length <= 4) pick = p.options[ord < 0 ? p.options.length - 1 : ord]
      if (!pick) {   // "the -637 one"
        const nums = (T.clean(text).match(/-?\d{2,}/g) || [])
        if (nums.length) { const hit = p.options.filter(o => nums.every(n => o.name.includes(n))); if (hit.length === 1) pick = hit[0] }
      }
      if (!pick && a !== 'no') {   // a different place named outright ("ice portal"), else the closest option by name
        const q = placeNorm(text.replace(/[?!.]/g, '').replace(/^(?:the|go to|to)\s+/, ''))
        const named = matchPlaces(q)
        if (named.length && named[0].score >= 0.9 && !(named[1] && named[0].score - named[1].score < 0.04)) pick = named[0].w
        else { const hit = p.options.map(o => ({ o, s: T.sim(q, placeNorm(o.name)) })).sort((x, y) => y.s - x.s)[0]; if (hit && hit.s >= 0.8) pick = hit.o }
      }
      if (!pick && a === 'no') { pending.delete(user); return { type: 'say', text: 'OK, cancelled.' } }
      if (pick) {
        pending.delete(user); stats.run++
        const canonical = placeCanonical(pick)
        return { type: 'run', canonical, result: { intent: 'goto-waypoint', canonical, risk: 'low', score: 0.9, level: 'high', slots: { waypoint: pick.name }, alts: [] } }
      }
    }
    pending.delete(user)   // anything else abandons the question; the line is handled as a fresh one
    return null
  }

  function decide(user, text) {
    const t = now()
    const answered = resolvePending(user, text)
    if (answered) return answered
    const r = parse(user, text); stats.parsed++
    if (!r || r._miss) { stats.none++; return { type: 'none', best: r && r.best ? r.best : null } }
    if (r.intent === 'goto-choice') {
      pending.set(user, { kind: 'choice', options: r.choice, expires: t + CONFIRM_TTL_MS })
      return { type: 'say', text: `Which ${r.slots.place}? ${r.choice.map((o, i) => `${i + 1}) ${o.name}`).join(', ')}`.slice(0, 220), result: r }
    }
    const runNow = r.instant ? (r.score >= 0.8 || (r.score >= 0.55 && (r.slots.ntok || 0) <= 6))
      : r.risk === 'high' ? r.score >= 0.97
        : r.info ? r.score >= 0.7
          : r.score >= 0.8
    if (runNow) { stats.run++; return { type: 'run', canonical: r.canonical, result: r } }
    // a weak match for a risky job is not worth interrupting Walter with a question
    if (r.risk === 'high' && r.score < 0.75) { stats.none++; return { type: 'none', best: { intent: r.intent, score: r.score } } }
    pending.set(user, { kind: 'confirm', canonical: r.canonical, result: r, expires: t + CONFIRM_TTL_MS })
    stats.asked++
    const label = r.slots.waypoint ? 'go to ' + r.slots.waypoint.toLowerCase() : r.canonical
    return { type: 'ask', question: `Did you mean "${label}"? (yes/no)`, result: r }
  }

  function remember(user, canonical, risk) {
    if (!canonical || canonical === '@again') return
    const m = memory.get(user) || {}
    m.last = canonical; m.lastRisk = risk || 'low'; m.lastAt = now()
    if (/^go to /.test(canonical)) m.target = canonical
    memory.set(user, m)
  }
  const hasPending = (user) => { const p = pending.get(user); return !!(p && p.expires >= now()) }
  const quickAck = (text) => /\?\s*$/.test(String(text || '')) || /^\s*(?:why|how|what|who|when|where|is|are|do|does|did|can|could|would|should)\b/i.test(String(text || '')) ? 'Let me think about that.' : 'Got it, one moment.'

  return {
    parse: publicParse, decide, resolvePending, remember, answerOf, hasPending, quickAck, memory, pending, stats,
    repair: (ts) => { const t = table(); return repair(ts, t.vocab, t.words) }
  }
}

module.exports = { create, INTENTS }
