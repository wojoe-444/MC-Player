// A bot that keeps putting the same kind of question to Walter is blocked: the question becomes a work order, written by code (lib/orders.js `bot-asks`).
const test = require('node:test')
const assert = require('node:assert')
const orders = require('../lib/orders')

const NOW = Date.parse('2026-11-11T15:30:00Z')
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString()
const brief = (minAgo, ask) => ({ at: iso(minAgo), k: 'brief', text: 'plan', focus: ['tool-kit'], holds: [], ask })

test('bot-asks: three questions in a day open an order, opened by code, ranked by a flat cost per question', () => {
  const ev = [brief(600, 'Could you check why tool-kit has not run since 04:23? I hold 14 iron ingots and 13 sticks.'), brief(540, null), brief(480, 'tool-kit has run 0 times; why does it not start?'), brief(60, 'tool-kit ran ok but made no iron pickaxe or ladders. Could you check why?')]
  const c = orders.candidates({ rollup: {}, events: ev }).find(x => x.key === 'bot-asks')
  assert.ok(c, 'three asks make a candidate')
  assert.strictEqual(c.counts.asks, 3)
  assert.strictEqual(c.costMin, 3 * 15)
  assert.ok(c.auto && c.auto.isBug && c.auto.kind === 'bug', 'no model is asked to judge it')
  assert.match(c.auto.problem, /iron pickaxe or ladders/)
  assert.strictEqual(c.evidence.length, 3)
  assert.match(c.evidence[2], /^14:30Z tool-kit ran ok/)                              // newest last, with the time
})

test('bot-asks: one or two questions, empty asks and non-brief events are not a candidate', () => {
  const ev = [brief(300, 'Could you check why tool-kit has not run?'), brief(200, 'A chest near home, please, so stash has a place?'), brief(100, null), brief(50, ''), { at: iso(40), k: 'note', ask: 'this is not a brief event at all' }]
  assert.ok(!orders.candidates({ rollup: {}, events: ev }).some(x => x.key === 'bot-asks'))
})

test('bot-asks: the cost stops growing at a dozen questions', () => {
  const ev = Array.from({ length: 20 }, (_, i) => brief(900 - i * 30, `question number ${i} about the step that never starts`))
  assert.strictEqual(orders.candidates({ rollup: {}, events: ev }).find(x => x.key === 'bot-asks').costMin, 12 * 15)
})
