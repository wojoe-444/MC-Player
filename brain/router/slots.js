// One gate for every command string a router tier proposes: it must be a catalog command or a slot command with valid slots.
// Used on the output of the decision model's label (already closed) and on anything a later tier (fast chat lane) returns.
// Mirrors the canonical forms brain/chat emits, which the brain command table and the legacy handleCommand() understand.
const MAX_COORD = 30000000
const WP_NAME = /^[a-z0-9][a-z0-9 -]{0,28}$/
const singular = (w) => /ies$/.test(w) ? w.replace(/ies$/, 'y') : /(?:ses|xes|ches|shes|oes)$/.test(w) ? w.slice(0, -2) : w.replace(/s$/, '')

// catalog: from catalog.build(); reg: { blocks: string[], items: string[] } (registry names, may be empty)
// -> { ok:true, canonical, risk, shown, instant } | { ok:false, reason }
function validate(raw, catalog, reg = {}) {
  if (typeof raw !== 'string') return { ok: false, reason: 'not-a-string' }
  const text = raw.replace(/\s+/g, ' ').trim()
  if (!text || text.length > 80) return { ok: false, reason: 'length' }
  if (text.startsWith('/') || /[\u0000-\u001f\u007f]/.test(raw.replace(/\s/g, ' '))) return { ok: false, reason: 'unsafe-text' }
  const low = text.toLowerCase()

  const opt = catalog.byLabel.get(low)
  if (opt && opt.canonical) return { ok: true, canonical: opt.canonical, risk: opt.risk, shown: opt.canonical, instant: !!opt.instant }

  let m = /^go to (-?\d{1,8})(?: (-?\d{1,4}))? (-?\d{1,8})$/.exec(low)
  if (m) {
    const [x, y, z] = m[2] != null ? [m[1], m[2], m[3]] : [m[1], null, m[3]]
    if (Math.abs(+x) > MAX_COORD || Math.abs(+z) > MAX_COORD || (y !== null && (+y < -64 || +y > 320))) return { ok: false, reason: 'coords-range' }
    return { ok: true, canonical: low, risk: 'low', shown: low }
  }
  const wp = catalog.waypoints.find(w => w.canonical.toLowerCase() === low || ('go to ' + w.name.toLowerCase()) === low)
  if (wp) return { ok: true, canonical: wp.canonical, risk: 'low', shown: 'go to ' + wp.name.toLowerCase() }

  m = /^save waypoint (.+)$/.exec(low)
  if (m) return WP_NAME.test(m[1]) ? { ok: true, canonical: low, risk: 'low', shown: low } : { ok: false, reason: 'waypoint-name' }

  // brain/pilot: the mining module's own phrase ("mine <ore> <amount>"); digging, so always confirmed
  m = /^mine (diamond|iron|coal|gold|redstone|lapis|copper)(?: (\d{1,3}))?$/.exec(low)
  if (m) return { ok: true, canonical: `mine ${m[1]}${m[2] ? ' ' + m[2] : ''}`, risk: 'high', shown: `mine ${m[1]}${m[2] ? ' ' + m[2] : ''}` }

  m = /^find (.+)$/.exec(low)
  if (m) {
    const base = m[1].replace(/ /g, '_')
    const blocks = new Set(reg.blocks || [])
    for (const b of [base, singular(base)]) {
      if (blocks.has(b)) return { ok: true, canonical: 'find ' + b.replace(/_/g, ' '), risk: 'low', shown: 'find ' + b.replace(/_/g, ' ') }
      if (blocks.has(b + '_ore')) return { ok: true, canonical: 'find ' + b.replace(/_/g, ' ') + ' ore', risk: 'low', shown: 'find ' + b.replace(/_/g, ' ') + ' ore' }
    }
    return { ok: false, reason: 'unknown-block' }
  }

  m = /^craft (.+?)(?: (\d{1,6}))?$/.exec(low)
  if (m) {
    const items = new Set(reg.items || [])
    const n = m[2] ? Number(m[2]) : null
    const name = m[1].replace(/ /g, '_')
    if (!items.has(name)) return { ok: false, reason: 'unknown-item' }
    if (n !== null && (n < 1 || n > 2304)) return { ok: false, reason: 'count-range' }
    const canonical = `craft ${m[1]}${n !== null ? ' ' + n : ''}`
    return { ok: true, canonical, risk: 'high', shown: canonical }   // crafting uses items and chests: always confirmed
  }
  return { ok: false, reason: 'unknown-command' }
}

module.exports = { validate }
