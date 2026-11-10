const test = require('node:test')
const assert = require('node:assert')
const { Scheduler, PRIORITY, AbortError } = require('../brain/scheduler')

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const mk = (o = {}) => new Scheduler({ graceMs: 200, idleAfterMs: 0, ...o })

test('higher priority preempts, lower resumes with same state', async () => {
  const s = mk(), log = []
  s.submit({ name: 'dig', priority: PRIORITY.EXCAVATE, state: { n: 0 }, async run(ctx) {
    log.push(ctx.resumed ? 'dig-resume' : 'dig-start')
    while (ctx.state.n < 5) { await ctx.sleep(20); ctx.state.n++ }
    log.push('dig-done')
  } })
  await wait(50)
  s.submit({ name: 'eat', priority: PRIORITY.EAT, async run(ctx) { log.push('eat'); await ctx.sleep(30) } })
  await wait(400)
  assert.deepStrictEqual(log, ['dig-start', 'eat', 'dig-resume', 'dig-done'])
  assert.ok(s.idle())
})

test('equal priority does not preempt, runs FIFO', async () => {
  const s = mk(), log = []
  s.submit({ name: 'a', priority: 50, async run(c) { await c.sleep(30); log.push('a') } })
  s.submit({ name: 'b', priority: 50, async run(c) { log.push('b') } })
  await wait(150)
  assert.deepStrictEqual(log, ['a', 'b'])
})

test('legacy task without ctx is stopped through abort hook', async () => {
  const s = mk(), log = []
  let stop = false
  s.submit({ name: 'legacy', priority: 10, abort: () => { stop = true }, async run() {
    log.push('legacy-run' + (stop ? '-again' : ''))
    stop = false
    await wait(80); // pretend atomic step
    if (stop) log.push('legacy-stopped')
  } })
  await wait(20)
  s.submit({ name: 'hi', priority: 90, run: async () => { log.push('hi') } })
  await wait(300)
  assert.ok(log.includes('legacy-stopped'))
  assert.ok(log.indexOf('hi') > log.indexOf('legacy-stopped'))
  assert.ok(log.filter(x => x.startsWith('legacy-run')).length === 2, 'resumed after the high-priority task')
})

test('stuck task is detached after grace period', async () => {
  const s = mk({ graceMs: 60 }), log = []
  s.submit({ name: 'stuck', priority: 10, run: () => new Promise(() => {}) })
  await wait(10)
  s.submit({ name: 'urgent', priority: 99, run: async () => { log.push('urgent') } })
  await wait(200)
  assert.deepStrictEqual(log, ['urgent'])
})

test('userStop parks routine tasks and cancels chat tasks', async () => {
  const s = mk()
  s.routine({ name: 'furnace', priority: PRIORITY.FURNACE, defaultEnabled: true, intervalMs: 1, due: () => true, make: () => ({ async run(ctx) { await ctx.sleep(5000) } }) })
  s.tick(); await wait(30)
  assert.strictEqual(s.running.name, 'furnace')
  s.userStop(); await wait(30)
  assert.strictEqual(s.running, null)
  assert.strictEqual(s.status().parked.length, 1)
  s.tick(); await wait(20)
  assert.strictEqual(s.running, null, 'parked routine task must not restart on its own')
  assert.strictEqual(s.resumeParked(), 1)
  await wait(30)
  assert.strictEqual(s.running.name, 'furnace')
  s.userStop()
})

test('routines are disabled until enabled (Walter go)', async () => {
  const s = mk(); let made = 0
  s.routine({ name: 'excavation', priority: 10, intervalMs: 1, due: () => true, make: () => { made++; return { run: async () => {} } } })
  s.tick(); await wait(10)
  assert.strictEqual(made, 0)
  s.setEnabled('excavation', true)
  s.tick(); await wait(20)
  assert.strictEqual(made, 1)
})

test('idleOnly tasks yield when Walter chats and wait for quiet time', async () => {
  let t = 1000000
  const s = new Scheduler({ now: () => t, idleAfterMs: 180000, graceMs: 200 })
  const log = []
  s.noteChat()
  s.submit({ name: 'idle-job', priority: 30, idleOnly: true, async run(ctx) { log.push(ctx.resumed ? 'resume' : 'start'); await ctx.sleep(10); log.push('end') } })
  await wait(20)
  assert.deepStrictEqual(log, [], 'must not start right after chat')
  t += 181000; s.pump(); await wait(40)
  assert.deepStrictEqual(log, ['start', 'end'])
})

