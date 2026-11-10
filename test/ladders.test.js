// brain/nav/ladders.js and the ladder lab (tools/ladderlab): every scenario fixture must pass, the planner is exact, and the bobbing causes stay fixed.
// Real pathfinder + real prismarine-physics in virtual time, no server (see tools/ladderlab/world.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const { run } = require('../tools/ladderlab/run')
const { S, tower, X, range } = require('../tools/ladderlab/scenarios')
const { makeLab, H } = require('../tools/ladderlab/world')
const { plan } = require('../brain/nav/ladders')
const { StuckMonitor, Penalties } = require('../brain/nav/stuck')

for (const sc of S) {
  test(`ladder lab: ${sc.kind} ${sc.name}${sc.optimal != null ? ' (optimal ' + sc.optimal + ' blocks)' : ''}`, async () => {
    const o = await run(sc)
    assert.ok(o.pass, `${sc.note || ''}\n${JSON.stringify(o)}`)
  })
}

test('plan(): one ladder per missing cell above the floor cell, one more block where the wall is open, and exact material checks', () => {
  const cells = [{ y: 64, kind: 'free' }, { y: 65, kind: 'ladder' }, { y: 66, kind: 'free' }, { y: 67, kind: 'nowall' }, { y: 68, kind: 'ladder' }]
  const p = plan({ cells, baseY: 64, have: { ladder: 2, blocks: 1 } })
  assert.deepEqual([p.ok, p.missing, p.backing, p.total], [true, [66, 67], [67], 3])
  assert.equal(plan({ cells, baseY: 64, have: { ladder: 1, blocks: 1 } }).ok, false)
  assert.equal(plan({ cells, baseY: 64, have: { ladder: 2, blocks: 0 } }).ok, false)
  assert.equal(plan({ cells: [{ y: 65, kind: 'blocked' }], baseY: 64, have: { ladder: 9 } }).ok, false)
})

test('the library path that rose out of the top rung into thin air is gone: a ladder one short of the ledge is an honest "no path", not a bob', async () => {
  const sc = S.find(s => s.name === 'top-short-1')
  const o = await run({ ...sc, inv: {} })                 // no ladders in the bag: nothing can finish it
  assert.equal(o.arrived, false)
  assert.ok(o.ticks < 60, 'gives up at once: ' + JSON.stringify(o))
  assert.ok(o.backtrack < 1, 'never rode up and fell: ' + JSON.stringify(o))
})

test('StuckMonitor.ladderLoop(): up, down, up in one column is a loop; one climb, a walk, or a long run of rungs is not', () => {
  const mk = (ys, xz = () => [0.5, 0.5]) => {
    const bot = { on() {}, removeListener() {}, entity: { position: new H.Vec3(0.5, ys[ys.length - 1], 0.5) } }
    const m = new StuckMonitor({ bot, penalties: new Penalties(), config: {} })
    m.yTrack = ys.map((y, i) => [...xz(i).slice(0, 1), y, xz(i)[1]])
    return m
  }
  const wave = (...legs) => { const out = []; let y = 64; for (const d of legs) { const n = Math.abs(d) * 5; for (let i = 0; i < n; i++) out.push(y += Math.sign(d) * 0.2); } return out }
  let got = 0
  const loop = mk(wave(9, -9, 9)); loop.on('ladder-loop', () => got++)
  assert.equal(loop.ladderLoop(), true); assert.equal(got, 1)
  assert.equal(mk(wave(12)).ladderLoop(), false, 'one long climb')
  assert.equal(mk(wave(30)).ladderLoop(), false, 'a 30 block climb')
  assert.equal(mk(wave(9, -1, 9)).ladderLoop(), false, 'a hop back of one block is the landing at the top, not a loop')
  assert.equal(mk(wave(9, -9, 9), (i) => [0.5 + i * 0.05, 0.5]).ladderLoop(), false, 'walking away while changing height is not a column')
})

// ------------------------------------------------------------------ randomized gaps: the plan is exact for any pattern
function lcg(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296 }
test('fuzz: random missing rungs and open walls, any spare material - always arrives with exactly the optimal number of blocks', async () => {
  const rnd = lcg(444)
  for (let i = 0; i < 12; i++) {
    const T = 70 + Math.floor(rnd() * 14)
    const missing = range(65, T - 1).filter(() => rnd() < 0.35)
    if (!missing.length) missing.push(65 + Math.floor(rnd() * (T - 65)))
    const open = missing.filter(() => rnd() < 0.4)
    const optimal = missing.length + open.length
    const sc = {
      name: `fuzz-${i}`, kind: 'complete', start: [X + .5, 64, 3.5], goal: [X, T, -1], optimal,
      build: s => { tower(s, T, { skip: missing }); for (const y of open) s.clear(X, y, -1) },
      inv: { ladder: missing.length + Math.floor(rnd() * 3), cobblestone: open.length + Math.floor(rnd() * 3) }
    }
    const o = await run(sc)
    assert.ok(o.pass, `T=${T} missing=${missing} open=${open}\n${JSON.stringify(o)}`)
    assert.equal(o.placed, optimal, `T=${T} missing=${missing} open=${open}`)
  }
})
