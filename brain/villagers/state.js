// Persistent state (api.statePath('villagers-state.json')): the villagers we have met, the ledger of every deal, and the approval flags.
const fs = require('fs')

const blank = () => ({
  version: 1,
  villagers: {},                       // id -> { id, kind, pos:{x,y,z}, profession, level, lastSeen, offers:[{index,out,price,left}], offersAt, cured:null }
  ledger: [],                          // { at, villager, kind:'buy'|'sell', what, times, emeralds }  (emeralds spent (+) or earned (-))
  totals: { spent: 0, earned: 0 },
  plan: { designApproved: false, designApprovedAt: null, layoutDrawn: false, layoutApproved: false },
  upkeep: { enabled: false, lastRun: 0, lastResult: null },
  updatedAt: null
})

function load(file, log = () => {}) {
  const s = blank()
  try {
    const own = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))
    for (const k of ['villagers', 'totals', 'plan', 'upkeep']) if (own[k] && typeof own[k] === 'object') s[k] = { ...s[k], ...own[k] }
    if (Array.isArray(own.ledger)) s.ledger = own.ledger
  } catch (e) { if (e.code !== 'ENOENT') log(`villagers state unreadable (${e.message}); starting fresh`) }
  return s
}

function save(file, state, now = Date.now, log = () => {}) {
  state.updatedAt = new Date(now()).toISOString()
  try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 1)); fs.renameSync(tmp, file) } catch (e) { log('villagers state save failed: ' + e.message) }
}

// Remember what a scan saw. Only visible villagers update profession/level; unseen ones keep what we knew with an old lastSeen.
function remember(state, list, { now, maxKnown = 80 }) {
  for (const x of list) {
    if (x.kind !== 'villager' && x.kind !== 'zombie_villager') continue
    const cur = state.villagers[x.id] || { id: x.id, offers: [], offersAt: null, cured: null }
    cur.kind = x.kind; cur.pos = x.pos
    if (x.visible) { cur.lastSeen = now; if (x.profession) cur.profession = x.profession; if (x.level) cur.level = x.level }
    state.villagers[x.id] = cur
  }
  const all = Object.values(state.villagers)
  if (all.length > maxKnown) for (const v of all.sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0)).slice(0, all.length - maxKnown)) delete state.villagers[v.id]
}

function recordOffers(state, id, descs, now) {
  const v = state.villagers[id] || (state.villagers[id] = { id, kind: 'villager', offers: [] })
  v.offers = descs.map((d) => ({ index: d.index, out: d.out ? { name: d.out.name, count: d.out.count, enchants: d.out.enchants } : null, in1: d.in1, in2: d.in2, left: d.left }))
  v.offersAt = now
}

function recordDeal(state, deal, { now, ledgerMax = 300 }) {
  state.ledger.push({ at: now, ...deal })
  if (state.ledger.length > ledgerMax) state.ledger.splice(0, state.ledger.length - ledgerMax)
  if (deal.kind === 'buy') state.totals.spent += deal.emeralds; else state.totals.earned += deal.emeralds
}

module.exports = { blank, load, save, remember, recordOffers, recordDeal }