test('running idleOnly task is preempted by chat', async () => {
  let t = 1000000
  const s = new Scheduler({ now: () => t, idleAfterMs: 1000, graceMs: 200 })
  const log = []
  s.submit({ name: 'idle-job', priority: 30, idleOnly: true, async run(ctx) { log.push(ctx.resumed ? 'resume' : 'start'); await ctx.sleep(5000) } })
  t += 5000; s.pump(); await wait(20)
  assert.deepStrictEqual(log, ['start'])
  s.noteChat(); await wait(30)
  assert.strictEqual(s.running, null)
  assert.strictEqual(s.tasks[0].status, 'paused')
  t += 2000; s.pump(); await wait(20)
  assert.deepStrictEqual(log, ['start', 'resume'])
  s.cancel('idle-job'); await wait(20)
})

test('retry and park results', async () => {
  const s = mk(); let n = 0
  s.submit({ name: 'flaky', priority: 20, async run() { n++; return n < 2 ? { status: 'retry', afterMs: 30 } : { status: 'park', reason: 'needs go' } } })
  await wait(150)
  assert.strictEqual(n, 2)
  // a task that parks itself is retried with a growing delay (paused in the queue); only Walter's own stop parks for good
  assert.strictEqual(s.status().queue.find(t => t.name === 'flaky').parkReason, 'needs go')
})

test('failed task is reported and does not block the queue', async () => {
  const s = mk(), log = []
  s.on('failed', (t, e) => log.push('failed:' + e.message))
  s.submit({ name: 'boom', priority: 50, run: async () => { throw new Error('x') } })
  s.submit({ name: 'next', priority: 10, run: async () => { log.push('next') } })
  await wait(80)
  assert.deepStrictEqual(log, ['failed:x', 'next'])
})

test('singleton key: resubmitting returns the existing task', () => {
  const s = mk()
  const a = s.submit({ name: 'furnace', priority: 30, run: async (c) => c.sleep(1000) })
  const b = s.submit({ name: 'furnace', priority: 30, run: async () => {} })
  assert.strictEqual(a, b)
  s.cancel('furnace')
})

test('a task bumped by a safety task waits out a cooldown before resuming (no thrash)', async () => {
  const s = new Scheduler({ graceMs: 200, idleAfterMs: 0, safetyCooldownMs: 150 })
  const log = []
  s.submit({ name: 'furnace', priority: PRIORITY.FURNACE, async run(ctx) { log.push(ctx.resumed ? 'resume' : 'start'); await ctx.sleep(5000) } })
  await wait(30)
  s.submit({ name: 'safety', priority: PRIORITY.SAFETY, preemptible: false, async run(ctx) { await ctx.sleep(20) } })
  await wait(80)
  assert.deepStrictEqual(log, ['start'], 'must not resume immediately after safety')
  await wait(200)
  assert.deepStrictEqual(log, ['start', 'resume'])
  s.cancel('furnace'); await wait(30)
})

test('non-safety preemption resumes immediately', async () => {
  const s = new Scheduler({ graceMs: 200, idleAfterMs: 0, safetyCooldownMs: 5000 })
  const log = []
  s.submit({ name: 'dig', priority: PRIORITY.EXCAVATE, async run(ctx) { log.push(ctx.resumed ? 'resume' : 'start'); await ctx.sleep(5000) } })
  await wait(30)
  s.submit({ name: 'eat', priority: PRIORITY.EAT, async run(ctx) { await ctx.sleep(20) } })
  await wait(150)
  assert.deepStrictEqual(log, ['start', 'resume'])
  s.cancel('dig'); await wait(30)
})

test('talk delays starting idle jobs but never aborts a running one; a real command (noteChat) does', async () => {
  let t = 1000000
  const s = new Scheduler({ now: () => t, idleAfterMs: 1000, graceMs: 200 })
  const log = []
  s.submit({ name: 'idle-job', priority: 30, idleOnly: true, async run(ctx) { log.push(ctx.resumed ? 'resume' : 'start'); await ctx.sleep(5000) } })
  t += 5000; s.pump(); await wait(20)
  assert.deepStrictEqual(log, ['start'])
  s.noteTalk(); await wait(30)
  assert.strictEqual(s.running && s.running.name, 'idle-job', 'conversation must not abort the running job')
  s.noteChat(); await wait(30)
  assert.strictEqual(s.running, null, 'a real command aborts it')
  t += 500; s.pump(); await wait(20)
  assert.deepStrictEqual(log, ['start'], 'still inside the quiet window')
  t += 1500; s.pump(); await wait(20)
  assert.deepStrictEqual(log, ['start', 'resume'])
  s.cancel('idle-job'); await wait(20)
})

