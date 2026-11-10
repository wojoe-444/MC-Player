// brain/gate: the packet boundary. Every action the bot takes leaves through bot._client.write, so the agreed rules of play are checked THERE, from
// one rules file (brain/gate/rules.json), instead of at the ~70 equip / ~25 place / dig call sites that keep leaking (docs/HILLCLIMB-INSIGHTS.md, "Invariant enforcement").
//
//   const gate = require('./brain/gate').install(bot, { stateDir, log })
//   gate.summary()            { mode per rule, counts, call sites }
//   gate.setMode('noArmor', 'enforce')       (or edit rules.json and restart)
//
// Modes per rule: off | log | enforce. LOG-ONLY comes first: each violation is recorded with the call site that wrote the packet (stack frames in the repo),
// the packet goes out unchanged, and after a day brain/state/gate-log.json is the complete list of stray code paths. Then flip the rule to enforce.
// In enforce mode the packet is dropped (not written) and the write returns undefined; the violation is still recorded with a 'blocked' flag.
//
// Never throws into the caller: a bug in a check is logged once per rule and the packet goes out. The bot's own play is not changed in log mode.
const fs = require('fs')
const path = require('path')

const DEFAULT_RULES = path.join(__dirname, 'rules.json')
const TIERS = { wooden: 1, golden: 1.5, stone: 2, iron: 3, diamond: 4, netherite: 5 }
const TIER_NAMES = ['wooden', 'stone', 'iron', 'diamond', 'netherite']
const ARMOR = /_(helmet|chestplate|leggings|boots)$|^(turtle_helmet|elytra)$/
const TOOL = /^(wooden|golden|stone|iron|diamond|netherite)_(pickaxe|axe|shovel|hoe)$/
const FRAMES_KEPT = 4
const MAX_EVENTS = 200

function toolInfo(name) { const m = TOOL.exec(name || ''); return m ? { tier: TIERS[m[1]], kind: m[2], tierName: m[1] } : null }

// repo call sites of the current stack: frames under the repo (not node_modules, not this file), trimmed to file:line
function callSites(stack, root) {
  const out = []
  for (const line of String(stack || '').split('\n').slice(1)) {
    const m = /\(?([^()\s]+):(\d+):\d+\)?\s*$/.exec(line.trim())
    if (!m) continue
    const file = m[1]
    if (file.startsWith('node:') || file.includes('node_modules') || file === __filename || file.startsWith(__dirname + path.sep) && !file.includes('.test.')) continue
    out.push(`${path.relative(root, file).split(path.sep).join('/')}:${m[2]}`)
    if (out.length >= FRAMES_KEPT) break
  }
  return out
}

