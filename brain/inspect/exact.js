// brain/inspect/exact.js: the exact check. A build that carries a schematic (brain/schematic) is compared with it cell by cell: every cell the schematic names a role
// for (open air, a solid light-blocking non-flammable block, water at a level, an exact hopper ...) must be what the world has there. Pure: takes a grid.
//   Walter 2026-11-11: "it would be a simple test of whether you did it correctly if you knew block by block what you were going for."
// An unknown cell (chunk not loaded) is never a mismatch. Mismatches are grouped by what was wanted and what was found, so a wall leak reads as one finding, not 40.
'use strict'
const F = require('../schematic/format')
const B = require('../schematic/blocks')

const gridGetter = (grid) => (x, y, z) => { const c = grid.get(x, y, z); return c ? { name: c.n, props: c.p || {} } : null }
const WARN_ROLES = /^(water|torch|wall_torch|soul_torch)/        // a level off by one or a missing torch: the farm still works; a hole in the wall does not

// opt.fault: false makes every finding a note (a schematic derived from the design, whose faults the specific checks already report)
function check(schem, at, grid, opt = {}) {
  const r = F.diff(schem, gridGetter(grid), at, { max: 20000 })
  const groups = new Map()
  for (const w of r.wrong) { const k = w.want + ' -> ' + w.got; const g = groups.get(k) || { want: w.want, got: w.got, role: w.role, cells: [] }; groups.set(k, g); g.cells.push(w.x + ',' + w.y + ',' + w.z) }
  const findings = []
  for (const g of [...groups.values()].sort((a, b) => b.cells.length - a.cells.length).slice(0, 12)) {
    const sev = opt.fault === false ? 'note' : WARN_ROLES.test(g.want) ? 'warn' : 'fault'
    findings.push({ id: 'exact-' + B.strip(g.want).split(' ')[0], sev, zone: 'schematic', count: g.cells.length, cells: g.cells.slice(0, 12),
      msg: `${g.cells.length} cell(s) should be ${B.requirementText(describeLabel(g.want))} but are ${g.got} (first at ${g.cells[0]})` })
  }
  if (r.unknown) findings.push({ id: 'exact-unknown', sev: 'note', zone: 'schematic', count: r.unknown, cells: [], msg: `${r.unknown} required cell(s) are not loaded and were not compared` })
  return { findings, stats: { schematic: schem.id, checked: r.checked, matched: r.matched, wrong: r.wrong.length, unknown: r.unknown, pct: r.checked ? Math.round((r.matched / r.checked) * 1000) / 10 : null }, ok: r.ok }
}
// the label B.label() makes ("solid", "air", "water level 3", "hopper facing=down") back into an entry for the sentence
function describeLabel(l) {
  const m = /^(water|lava)(?: level (\d+))?$/.exec(l)
  if (m) return { role: m[1], level: m[2] }
  if (l === 'air' || l === 'solid' || l === 'any') return { role: l }
  const [block, ...rest] = l.split(' ')
  const props = {}; for (const p of rest) { const [k, v] = p.split('='); props[k] = v }
  return { role: 'block', block, ...(rest.length ? { props } : {}) }
}
module.exports = { check, gridGetter }
