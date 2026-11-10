// A telemetry snapshot (brain/state/snapshots/*.json) as a ladder-lab scenario: the incident's blocks, the bot where it stood, the goal the step was after.
//   node tools/ladderlab/run.js --snapshot brain/state/snapshots/s123-ladder_bobbing.json --goal 12,40,-5 [--inv ladder=4,cobblestone=8] [--plain]
// The snapshot is moved so the bot's cell lands at (10, 64, 10) inside the lab's bounds; the goal moves with it. Air outside the 25-block cube is air in the lab.
const fs = require('fs')
const { decodeCells } = require('../../brain/snapshot')

function parseBlock(s) {
  const m = /^([a-z_]+)(?:\[(.*)\])?$/.exec(s), props = {}
  if (m[2]) for (const kv of m[2].split(',')) { const [k, v] = kv.split('='); props[k] = v === 'true' ? true : v === 'false' ? false : /^-?\d+$/.test(v) ? Number(v) : v }
  return { name: m[1], props }
}

function scenarioFromSnapshot(snap, { goal, inv, name, optimal, kind } = {}) {
  const b = snap.bot, cx = Math.floor(b.x), cy = Math.floor(b.y), cz = Math.floor(b.z)
  const dx = 10 - cx, dy = 64 - cy, dz = 10 - cz
  const cells = decodeCells(snap)
  const bag = {}; for (const it of snap.bag || []) bag[it.name] = (bag[it.name] || 0) + it.count
  const g = goal || [cx, cy, cz]
  return {
    name: name || 'snapshot-' + snap.id, kind: kind || (optimal != null ? 'complete' : 'climb'), optimal,
    start: [b.x + dx, b.y + dy, b.z + dz], goal: [g[0] + dx, g[1] + dy, g[2] + dz], inv: inv || bag,
    build: (s) => { for (const [k, v] of cells) { if (v === 'air' || v === 'cave_air') continue; const [x, y, z] = k.split(',').map(Number), p = parseBlock(v); s.set(x + dx, y + dy, z + dz, p.name, p.props) } },
    note: `from snapshot ${snap.id} (flag ${snap.flag ? snap.flag.kind : 'none'}, commit ${snap.commit || '?'}, step ${snap.step || '?'})`
  }
}
function loadScenario(file, opts) { return scenarioFromSnapshot(JSON.parse(fs.readFileSync(file, 'utf8')), opts) }
module.exports = { scenarioFromSnapshot, loadScenario, parseBlock }