test('talk before an idle job is queued delays its start by the quiet window', async () => {
  let t = 1000000
  const s = new Scheduler({ now: () => t, idleAfterMs: 1000, graceMs: 200 })
  const log = []
  s.noteTalk()
  s.submit({ name: 'idle-job', priority: 30, idleOnly: true, async run() { log.push('ran') } })
  await wait(20); assert.deepStrictEqual(log, [])
  t += 1500; s.pump(); await wait(20)
  assert.deepStrictEqual(log, ['ran'])
})

test('linger: after a CHAT task finishes, background tasks wait; safety/sleep and later chat work are not held', async () => {
  let n = 1000000
  const s = new Scheduler({ now: () => n, graceMs: 200, idleAfterMs: 0, lingerMs: 1000 })
  const log = []
  s.submit({ name: 'furnace', priority: PRIORITY.FURNACE, async run(ctx) { log.push(ctx.resumed ? 'f-resume' : 'f-start'); await ctx.sleep(5000) } })
  await wait(20)
  s.submit({ name: 'nav', priority: PRIORITY.CHAT, async run() { log.push('nav') } })
  await wait(60)
  assert.deepStrictEqual(log, ['f-start', 'nav'], 'furnace must not resume the instant the walk ends')
  s.submit({ name: 'sleep', priority: PRIORITY.SLEEP, async run() { log.push('sleep') } })
  await wait(40)
  assert.ok(log.includes('sleep'), 'higher priority work is not held')
  n += 1500; s.pump(); await wait(30)
  assert.deepStrictEqual(log.filter(x => x.startsWith('f-')), ['f-start', 'f-resume'])
  s.cancel('furnace'); await wait(20)
})

test('outing priority sits between chat and the idle routines and ignores the linger hold', () => {
  assert.ok(PRIORITY.OUTING < PRIORITY.CHAT && PRIORITY.OUTING > PRIORITY.FARM)
})

test('walks queue behind each other and run back to back; a follow is replaced by the next order; stop clears the queue', async () => {
  const s = new Scheduler({ graceMs: 200, idleAfterMs: 0 })
  const log = []
  const walk = (name, label, ms, dynamic = false) => s.submit({ name: 'nav', key: 'nav', replace: true, priority: PRIORITY.CHAT, state: { dynamic, label }, onUserStop: 'cancel', async run(ctx) { log.push('start ' + label); await ctx.sleep(ms); log.push('end ' + label) } })
  s.submit({ name: 'furnace', priority: PRIORITY.FURNACE, async run(ctx) { log.push(ctx.resumed ? 'furnace-resume' : 'furnace-start'); await ctx.sleep(5000) } })
  await wait(20)
  walk('nav', 'A', 60); walk('nav', 'B', 60); walk('nav', 'C', 60)
  await wait(400)
  assert.deepStrictEqual(log.filter(x => !x.startsWith('furnace')), ['start A', 'end A', 'start B', 'end B', 'start C', 'end C'])
  assert.strictEqual(log[log.length - 1], 'furnace-resume', 'routines resume only after the whole queue drained')
  // a follow is replaced
  walk('nav', 'F', 5000, true); await wait(30)
  walk('nav', 'D', 30); await wait(120)
  assert.ok(log.includes('start D') && log.includes('end D'))
  // stop clears everything queued
  walk('nav', 'X', 5000); walk('nav', 'Y', 5000); await wait(30)
  s.userStop(); await wait(60)
  assert.strictEqual(s.tasks.filter(t => t.name === 'nav').length, 0)
  s.cancel('furnace'); await wait(20)
})