function install(bot, opts = {}) {
  if (bot._gate && bot._gate.v === 1) return bot._gate
  const root = opts.root || path.join(__dirname, '..', '..')
  const stateDir = opts.stateDir || path.join(__dirname, '..', 'state')
  const log = opts.log || (() => {})
  const now = opts.now || Date.now
  const rulesFile = opts.rulesFile || DEFAULT_RULES
  let rules = opts.rules || JSON.parse(fs.readFileSync(rulesFile, 'utf8')).rules
  const logFile = opts.logFile === undefined ? path.join(stateDir, 'gate-log.json') : opts.logFile
  const armorAllowed = opts.armorAllowed || (() => process.env.ALLOW_ARMOR === '1' || !!(() => { try { return require('../safety/gear').allowArmor } catch { return false } })())
  const mcData = () => bot.registry || null
  const itemName = (id) => { const r = mcData(); return r && r.items && r.items[id] ? r.items[id].name : null }

  const stats = { since: now(), v: 1, rules: {}, recent: [] }
  for (const k of Object.keys(rules)) stats.rules[k] = { mode: rules[k].mode || 'log', violations: 0, blocked: 0, sites: {} }
  const broken = new Set()
  const chat = { last: 0, lines: new Map() }
  let dirty = false, saveTimer = null

  const slotItem = (slot) => (bot.inventory && bot.inventory.slots ? bot.inventory.slots[slot] : null)
  const heldName = () => (bot.heldItem ? bot.heldItem.name : null)

  // ---- the checks: (name, params) -> null or a short reason string ----
  const checks = {
    noArmor(name, p, r) {
      if (armorAllowed()) return null
      const slots = r.armorSlots || [5, 6, 7, 8]
      if (name === 'use_item') {                                         // right-click with armor in hand puts it on
        const h = (p.hand === 1 ? slotItem(45) : bot.heldItem)
        return h && ARMOR.test(h.name) ? `use_item with ${h.name} in hand` : null
      }
      if (name !== 'window_click' || (p.windowId !== undefined && p.windowId !== 0)) return null
      for (const c of p.changedSlots || []) {                            // the client's own claim of what ends up where
        const loc = c.location !== undefined ? c.location : c.slot
        const n = c.item && c.item.itemCount > 0 ? itemName(c.item.itemId) : null
        if (slots.includes(loc) && n && ARMOR.test(n)) return `${n} placed into armor slot ${loc}`
      }
      if (p.mode === 1 && p.slot >= 9 && p.slot <= 44) {                 // shift-click of an armor piece from the bag or hotbar
        const it = slotItem(p.slot)
        if (it && ARMOR.test(it.name)) return `shift-click of ${it.name} (slot ${p.slot})`
      }
      if (p.mode === 2 && slots.includes(p.slot)) {                      // hotbar key swap into an armor slot
        const it = slotItem(36 + p.mouseButton)
        if (it && ARMOR.test(it.name)) return `hotbar swap of ${it.name} into armor slot ${p.slot}`
      }
      return null
    },
    minToolTier(name, p, r) {
      if (name !== 'block_dig' || p.status !== 0) return null           // status 0 = start digging
      const held = toolInfo(heldName()); if (!held) return null
      const b = p.location ? bot.blockAt({ x: p.location.x, y: p.location.y, z: p.location.z }) : null
      if (!b) return null
      // what the block needs: the lowest tier among the tools that can harvest it; no list means any tool will do, so the floor tier is enough
      let need = TIERS[r.floor || 'stone'] || 2
      if (b.harvestTools) {
        const tiers = Object.keys(b.harvestTools).map(i => toolInfo(itemName(Number(i)))).filter(Boolean).map(t => t.tier)
        if (tiers.length) need = Math.max(Math.min(...tiers), need)
      }
      if (held.tier <= need) return null
      const lower = bot.inventory.items().map(i => ({ i, t: toolInfo(i.name) })).find(x => x.t && x.t.kind === held.kind && x.t.tier >= need && x.t.tier < held.tier)
      if (!lower) return null                                           // nothing smaller to use: not a violation
      return `${heldName()} on ${b.name} (${lower.i.name} is in the bag and is enough)`
    },
    lavaWalk(name, p) {
      if (heldName() !== 'lava_bucket') return null
      return `${name} with lava_bucket selected`
    },
    torchSpacing(name, p, r) {
      if (name !== 'block_place' || !/torch$/.test(heldName() || '')) return null
      const f = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][p.direction]; if (!f || !p.location) return null
      const cx = p.location.x + f[0], cy = p.location.y + f[1], cz = p.location.z + f[2], d = r.minDistance || 3
      for (let dx = -(d - 1); dx <= d - 1; dx++) for (let dy = -(d - 1); dy <= d - 1; dy++) for (let dz = -(d - 1); dz <= d - 1; dz++) {
        if (!dx && !dy && !dz) continue
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) >= d) continue
        const b = bot.blockAt({ x: cx + dx, y: cy + dy, z: cz + dz })
        if (b && /(^|_)torch$/.test(b.name)) return `torch at ${cx},${cy},${cz} is ${Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz))} from the torch at ${cx + dx},${cy + dy},${cz + dz}`
      }
      return null
    },
    chatRate(name, p, r) {
      if (name !== 'chat_message') return null
      const t = now(), msg = String(p.message || '')
      let why = null
      if (t - chat.last < (r.minGapMs || 1000)) why = `two chat lines ${t - chat.last} ms apart`
      const seen = chat.lines.get(msg)
      if (!why && seen && t - seen < (r.repeatWindowMs || 60000) && !msg.startsWith('/')) why = 'the same line again within a minute'
      chat.last = t; chat.lines.set(msg, t)
      if (chat.lines.size > 50) for (const [k, v] of chat.lines) if (t - v > (r.repeatWindowMs || 60000)) chat.lines.delete(k)
      return why
    }
  }

  const byPacket = {}
  const rebuild = () => { for (const k of Object.keys(byPacket)) delete byPacket[k]; for (const [rn, r] of Object.entries(rules)) { if (!checks[rn] || (r.mode || 'log') === 'off') continue; for (const pk of r.packets || []) (byPacket[pk] = byPacket[pk] || []).push(rn) } }
  rebuild()

  function record(rn, pkt, why, blocked, stack) {
    const s = stats.rules[rn]; s.violations++; if (blocked) s.blocked++
    const sites = callSites(stack, root), key = sites[0] || '(no repo frame)'
    s.sites[key] = (s.sites[key] || 0) + 1
    const ev = { t: now(), rule: rn, packet: pkt, why, blocked, sites }
    stats.recent.push(ev); if (stats.recent.length > MAX_EVENTS) stats.recent.shift()
    dirty = true; schedule()
    log(`gate ${blocked ? 'BLOCKED' : 'violation'} ${rn} (${pkt}): ${why} <- ${sites.join(' < ')}`)
  }

  function save() {
    dirty = false
    if (!logFile) return
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, JSON.stringify({ ...stats, savedAt: now() }, null, 1)) } catch { /* the log is a nicety */ }
  }
  function schedule() { if (saveTimer || !logFile) return; saveTimer = setTimeout(() => { saveTimer = null; if (dirty) save() }, 5000); if (saveTimer.unref) saveTimer.unref() }

  const client = bot._client
  const origWrite = client.write
  const gatedWrite = function gatedWrite(name, params) {
    const list = byPacket[name]
    if (list) {
      for (const rn of list) {
        let why = null
        try { why = checks[rn](name, params || {}, rules[rn]) } catch (e) { if (!broken.has(rn)) { broken.add(rn); log(`gate check ${rn} failed once: ${e.message}`) } continue }
        if (!why) continue
        const enforce = (rules[rn].mode || 'log') === 'enforce'
        record(rn, name, why, enforce, new Error().stack)
        if (enforce) return undefined
      }
    }
    return origWrite.apply(this, arguments)
  }
  client.write = gatedWrite

  const gate = {
    v: 1,
    summary: () => JSON.parse(JSON.stringify({ since: stats.since, rules: stats.rules })),
    recent: () => stats.recent.slice(),
    setMode(rn, mode) { if (!rules[rn] || !stats.rules[rn]) return false; rules[rn].mode = mode; stats.rules[rn].mode = mode; rebuild(); return true },
    flush: save,
    uninstall() { if (client.write === gatedWrite) client.write = origWrite; if (saveTimer) clearTimeout(saveTimer); if (dirty) save(); delete bot._gate }
  }
  bot._gate = gate
  return gate
}

module.exports = { install, callSites, toolInfo, ARMOR }
