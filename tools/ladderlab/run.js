// Scenario runner. node tools/ladderlab/run.js [name-filter] [--json] [--plain]
//   --plain   the baseline: the navigator with ladder work switched off (cfg.ladders = false)
// Every scenario runs on the real pathfinder + physics in virtual time. Pass criteria per kind:
//   climb     arrives, no more than MAX_BACKTRACK blocks of travel against the direction of the trip (bobbing), within the tick budget
//   complete  arrives with no more placed blocks than `optimal` (ladders + backing blocks), no bobbing; expectFail scenarios must refuse
//             honestly: not arrive, place nothing, and not bob
const { makeLab, H } = require('./world')
const { S } = require('./scenarios')
const { goals } = H

const MAX_BACKTRACK = 1.0           // blocks of vertical travel in the wrong direction that still count as "no bobbing" (the landing hop at the top)
const TICK_BUDGET = 2400

function metrics(track, up) {
  let back = 0, trav = 0
  for (let i = 1; i < track.length; i++) {
    const dy = track[i][1] - track[i - 1][1]
    trav += Math.abs(dy)
    if (up ? dy < 0 : dy > 0) back += Math.abs(dy)
  }
  return { backtrack: +back.toFixed(1), vertTravel: +trav.toFixed(1), net: +(track[track.length - 1][1] - track[0][1]).toFixed(1) }
}

async function run(sc, { plain = false } = {}) {
  const r = await H.rig({ make: makeLab, pos: sc.start, inv: sc.inv || {}, bounds: { x0: -20, x1: 40, y0: 0, y1: 120, z0: -20, z1: 40 } }, sc.build, { config: { ladders: !plain } })
  r.bot.pathfinder.thinkTimeout = 3000
  const track = []
  r.bot.on('physicsTick', () => { const p = r.bot.entity.position; track.push([p.x, p.y, p.z]) })
  const t0 = r.sim.ticks
  const res = await r.go(new goals.GoalBlock(...sc.goal), { maxTicks: sc.maxTicks || TICK_BUDGET, after: 0 })
  const up = sc.goal[1] >= sc.start[1]
  const m = metrics(track, up)
  const placed = r.sim.placed.length
  const out = { arrived: !!res.ok, ticks: r.sim.ticks - t0, placed, ...m, ladders: r.sim.placed.filter(p => p.name === 'ladder').length, left: r.sim.inv(), err: res.err || res.ladderWhy }
  let pass
  if (sc.expectFail) pass = !out.arrived && placed === 0 && out.backtrack <= 12
  else pass = out.arrived && out.backtrack <= MAX_BACKTRACK && out.ticks <= TICK_BUDGET && (sc.kind !== 'complete' || placed <= sc.optimal)
  out.pass = pass
  out.finalPos = r.sim.at().toString()
  r.close()
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const filter = args.find(a => !a.startsWith('--')) || ''
  const plain = args.includes('--plain'), json = args.includes('--json')
  let fails = 0
  for (const sc of S.filter(s => s.name.includes(filter))) {
    let o
    try { o = await run(sc, { plain }) } catch (e) { o = { pass: false, err: e.stack.split('\n').slice(0, 3).join(' | ') } }
    if (!o.pass) fails++
    const opt = sc.kind === 'complete' ? ` optimal=${sc.optimal}` : ''
    console.log(`${o.pass ? 'PASS' : 'FAIL'} ${sc.kind.padEnd(8)} ${sc.name.padEnd(18)}${opt}`.padEnd(52), json ? JSON.stringify(o) : `arrived=${o.arrived} placed=${o.placed} ticks=${o.ticks} backtrack=${o.backtrack} ${o.err ? 'err=' + o.err : ''}`)
  }
  console.log(fails ? `${fails} scenario(s) failed` : 'all scenarios passed')
  return fails
}
if (require.main === module) main().then(f => process.exit(f ? 1 : 0))
module.exports = { run, metrics, MAX_BACKTRACK }
