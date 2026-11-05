// Villager perception: pure helpers over mineflayer entities. A villager that cannot be seen (api.canSee) is "unknown": we may remember
// where it was, but never assume its profession or offers from outside what we saw.
const PROFESSIONS = ['none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher', 'leatherworker', 'librarian', 'mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith']

const KINDS = { villager: 'villager', zombie_villager: 'zombie_villager', iron_golem: 'iron_golem', wandering_trader: 'wandering_trader' }
const isBaby = (e) => {
  if (e.isBaby === true) return true
  if (e.metadata && e.metadata.some && e.metadata.some((m) => m && m.baby === true)) return true
  return !!e.height && e.height < 1.2 && e.name === 'villager'
}

// villager_data metadata: {villagerType, villagerProfession, level}, ids or names, wherever the metadata array put it
function villagerData(e) {
  if (e.villagerData) return e.villagerData
  const m = Array.isArray(e.metadata) ? e.metadata : []
  return m.find((x) => x && typeof x === 'object' && !Array.isArray(x) && ('villagerProfession' in x || 'profession' in x)) || null
}
function professionOf(e) {
  const d = villagerData(e); if (!d) return null
  const p = d.villagerProfession ?? d.profession
  if (typeof p === 'string') return p.replace('minecraft:', '')
  return Number.isInteger(p) && PROFESSIONS[p] ? PROFESSIONS[p] : null
}
const levelOf = (e) => { const d = villagerData(e); return d && Number.isInteger(d.level) ? d.level : null }

// 'villager' | 'baby_villager' | 'zombie_villager' | 'iron_golem' | 'wandering_trader' | null
function classify(e) {
  if (!e || !e.name) return null
  const k = KINDS[e.name]; if (!k) return null
  return k === 'villager' && isBaby(e) ? 'baby_villager' : k
}

// Everything of interest within radius, nearest first. `canSee(entity)` (api.canSee) decides what counts as seen right now.
function scan(bot, { radius = 48, canSee = () => false } = {}) {
  const me = bot.entity.position, out = []
  for (const e of Object.values(bot.entities || {})) {
    const kind = classify(e); if (!kind) continue
    const dist = e.position.distanceTo(me); if (dist > radius) continue
    let visible = false
    try { visible = !!canSee(e) } catch { visible = false }
    out.push({
      id: e.id, kind, dist: Math.round(dist * 10) / 10, visible, entity: e,
      pos: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) },
      profession: visible && kind === 'villager' ? professionOf(e) : null,   // unseen: unknown
      level: visible && kind === 'villager' ? levelOf(e) : null
    })
  }
  return out.sort((a, b) => a.dist - b.dist)
}

// short chat line
function summarize(list) {
  const v = list.filter((x) => x.kind === 'villager'), b = list.filter((x) => x.kind === 'baby_villager')
  const z = list.filter((x) => x.kind === 'zombie_villager'), g = list.filter((x) => x.kind === 'iron_golem')
  if (!v.length && !b.length && !z.length) return null
  const parts = []
  if (v.length) {
    const seen = v.filter((x) => x.visible)
    const profs = {}; for (const x of seen) { const p = x.profession && x.profession !== 'none' ? x.profession : 'no job'; profs[p] = (profs[p] || 0) + 1 }
    const pTxt = Object.entries(profs).map(([p, n]) => `${n} ${p}`).join(', ')
    parts.push(`${v.length} villager(s)${pTxt ? ` (${pTxt}${seen.length < v.length ? `, ${v.length - seen.length} out of sight` : ''})` : ' out of sight'}`)
  }
  if (b.length) parts.push(`${b.length} baby`)
  if (z.length) parts.push(`${z.length} ZOMBIE villager(s)`)
  if (g.length) parts.push(`${g.length} iron golem(s)`)
  const n = v.concat(b, z)[0]
  return `${parts.join(', ')}. Nearest at ${n.pos.x}, ${n.pos.y}, ${n.pos.z} (${Math.round(n.dist)} blocks).`
}

module.exports = { PROFESSIONS, classify, scan, summarize, professionOf, levelOf, isBaby, villagerData }
