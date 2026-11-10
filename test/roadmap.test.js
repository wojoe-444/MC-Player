// brain/roadmap predicates and tools/digest.js
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const { PREDICATES, loadFacts, evaluate } = require('../brain/roadmap/predicates')
const { buildDigest } = require('../tools/digest')

test('predicates: no records means unmeasured or open, never done; records flip them; ids are unique and match ROADMAP phases', () => {
  const empty = evaluate(loadFacts('/nonexistent-state', '/nonexistent-dir'))
  assert.ok(empty.items.every(i => i.status !== 'done'))
  assert.ok(empty.items.filter(i => i.status === 'unmeasured').every(i => i.needs))
  assert.strictEqual(new Set(PREDICATES.map(p => p.id)).size, PREDICATES.length)
  const facts = { autopilot: { home: [1, 70, 2], shelterDoor: [3, 70, 3] }, mining: { mines: [{ id: 'a' }] }, treefarm: { sites: [{}], stats: { planted: 4 } }, mobfarm: { killBox: {}, chests: [[1, 2, 3]] }, husbandry: { pens: [{ built: true, lit: true }], lichen: [{ last: { faces: 4 } }] }, waypoints: { 'Storage room': { x: 1 } }, crafting: null, chestIndex: null }
  const r = evaluate(facts); const by = Object.fromEntries(r.items.map(i => [i.id, i.status]))
  for (const id of ['1.home', '1.shelter', '2.1.shaft', '2.4.treefarm', '2.8.mobfarm', '2.2.storage', '2.9.pens', '2.11.lichen']) assert.strictEqual(by[id], 'done', id)
  assert.strictEqual(by['2.1.ladder'], 'unmeasured'); assert.strictEqual(by['2.2.resetchest'], 'unmeasured')
  assert.deepStrictEqual(r.phases['1'], { total: 2, measured: 2, done: 2 })
})

test('a predicate that throws is unmeasured, not a crash; loadFacts reads the real files', () => {
  assert.strictEqual(evaluate({}, [{ id: 'x', phase: '1', title: 't', check: () => { throw new Error('boom') }, needs: 'n' }]).items[0].status, 'unmeasured')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-')); fs.mkdirSync(path.join(dir, 'state'))
  fs.writeFileSync(path.join(dir, 'state', 'mining-state.json'), JSON.stringify({ mines: [{}] })); fs.writeFileSync(path.join(dir, 'waypoints.json'), JSON.stringify([{ name: 'Storage' }]))
  const f = loadFacts(path.join(dir, 'state'), dir); const by = Object.fromEntries(evaluate(f).items.map(i => [i.id, i.status]))
  assert.strictEqual(by['2.1.shaft'], 'done'); assert.strictEqual(by['2.2.storage'], 'done')
})

test('digest: one short message by exception; sections for what is absent are left out; at most one question', () => {
  const now = Date.parse('2026-11-11T08:00:00Z')
  const md = buildDigest({
    now, roadmap: { phases: { 2: { total: 12, measured: 5, done: 3 } }, items: [{ status: 'open', title: 'Mob farm has a kill box and a chest' }] },
    flags: [{ at: '2026-11-11T05:00:00Z', kind: 'pillaring' }, { at: '2026-11-11T06:00:00Z', kind: 'pillaring' }, { at: '2026-11-09T06:00:00Z', kind: 'old' }],
    gate: { rules: { permit: { mode: 'log', violations: 4, blocked: 0, sites: { 'brain/x.js:9': 3 } }, noArmor: { mode: 'enforce', violations: 0, sites: {} } } },
    deploys: [{ t: now - 3600000, event: 'deploy', to: 'abc123456' }, { t: now - 1800000, event: 'revert', from: 'abc123456' }],
    question: 'Should the bot keep the cobblestone wall?\nsecond line'
  })
  assert.match(md, /Phase 2: 3 done of 5 measured \(7 of 12/); assert.match(md, /pillaring 2/); assert.ok(!md.includes('old 1'))
  assert.match(md, /permit \[log\]: 4, mostly brain\/x.js:9/); assert.ok(!md.includes('noArmor'))
  assert.match(md, /promoted 1 .*reverted itself 1/); assert.match(md, /One question\n- Should the bot keep the cobblestone wall\?$/m); assert.ok(!md.includes('second line'))
  assert.ok(!md.includes('movement key') && !md.includes('ping-pong'))
  assert.ok(md.split('\n').length < 25)
})