test('focus: boosts a named task above the rest, ends when it is done, hands back to the queue', async () => {
  const s = new Scheduler({ graceMs: 200, idleAfterMs: 0 })
  const log = []
  s.submit({ name: 'excavation', priority: PRIORITY.EXCAVATE, async run(ctx) { log.push(ctx.resumed ? 'exc-resume' : 'exc-start'); await ctx.sleep(5000) } })
  await wait(20)
  s.submit({ name: 'mining', priority: 5, async run(ctx) { log.push('mining-start'); await ctx.sleep(120); log.push('mining-done') } })
  await wait(30)
  assert.deepStrictEqual(log, ['exc-start'], 'mining is below excavation')
  const id = s.focus({ task: 'mining', priority: 60, note: 'do the iron first' })
  await wait(250)
  assert.deepStrictEqual(log, ['exc-start', 'mining-start', 'mining-done', 'exc-resume'])
  assert.strictEqual(s.focusList().length, 0, 'the focus ended with the task')
  s.cancel('excavation'); await wait(20)
})

test('focus on a task that does not exist yet applies when it appears; until-time expires; suppress holds others; clear works', async () => {
  let n = 1000000
  const s = new Scheduler({ now: () => n, graceMs: 200, idleAfterMs: 0 })
  const log = []
  s.submit({ name: 'furnace', priority: PRIORITY.FURNACE, async run(ctx) { log.push('furnace'); await ctx.sleep(5000) } })
  await wait(20)
  const id = s.focus({ task: 'build', priority: 60, until: 60000, note: 'tower now', suppress: ['furnace'] })
  await wait(40)
  assert.strictEqual(s.running, null, 'the suppressed furnace stops and nothing else is running yet')
  s.submit({ name: 'build', priority: PRIORITY.OUTING, async run(ctx) { log.push('build'); await ctx.sleep(5000) } })
  await wait(30)
  assert.strictEqual(s.running.name, 'build')
  assert.strictEqual(s.status().focuses[0].note, 'tower now')
  n += 61000; s.pump(); await wait(20)
  assert.strictEqual(s.focusList().length, 0, 'time is up')
  // build (p45) now outranks the furnace (p30) anyway, and the furnace resumes once it finishes
  s.focus({ task: 'build', priority: 60 }); assert.strictEqual(s.clearFocus('build'), 1); assert.strictEqual(s.focusList().length, 0)
  s.cancel('build'); s.cancel('furnace'); await wait(30)
})

test('focus with resumePrevious:false cancels what was running; a parked task is unparked by a focus', async () => {
  const s = new Scheduler({ graceMs: 200, idleAfterMs: 0 })
  const log = []
  s.submit({ name: 'old', priority: 20, async run(ctx) { log.push('old'); await ctx.sleep(5000) } })
  let digRuns = 0
  s.submit({ name: 'dig', priority: 10, onUserStop: 'park', async run(ctx) { if (digRuns++ === 0) return { status: 'park', reason: 'needs go' }; await ctx.sleep(3000) } })
  await wait(40)
  s.submit({ name: 'new', priority: 5, async run(ctx) { log.push('new'); await ctx.sleep(80) } })
  s.focus({ task: 'new', priority: 70, resumePrevious: false })
  await wait(250)
  assert.ok(log.includes('new'))
  assert.ok(!s.tasks.some(t => t.name === 'old'), 'the old task was cancelled, not paused')
  s.focus({ task: 'dig', priority: 60 }); await wait(60)
  assert.strictEqual(s.status().parked.length, 0, 'the focus took the parked task out of the parked list')
  s.userStop(); await wait(30)
})

test('focus cannot outrank safety, and bad arguments are rejected', () => {
  const s = new Scheduler({})
  assert.throws(() => s.focus({}), /task name/)
  assert.throws(() => s.focus({ task: 'x', until: 'tomorrow' }), /until/)
  s.focus({ task: 'x', priority: 500 })
  assert.ok(s.focusList()[0].priority < PRIORITY.SAFETY)
})

