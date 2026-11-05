const test = require('node:test')
const assert = require('node:assert')
const { wrap, normalize, classify, line } = require('../brain/pilot-kit/result')

test('legacy {ok, note, extra} keeps the note and moves extras under data', async () => {
  const r = await wrap('craft', async () => ({ ok: true, note: 'crafted 4 planks', n: 4 }), { level: 'skill' })()
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.cmd, 'craft')
  assert.strictEqual(r.note, 'crafted 4 planks')
  assert.deepStrictEqual(r.data, { n: 4 })
  assert.strictEqual(r.level, 'skill')
  assert.strictEqual(typeof r.ms, 'number')
})

test('plain returns are normalised', () => {
  assert.strictEqual(normalize('a', undefined, 1).ok, true)
  assert.strictEqual(normalize('a', true, 1).ok, true)
  assert.strictEqual(normalize('a', 'done', 1).note, 'done')
  const f = normalize('a', false, 1)
  assert.strictEqual(f.ok, false)
  assert.strictEqual(f.error.code, 'FAILED')
})

test('thrown errors become failed envelopes with a code', async () => {
  const r = await wrap('goto', async () => { throw new Error('no path to the chest') })()
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.error.code, 'NO_PATH')
})

test('AbortError is rethrown so the scheduler can stop the skill', async () => {
  const fn = wrap('x', async () => { const e = new Error('stop'); e.name = 'AbortError'; throw e })
  await assert.rejects(fn(), (e) => e.name === 'AbortError')
})

test('classification of common failure messages', () => {
  assert.strictEqual(classify('not enough cobblestone'), 'NO_ITEM')
  assert.strictEqual(classify('lava next to the path'), 'UNSAFE')
  assert.strictEqual(classify('timed out after 30s'), 'TIMEOUT')
  assert.strictEqual(classify('invalid item name'), 'BAD_ARGS')
  assert.strictEqual(classify('too dark to mine'), 'NOT_READY')
  assert.strictEqual(classify('something odd'), 'UNKNOWN')
})

test('failed legacy result keeps its reason and gets a code', () => {
  const r = normalize('stash', { ok: false, note: 'not enough cobblestone' }, 5)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.error.code, 'NO_ITEM')
  assert.match(line(r), /stash FAILED NO_ITEM/)
})
