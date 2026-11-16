// Work order finding-ozo-shaft-top-exit-jam: the bot holds one tile at the shaft top (climbing up and back down there, no digs, no places) and no
// idle flag is raised. The idle detector (brain/telemetry/detectors.js, idleFlag) measures how far the bot moved with extent(), which takes the
// 3D range of the samples, height included. A bot that stands on one tile and bobs up and down by more than 1.5 blocks (a climb that turns back
// at the top) is therefore never "still": the idle flag is skipped for the whole window, and the idle counter reads the bob as movement too.
// The test: a bot that holds one tile for two minutes, bobbing 1.6 blocks up and down, with a named task and step and nothing else, must be
// flagged idle. Controls: a bot that holds still with a small bob is idle (already true), and a bot that walks away while it bobs is not idle.
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const D = require('../brain/telemetry/detectors')

const T0 = 1_700_000_000_000
// seconds of samples at 4 Hz; f(i, tSec) -> partial sample (the same shape as the ring in telemetry.test.js)
function ring(seconds, f) {
  const out = []
  for (let i = 0; i <= seconds * 4; i++) {
    const s = i / 4
    out.push({ t: T0 + s * 1000, x: 0.5, y: 66, z: 0.5, g: 1, vy: 0, yaw: 0, h: 'stone_pickaxe', mv: 0, act: 0, dg: '', tk: '', hp: 20, ...f(i, s) })
  }
  return out
}
const now = (ss) => ss[ss.length - 1].t
// up and back down once every 6 s, between 0 and 1 (a climb onto the shaft top and back)
const tri = (s) => { const p = (s % 6) / 6; return p < 0.5 ? p * 2 : 2 - p * 2 }

test('a bot that holds one tile for two minutes, bobbing 1.6 blocks up and down with nothing dug or placed, is flagged idle', () => {
  const ss = ring(125, (i, s) => ({ y: 66 + 1.6 * tri(s), tk: 'autopilot', st: 'exit' }))
  const flags = D.analyze(ss, [], now(ss))
  const idle = flags.find(f => f.kind === 'idle')
  assert.ok(idle, 'a hold on one tile is idle; flags seen: ' + JSON.stringify(flags.map(f => f.kind)))
  assert.equal(idle.sev, 'med')
})

test('control: holding still on one tile with a small bob (under a block) is idle, as before', () => {
  const ss = ring(125, (i, s) => ({ y: 66 + 0.4 * tri(s), tk: 'autopilot', st: 'exit' }))
  assert.ok(D.analyze(ss, [], now(ss)).some(f => f.kind === 'idle'))
})

test('control: a bot that walks 3 blocks away while it bobs is not idle', () => {
  const ss = ring(125, (i, s) => ({ x: 0.5 + s * 0.03, y: 66 + 1.6 * tri(s), mv: 1, tk: 'autopilot', st: 'exit' }))
  assert.ok(!D.analyze(ss, [], now(ss)).some(f => f.kind === 'idle'))
})