test('outdoor gate: build/mining/treefarm wait for daylight/health/no mobs, an override skips it, a focus does not, running ones pause when it closes', async () => {
  let n = 1000000, ok = false, why = 'daylight'
  const s = new Scheduler({ now: () => n, graceMs: 200, idleAfterMs: 0, gateMinHoldMs: 0 })
  s.setGate({ names: new Set(['mining']), check: () => (ok ? true : { ok: false, reason: why }) })
  const log = [], holds = []
  s.on('gate-hold', (t, r) => holds.push(t.name + ':' + r))
  s.submit({ name: 'mining', priority: 11, async run(ctx) { log.push(ctx.resumed ? 'mine-resume' : 'mine-start'); await ctx.sleep(5000) } })
  s.submit({ name: 'furnace', priority: 9, async run(ctx) { log.push('furnace'); await ctx.sleep(30) } })
  await wait(80)
  assert.deepStrictEqual(log, ['furnace'], 'mining is held at night, the indoor job still runs')
  assert.deepStrictEqual(holds, ['mining:daylight'], 'announced once')
  n += 900; s.pump(); await wait(10); assert.strictEqual(holds.length, 1, 'not announced again for the same reason')
  ok = true; n += 1000; s.pump(); await wait(40)
  assert.strictEqual(s.running && s.running.name, 'mining')
  ok = false; why = 'my health is back'; n += 1000; s.pump(); await wait(40)
  assert.strictEqual(s.running, null, 'a running outdoor task pauses when the gate closes')
  s.gateOverride(60000); await wait(40)
  assert.strictEqual(s.running && s.running.name, 'mining', 'override lifts it')
  s.cancel('mining'); await wait(20)
  n += 70000
  s.submit({ name: 'mining', priority: 11, async run(ctx) { log.push('mine2'); await ctx.sleep(30) } }); await wait(30)
  assert.ok(!log.includes('mine2'), 'override expired, held again')
  s.focus({ task: 'mining', priority: 60 }); await wait(60)
  assert.ok(!log.includes('mine2'), 'a focus does not lift the gate: at night the focused job waits for dawn')
  s.gateOverride(60000); await wait(60)
  assert.ok(log.includes('mine2'), 'only an explicit override does')
})

test('focus keeps background routines behind it (only safety, sleep, eat and chat tasks go ahead), and lets them back when it ends', async () => {
  const s = new Scheduler({ graceMs: 200, idleAfterMs: 0 })
  const log = []
  s.focus({ task: 'build', priority: 60 })      // the focused job does not exist yet (held at night, say)
  s.submit({ name: 'farm', priority: PRIORITY.FARM, async run(ctx) { log.push('farm'); await ctx.sleep(30) } })
  await wait(80)
  assert.deepStrictEqual(log, [], 'the farm routine waits behind the focus even though the focused task is not running')
  s.submit({ name: 'craft', priority: PRIORITY.CHAT, async run() { log.push('craft') } }); await wait(40)
  assert.deepStrictEqual(log, ['craft'], "Walter's own chat tasks still go ahead")
  s.submit({ name: 'sleep', priority: PRIORITY.SLEEP, async run() { log.push('sleep') } }); await wait(40)
  assert.ok(log.includes('sleep'))
  s.clearFocus(); await wait(60)
  assert.ok(log.includes('farm'), 'routines are back once the focus is gone')
})

test('focus chain: tower, then mine iron; the next goal starts by itself with its command, and the chain is dropped when the job is cancelled', async () => {
  const s = new Scheduler({ graceMs: 200, idleAfterMs: 0 })
  const cmds = []
  s.on('focus-command', (next) => cmds.push(next.command))
  s.submit({ name: 'build', priority: 45, async run(ctx) { await ctx.sleep(40) } })
  s.focus({ task: 'build', priority: 60, note: 'tower', then: [{ task: 'mining', command: 'mine iron 16', note: 'iron' }, { task: 'excavation', command: 'resume excavation', note: 'dig' }] })
  await wait(120)
  assert.deepStrictEqual(cmds, ['mine iron 16'])
  assert.strictEqual(s.focusList()[0].task, 'mining')
  assert.deepStrictEqual(s.focusList()[0].next, ['dig'])
  s.submit({ name: 'mining', priority: 11, async run(ctx) { await ctx.sleep(40) } }); await wait(120)
  assert.deepStrictEqual(cmds, ['mine iron 16', 'resume excavation'])
  // cancelling the focused job drops the rest of the chain
  s.clearFocus()
  s.submit({ name: 'build', priority: 45, async run(ctx) { await ctx.sleep(3000) } })
  s.focus({ task: 'build', priority: 60, then: [{ task: 'mining', command: 'mine iron 16' }] }); await wait(30)
  s.cancel('build'); await wait(60)
  assert.deepStrictEqual(cmds, ['mine iron 16', 'resume excavation'], 'cancelled job: chain not continued')
})

