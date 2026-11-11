// brain/memory/brief.js: a bot that asked Walter something and heard nothing does not get to ask it again (2026-11-11: 19 questions in a day, mostly one question reworded).
const test = require('node:test')
const assert = require('node:assert/strict')
const B = require('../brain/memory/brief')

const NOW = Date.parse('2026-11-11T16:00:00Z')
const opts = (lastAsk) => ({ steps: ['tool-kit', 'iron', 'stash'], day: 3, now: NOW, id: 'x-1', model: 'm', lastAsk })
const ans = (ask) => ({ intent: 'plan', focus: ['tool-kit'], holds: [], freeTime: { choice: 'home', note: '' }, ask, memory: { now: 'n', projects: null, addPolicies: [], addTraps: [], remove: [] } })
const asked = (text, minAgo) => ({ text, at: NOW - minAgo * 60000 })

test('the same question reworded within twelve hours is dropped, with a reason the bot sees next brief', () => {
  const prev = asked('Could you check why tool-kit has not run since 04:23? I have 14 iron ingots and 13 sticks for the iron pick and 3 ladders.', 60)
  const v = B.validate(ans('tool-kit has run 0 times, though the iron pick and 3 ladders can be made from what I carry. Could you check what stops it from starting?'), opts(prev))
  assert.equal(v.brief.ask, null)
  assert.match(v.dropped.join('\n'), /you asked this at 15:00Z and Walter has not answered/)
})

test('a different question goes through, and so does the same one after twelve hours or when nothing was asked before', () => {
  const prev = asked('Could you check why tool-kit has not run since 04:23?', 60)
  assert.match(B.validate(ans('Where should the new mob farm go, north or south of the river?'), opts(prev)).brief.ask, /mob farm/)
  assert.match(B.validate(ans('Could you check why tool-kit has not run since 04:23?'), opts(asked('Could you check why tool-kit has not run since 04:23?', 13 * 60))).brief.ask, /tool-kit/)
  assert.match(B.validate(ans('Could you check why tool-kit has not run?'), opts(null)).brief.ask, /tool-kit/)
  assert.equal(B.validate(ans(null), opts(prev)).brief.ask, null)
})

test('similarAsk compares words of four letters or more as sets', () => {
  assert.ok(B.similarAsk('Could you place a private chest near home?', 'A private chest at the storage-room spot near home?'))
  assert.ok(!B.similarAsk('Could you spare 3 iron ingots?', 'Could you place a private chest near home?'))
  assert.ok(!B.similarAsk('', 'anything at all here'))
})
