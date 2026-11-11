// brain/schematic/loop.js: WHEN the loop follows a schematic, and which one. Pure apart from reading the catalog.
//
// Walter 2026-11-11: following a schematic belongs in the recursive loop "when appropriate. It's really only needed seldom, like when the decision has been made to
// build a mob farm." So this is a gate, and the default answer is NO:
//   - a torch, a chest, a bridge, a pillar, a shaft, a small hut or anything the bot just does: never a schematic (the routines and the planner do those; a
//     blueprint for them would only slow the bot down);
//   - a build kind in FOLLOW_BY_DEFAULT (today the mob farm) follows one as soon as the decision to build it is made, if the catalog has one for the kind;
//   - anything else follows one only when it is named on purpose (Walter, a work order or the bot's own plan: `explicit`), and only if the build is big enough
//     (MIN_CELLS cells that are checked) for cell by cell checking to pay;
//   - a schematic with no `explicit` ask and no matching kind is never picked on its own, whatever the catalog holds.
// What it buys: the finish line is the world's, not a routine's. progress() in follow.js says how much of the build is really there, cell by cell, and the same
// number goes to the inspection, the outcome check, the journal and the work orders.
'use strict'
const S = require('./store')

const FOLLOW_BY_DEFAULT = ['mobfarm']
const NEVER = /^(torch|torches|light|lighting|chest|storage|crafting|furnace|bed|door|ladder|bridge|pillar|stairs|shaft|tunnel|path|road|fence|sign|farmland|crop|crops|pen|hut|shelter|wall|floor|cobble|tower-pillar|seal|plug)$/
const MIN_CELLS = 120
// preferred schematic per kind, best first (the benchmark farm is the better target than the first design: 2102 open cells and 4 hoppers against 414 and 1)
const PREFER = { mobfarm: ['mobfarm-forever2k27'] }

const cellsChecked = (s) => (s.palette || []).reduce((a, e, i) => a + (e.role === 'any' || e.scenery ? 0 : ((s.counts && s.counts[i]) || 0)), 0)

// Should this build follow a schematic? -> { follow, why }.  `explicit`: a person or an order named it. `schem` (optional): the candidate, to check its size.
function policy({ kind, explicit = false, schem = null } = {}) {
  const k = String(kind || '').toLowerCase()
  if (!k) return { follow: false, why: 'no build kind given' }
  if (NEVER.test(k)) return { follow: false, why: `"${k}" is an everyday job: do it directly, no schematic` }
  const byDefault = FOLLOW_BY_DEFAULT.includes(k)
  if (!byDefault && !explicit) return { follow: false, why: `"${k}" does not follow a schematic unless it is asked for by name (Walter, a work order or your own plan)` }
  if (schem && cellsChecked(schem) < MIN_CELLS) return { follow: false, why: `${schem.id} has only ${cellsChecked(schem)} checked cells (the bar is ${MIN_CELLS}): too small to be worth the cell by cell check` }
  return { follow: true, why: byDefault ? `"${k}" is a build that follows its schematic by default` : 'asked for by name' }
}

// the schematics a build of `kind` could follow, best first: preferred ids, then the same kind, newest capture last (a saved capture of a working build beats nothing)
function candidates(kind, dirs) {
  const k = String(kind || '').toLowerCase()
  const all = S.list(dirs).map(e => e.schematic)
  const pref = PREFER[k] || []
  const score = (s) => { const i = pref.indexOf(s.id); return i >= 0 ? i : 100 }
  return all.filter(s => String(s.kind || '').toLowerCase() === k && cellsChecked(s) > 0).sort((a, b) => score(a) - score(b) || cellsChecked(b) - cellsChecked(a))
}

// -> { ok, schematic, follow, why } for a decided build
function choose({ kind, id = null, explicit = false, dirs }) {
  const list = id ? S.list(dirs).map(e => e.schematic).filter(s => s.id === id) : candidates(kind, dirs)
  const schem = list[0]
  if (!schem) return { ok: false, follow: false, why: id ? `no schematic "${id}" in the catalog` : `the catalog has no schematic for "${kind}"` }
  const p = policy({ kind: kind || schem.kind, explicit: explicit || !!id, schem })
  if (!p.follow) return { ok: false, follow: false, why: p.why, schematic: schem }
  return { ok: true, follow: true, why: p.why, schematic: schem }
}

// a one-line, plain description of what a schematic needs: for the planner's menu and the work order text
function describe(s) { const n = cellsChecked(s); return `${s.id} (${s.kind}, ${s.mode || 'functional'}, ${s.size.join('x')}, ${n} checked cells)` }

module.exports = { FOLLOW_BY_DEFAULT, MIN_CELLS, PREFER, policy, candidates, choose, describe, cellsChecked }