test('focuses are saved to a file and restored (with their goal chain) after a restart; expired ones are dropped', async () => {
  const f = require('path').join(require('os').tmpdir(), 'focus-' + Date.now() + '.json')
  let n = 1000000
  const a = new Scheduler({ now: () => n, focusFile: f, graceMs: 200 })
  a.focus({ task: 'build', priority: 60, note: 'tower', command: 'build tower', then: [{ task: 'mining', command: 'mine iron 16', note: 'iron' }] })
  a.focus({ task: 'mining', priority: 55, until: 1000 })      // short: expires before the restart
  const b = new Scheduler({ now: () => n + 5000, focusFile: f, graceMs: 200 })
  const list = b.focusList()
  assert.deepStrictEqual(list.map(x => x.task), ['build'])
  assert.strictEqual(list[0].command, 'build tower')
  assert.deepStrictEqual(list[0].next, ['iron'])
  b.clearFocus(); assert.deepStrictEqual(JSON.parse(require('fs').readFileSync(f, 'utf8')), [])
  require('fs').unlinkSync(f)
})

test('gate hysteresis: a held task stays held for the minimum hold even if the answer flaps, with one announcement and no ping-pong with other tasks', async () => {
  let n = 1000000, ok = false
  const s = new Scheduler({ now: () => n, graceMs: 200, idleAfterMs: 0, gateMinHoldMs: 5000 })
  s.setGate({ names: new Set(['build']), check: () => (ok ? true : { ok: false, reason: 'daylight' }) })
  const log = [], holds = []
  s.on('gate-hold', (t) => holds.push(t.name))
  s.submit({ name: 'build', priority: 45, async run(ctx) { log.push('build'); await ctx.sleep(3000) } })
  s.submit({ name: 'excavation', priority: 10, async run(ctx) { log.push(ctx.resumed ? 'exc-resume' : 'exc'); await ctx.sleep(3000) } })
  await wait(60)
  assert.deepStrictEqual(log, ['exc'])
  // the answer flaps every second (the bot moves between sky and cave): build must not start/stop each time
  for (let i = 0; i < 6; i++) { ok = !ok; n += 1000; s.pump(); await wait(15) }
  assert.deepStrictEqual(log, ['exc'], 'still held, excavation untouched')
  assert.deepStrictEqual(holds, ['build'], 'announced once')
  ok = true; n += 6000; s.pump(); await wait(40)
  assert.strictEqual(s.running && s.running.name, 'build', 'after the minimum hold and a clear gate it starts')
  s.cancel('build'); s.cancel('excavation'); await wait(30)
})

test('ghost focus: a focus whose job vanished does not keep the bot idle (the stale manual focus of 04:35)', async () => {
  let n = 1000000
  const s = new Scheduler({ now: () => n, graceMs: 200, idleAfterMs: 0 })
  const log = []
  s.submit({ name: 'manual', priority: 49, async run(ctx) { await ctx.sleep(20) } })
  await wait(10)
  s.focus({ task: 'manual', priority: 48, until: 30 * 60000 })
  s.submit({ name: 'excavation', priority: 10, async run(ctx) { log.push('exc'); await ctx.sleep(500) } })
  await wait(60)
  assert.deepStrictEqual(log, [], 'behind the live focus while manual exists')
  await wait(60)                          // manual finished; the focus is a ghost now but still inside the 5 s grace
  n += 6000; s.pump(); await wait(40)
  assert.deepStrictEqual(log, ['exc'], 'after the grace the ghost focus is dropped and routines run again')
  assert.strictEqual(s.focusList().length, 0)
  s.cancel('excavation'); await wait(20)
})

test('a focus whose task never appears ends after the unseen limit; a saved manual focus is not restored after a restart', async () => {
  let n = 1000000
  const s = new Scheduler({ now: () => n, graceMs: 200, ghostUnseenMs: 1000 })
  s.focus({ task: 'build', priority: 60 })
  n += 2000; assert.strictEqual(s.focusList().length, 0)
  const f = require('path').join(require('os').tmpdir(), 'focus2-' + Date.now() + '.json')
  require('fs').writeFileSync(f, JSON.stringify([{ task: 'manual', priority: 48, until: n + 99999, suppress: [], then: [] }, { task: 'build', priority: 60, until: n + 99999, suppress: [], then: [] }]))
  const b = new Scheduler({ now: () => n, focusFile: f, graceMs: 200 })
  assert.deepStrictEqual(b.focusList().map(x => x.task), ['build'])
  require('fs').unlinkSync(f)
})
