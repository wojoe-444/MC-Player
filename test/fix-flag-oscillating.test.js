// Work order flag-oscillating: the oscillating flag does not say what the bot did with its hands in its 30 s window. A walk that
// paces back and forth and a walk made between digs, placements and swings look the same to it, so the flag records the window's
// digs, placements and busy samples (the same facts the idle and stuck detectors read) next to the path, extent and reversals.
const test = require('node:test')
const assert = require('node:assert')
const D = require('../brain/telemetry/detectors')

const T0 = 1_700_000_000_000
// seconds of samples at 4 Hz; f(i, tSec) -> partial sample
function ring(seconds, f) {
  const out = []
  for (let i = 0; i <= seconds * 4; i++) {
    const s = i / 4
    out.push({ t: T0 + s * 1000, x: 0, y: 64, z: 0, g: 1, vy: 0, yaw: 0, h: '', mv: 0, act: 0, dg: '', tk: '', hp: 20, ...f(i, s) })
  }
  return out
}
const now = (ss) => ss[ss.length - 1].t

test('oscillating: a pacing walk with nothing dug, placed or busy is still flagged, and the window records zero work', () => {
  const ss = ring(40, (i, s) => ({ x: Math.abs(((s * 1.2) % 4) - 2), mv: 1 }))     // 0..2 blocks and back, 36 blocks in 30 s
  const f = D.analyze(ss, [], now(ss)).find(x => x.kind === 'oscillating')
  assert.ok(f, 'oscillation expected')
  assert.deepStrictEqual(f.data.work, { digs: 0, places: 0, busy: 0 })
})

test('oscillating: the window counts the digs, places and busy samples inside it; a walk that did work is still flagged', () => {
  // the same pacing walk, swinging and digging on every other sample
  const ss = ring(40, (i, s) => ({ x: Math.abs(((s * 1.2) % 4) - 2), mv: 1, act: i % 2 === 0 ? 1 : 0, dg: i % 2 === 0 ? 'stone' : '' }))
  const dig = (sec) => ({ k: 'dig', t: T0 + sec * 1000, block: 'stone', x: 0, y: 64, z: 0 })
  const place = (sec) => ({ k: 'place', t: T0 + sec * 1000, block: 'cobblestone', x: 0, y: 64, z: 0, sky: true })
  // dig(5) and place(6) are before the 30 s window (it starts at 10 s): not counted
  const ev = [dig(5), place(6), dig(20), dig(25), place(27), dig(33)]
  const f = D.analyze(ss, ev, now(ss)).find(x => x.kind === 'oscillating')
  assert.ok(f, 'still flagged: recording the work does not hide the walk')
  assert.deepStrictEqual(f.data.work, { digs: 3, places: 1, busy: 0.5 })
  assert.match(f.msg, /3 digs, 1 places, 50% of samples busy/)
})
