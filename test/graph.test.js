// P5 + P6: the capability ladder read from the code, and behavior graphs that run inside a single scheduler task.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { catalog } = require('../brain/ladder')
const { createGraph } = require('../brain/graph')
const { Scheduler, PRIORITY } = require('../brain/scheduler')

test('ladder: every rung has members, read from the code', () => {
  const c = catalog()
  assert.ok(c.primitive.includes('goto') && c.primitive.includes('digBlock') && c.primitive.includes('craft'))
  assert.ok(c.skill.includes('fetch') && c.skill.includes('go_down_mine') && c.skill.includes('wall_in'))
  assert.ok(c.goal.includes('eat') && c.goal.includes('night-home') && c.goal.includes('take-cover'))
  assert.deepStrictEqual(c.job.sort(), ['build', 'clearbox', 'excavation', 'lighting', 'mining', 'routines', 'treefarm', 'villagers'])
  assert.deepStrictEqual(c.planner, ['think', 'routine'])
  assert.ok(c.primitive.length > 50 && c.skill.length > 25 && c.goal.length > 30)
})

test('ladder: every planner action is documented and no skill name collides with a job module', () => {
  const c = catalog()
  const th = fs.readFileSync(path.join(__dirname, '..', 'brain', 'autopilot', 'think.js'), 'utf8')
  for (const s of c.skill) assert.ok(new RegExp(`def\\('${s}', '`).test(th), `${s} has no doc string`)
  for (const j of c.job) assert.ok(!c.skill.includes(j), `${j} is both a skill and a job`)
})

function twoStateGraph(file, log = []) {
  return createGraph({
    name: 'demo', file,
    nodes: {
      go: { label: 'go', entry: true, run: async () => { log.push('go'); return 'dig' } },
      dig: { label: 'dig', parent: 'work', run: async (ctx, g) => { log.push('dig'); return ctx.state.n++ >= 1 ? g.done() : 'rest' } },
      rest: { label: 'rest', parent: 'work', run: async () => { log.push('rest'); return 'dig' } },
      work: { label: 'work', type: 'group', run: async () => 'go' }
    },
    edges: [{ from: 'go', to: 'dig', label: 'arrived' }, { from: 'dig', to: 'rest', label: 'tired' }, { from: 'rest', to: 'dig' }]
  })
}

test('graph: runs inside a scheduler task, exports the dashboard contract, and ends with done', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beh-')), 'behavior-tree.json')
  const log = []
  const g = twoStateGraph(file, log)
  const s = new Scheduler({ graceMs: 100 })
  let result
  s.submit({ name: 'demo', priority: PRIORITY.CHAT, state: { n: 0 }, async run(ctx) { result = await g.run(ctx); return result } })
  for (let i = 0; i < 100 && (s.running || s.tasks.some(t => t.status === 'queued')); i++) await new Promise(r => setTimeout(r, 10))
  assert.deepStrictEqual(log, ['go', 'dig', 'rest', 'dig'])
  assert.deepStrictEqual(result, { status: 'done' })
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.strictEqual(doc.machine, 'demo'); assert.deepStrictEqual(doc.nodes.map(n => n.id), ['go', 'dig', 'rest', 'work'])
  assert.strictEqual(doc.nodes.find(n => n.id === 'go').entry, true); assert.strictEqual(doc.nodes.find(n => n.id === 'dig').parent, 'work')
  assert.deepStrictEqual(doc.history.map(h => h.from + '>' + h.to), ['go>dig', 'dig>rest', 'rest>dig'])
  assert.deepStrictEqual(doc.active, [])
  assert.strictEqual(doc.transitions[0].label, 'arrived')
})

test('graph: active path includes the parent chain; an undeclared edge throws (strict)', async () => {
  const g = createGraph({ name: 'x', nodes: { a: { entry: true, run: async () => 'b' }, b: { parent: 'p', run: async (c, gg) => gg.done() }, p: { run: async () => null } }, edges: [{ from: 'a', to: 'b' }] })
  let seen = null
  const orig = g.doc; assert.deepStrictEqual(orig().active, [])
  await g.run({ state: {}, checkpoint() {}, sleep: async () => {} })
  const bad = createGraph({ name: 'bad', nodes: { a: { entry: true, run: async () => 'b' }, b: { run: async () => null } }, edges: [] })
  await assert.rejects(bad.run({ state: {}, checkpoint() {}, sleep: async () => {} }), /no edge a -> b/)
  assert.throws(() => createGraph({ nodes: { a: { run() {} } }, edges: [{ from: 'a', to: 'zzz' }] }), /unknown node/)
  void seen
})

test('graph: a stopped task keeps its state for the export, and a resumed task continues in the same node', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beh-')), 'b.json')
  let calls = 0
  const g = createGraph({ name: 'r', file, nodes: { a: { entry: true, run: async () => 'b' }, b: { run: async (ctx, gg) => { calls++; return gg.done() } } }, edges: [{ from: 'a', to: 'b' }] })
  const st = {}
  let n = 0
  await assert.rejects(g.run({ state: st, checkpoint() { if (++n === 2) throw new Error('aborted: stop') }, sleep: async () => {} }), /aborted/)
  assert.strictEqual(st.behavior, 'b'); assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).active[0], 'b')
  const r = await g.run({ state: st, resumed: true, checkpoint() {}, sleep: async () => {} })
  assert.deepStrictEqual(r, { status: 'done' }); assert.strictEqual(calls, 1, 'resumed in b, did not run a again')
})
