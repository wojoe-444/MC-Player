// Priority task scheduler for the bot. One task runs at a time (the bot has one body).
// Higher priority preempts lower: the running task is asked to stop, parked as "paused" and resumed later by calling
// run() again with ctx.resumed = true and the same ctx.state object.
//
//   task def: { name, priority, run(ctx), abort?(reason), idleOnly?, onUserStop?: 'cancel'|'park', preemptible?, key? }
//   ctx:      { aborted, reason, resumed, state, sleep(ms), checkpoint(), progress(text), task }
//   run() may return undefined/{status:'done'}, {status:'park', reason} (needs Walter's go) or {status:'retry', afterMs}.
//   A task that does not look at ctx at all can still be stopped through def.abort(reason); if it does not settle within
//   graceMs the scheduler detaches from it so one stuck task cannot freeze everything.
//
// Routines are background jobs that spawn tasks when due(); they are disabled until Walter gives the go (see setEnabled).
// A routine may carry enabledFn() to follow an external flag (the driver's routine-state.json) instead of the persisted one.
const EventEmitter = require('events')
const fs = require('fs')

// Priority numbers, named. Every number the brain uses has a name here and keeps its old value (P2 of the taxonomy: no behavior change).
// The first nine keys are the original ones; the rest used to be bare literals in safety/, autopilot/, pilot/ and villagers/.
const PRIORITY = {
  SAFETY: 100,       // safety tasks: never stopped by chat, preempt everything
  RETREAT: 90,       // watchdog cave retreat (wd-retreat)
  SLEEP: 80,         // go to bed
  EAT: 70,           // eating
  SHELTER: 70,       // watchdog forced shelter walk (wd-shelter)
  NIGHT: 60,         // night-shelter routine; also the default priority of a focus
  FOCUS: 60,         // default effective priority of scheduler.focus()
  CHAT: 50,          // anything Walter asked for in chat
  MANUAL: 49,        // the manual driver session (CHAT - 1)
  MANUAL_FOCUS: 48,  // the focus the manual driver takes while it runs
  OUTING: 45,        // visit-and-look trips
  AUTOPILOT: 45,     // the autopilot's own goals (autonomous stance)
  FARM: 40,          // idle farm / treefarm routines
  UPKEEP: 35,        // villager upkeep
  FURNACE: 30,       // furnace upkeep
  BAGROOM: 12,       // bag-room routine, runs at the next gap above mining (EXCAVATE + 2)
  EXCAVATE: 10,      // excavation, mining, lighting
  MINING_ORDER: 11,  // mining started by an explicit order (EXCAVATE + 1)
  FURNACE_IDLE: 9,   // idle furnace upkeep when not overdue (EXCAVATE - 1)
  IDLE: 1
}
// Coarse bands for display and reasoning ("reflex-grade", "needs", ...). Only names: the scheduler still compares plain numbers.
const BANDS = [
  { name: 'reflex', min: 90, desc: 'safety-grade tasks that protect the bot; chat cannot stop them' },
  { name: 'needs', min: 60, desc: 'sleep, eat, shelter at night' },
  { name: 'request', min: 46, desc: 'what Walter asked for in chat, and the manual driver' },
  { name: 'play', min: 41, desc: 'the autopilot playing its own goals, outings' },
  { name: 'routine', min: 11, desc: 'idle routines: farm, villager upkeep, furnace' },
  { name: 'background', min: 0, desc: 'excavation, mining, lighting and idle chores' }
]
const bandOf = (p) => { const n = Number(p) || 0; return (BANDS.find(b => n >= b.min) || BANDS[BANDS.length - 1]).name }

class AbortError extends Error {
  constructor(reason) { super(`aborted: ${reason}`); this.name = 'AbortError'; this.reason = reason }
}

class Scheduler extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.now = opts.now || Date.now
    this.stateFile = opts.stateFile || null
    this.lingerMs = opts.lingerMs ?? 0                 // after a task Walter asked for finishes (a walk, a craft), background tasks wait this long: the bot stays where it was sent
    this.holdUntil = 0
    this.ghostUnseenMs = opts.ghostUnseenMs   // a focus whose task never shows up ends after this long (default 10 min)
    this.gate = null           // outdoor gate: { names:Set, check() -> true | false | { ok, reason } }
    this.gateOverrideUntil = 0
    this._gateCache = new Map()   // task name -> { at, val }
    this.gateMinHoldMs = opts.gateMinHoldMs ?? 45000   // once held, a task stays held at least this long (no flip-flop when the bot's position changes the answer)
    this.preStart = []         // hooks run (inside the task's own slot, abortable) right before a task's run(): { applies(task), run(ctx, task) }
    this.focuses = []          // Walter's steering: { id, task, priority, until, untilDone, note, suppress, seen }
    this.focusSeq = 0
    this.idleAfterMs = opts.idleAfterMs ?? 180000   // quiet time after Walter's last chat before idleOnly tasks run (a saved value wins)
    this.graceMs = opts.graceMs ?? 15000
    this.safetyCooldownMs = opts.safetyCooldownMs ?? 0   // a task bumped by a SAFETY task waits this long before resuming (no thrash while a mob lingers)
    this.parkRetryMs = opts.parkRetryMs ?? 0
    this.tasks = []            // non-terminal tasks
    this.routines = new Map()
    this.enabled = {}          // routine name -> bool (persisted)
    this.history = []          // ring of {t, msg}
    this.running = null
    this.seq = 0
    this.lastChatAt = 0     // a message that triggered a command: may abort a running idle job
    this.lastTalkAt = 0     // any message from Walter: only delays STARTING idle jobs (tasks persist through conversation)
    this.lastUserStopAt = 0
    this.timer = null
    this._pumping = false
    this.focusFile = opts.focusFile || null
    this._load()
    this._loadFocus()
  }

  // ---- persistence (enabled flags only; tasks are rebuilt by routines) ----
  _load() {
    if (!this.stateFile) return
    try { const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8').replace(/^﻿/, '')); this.enabled = s.enabled || {}; if (Number.isFinite(s.idleAfterMs)) this.idleAfterMs = s.idleAfterMs; if (Number.isFinite(s.lingerMs)) this.lingerMs = s.lingerMs } catch { /* first run */ }
  }
  _save() {
    if (!this.stateFile) return
    try { const tmp = this.stateFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ enabled: this.enabled, idleAfterMs: this.idleAfterMs, lingerMs: this.lingerMs }, null, 2)); fs.renameSync(tmp, this.stateFile) } catch (e) { this._log('state save failed: ' + e.message) }
  }
  _log(msg) { this.history.push({ t: this.now(), msg }); if (this.history.length > 60) this.history.shift(); this.emit('log', msg) }

  // ---- routines ----
  // routine: { name, priority, intervalMs, defaultEnabled, due(), make() -> task def, idleOnly }
  routine(r) {
    this.routines.set(r.name, { nextCheck: 0, intervalMs: 5000, ...r })
    if (!(r.name in this.enabled)) this.enabled[r.name] = !!r.defaultEnabled
    return this
  }
  setEnabled(name, on) { this.enabled[name] = !!on; this._save(); this._log(`${name} ${on ? 'enabled' : 'disabled'}`); if (on) this.resumeParked(name); this.pump() }
  setLinger(ms) { this.lingerMs = Math.max(0, Math.min(10 * 60000, ms)); this._save(); this._log(`linger ${this.lingerMs} ms`) }
  setIdleAfter(ms) { this.idleAfterMs = Math.max(3000, Math.min(30 * 60000, ms)); this._save(); this._log(`idle delay ${this.idleAfterMs} ms`); this.pump() }
  isEnabled(name) { const r = this.routines.get(name); return r && r.enabledFn ? !!r.enabledFn() : !!this.enabled[name] }

  // ---- submitting ----
  submit(def) {
    // Walter: orders queue up and run back to back. A new walk (name 'nav', replace:true) waits behind a running static walk instead of replacing it;
    // a follow (dynamic) never ends on its own, so the next order replaces it.
    if (def.name === 'nav' && def.replace) {
      const navs = this.tasks.filter(t => t.name === 'nav')
      for (const t of navs) if (t.state && t.state.dynamic) this.cancel(t.key, 'replaced')
      if (navs.some(t => !(t.state && t.state.dynamic))) def = { ...def, key: `nav:${++this.seq}`, replace: false }
    }
    const key = def.key || def.name
    const existing = this.tasks.find(t => t.key === key)
    if (existing) {
      if (!def.replace) return existing
      this.cancel(key, 'replaced')
    }
    const task = {
      id: ++this.seq, key, name: def.name, priority: def.priority ?? PRIORITY.CHAT, ignoreHold: !!def.ignoreHold, def, status: 'queued', state: def.state || {},
      idleOnly: !!def.idleOnly, onUserStop: def.onUserStop || 'cancel', preemptible: def.preemptible !== false,
      createdAt: this.now(), startedAt: null, runs: 0, notBefore: 0, progress: '', parkReason: null, ctrl: null
    }
    this.tasks.push(task)
    for (const f of this.focuses) if (this._matches(f, task)) f.seen = true
    this._log(`queued ${task.name} (p${task.priority})`)
    this.pump()
    return task
  }

  _saveFocus() {
    if (!this.focusFile) return
    try { const tmp = this.focusFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.focuses.map(({ seen, ...f }) => f), null, 1)); fs.renameSync(tmp, this.focusFile) } catch (e) { this._log('focus save failed: ' + e.message) }
  }
  _loadFocus() {
    if (!this.focusFile) return
    try {
      const list = JSON.parse(fs.readFileSync(this.focusFile, 'utf8').replace(/^\uFEFF/, ''))
      for (const f of list) if (f && f.task && f.task !== 'manual' && f.until > this.now()) this.focuses.push({ ...f, id: ++this.focusSeq, seen: false, then: f.then || [] })
      if (this.focuses.length) this._log(`restored ${this.focuses.length} focus(es): ${this.focuses.map(f => f.task).join(', ')}`)
    } catch { /* none saved */ }
  }
  // ---- focus: natural-language steering (brain/pilot turns Walter's framing into these) ----
  //   focus({ task, priority = 60, until = 'done', note, suppress = [], resumePrevious = true, maxMs = 30 min }) -> id
  //   task: name/key of the task to favour (it may not exist yet; the focus applies as soon as it does).
  //   priority: its effective priority while the focus lasts (capped below SAFETY; sleep 80 / eat 70 still win above 70).
  //   until: 'done' (until that task finishes, capped by maxMs), an epoch ms (> 1e12) or a duration in ms.
  //   suppress: names of tasks held back while the focus lasts (e.g. 'mining' while the tower is the focus).
  //   resumePrevious:false cancels the task that was running instead of pausing it for later.
  //   then: [{ task, command?, priority?, until?, note? }, ...] a saved goal chain: when this focus ends because its task finished, the next entry becomes the focus and
  //         its `command` (the chat line that starts that job, e.g. 'mine iron 16') is emitted as 'focus-command' for the integrator to run.
  //   command: the chat line that (re)starts this focus's job; re-run after a restart if no matching task has been queued by then.
  // Focuses survive restarts (brain/state/focus.json). While any focus is active, background tasks (priority below chat) that are not its target stay behind it;
  // only safety, sleep, eat and Walter's own chat tasks go ahead. The outdoor gate still applies to a focused task (night: held, resumes at dawn).
  // A focus ends by itself (time up, task done) and everything goes back to the normal queue and routines.
  focus(o = {}) {
    if (!o.task) throw new Error('focus needs a task name')
    const now = this.now()
    let until = o.until === undefined ? 'done' : o.until, untilDone = false
    if (until === 'done') { untilDone = true; until = now + (o.maxMs || 30 * 60000) }
    else if (typeof until === 'number') until = until > 1e12 ? until : now + until
    else throw new Error('until must be "done", an epoch time or a duration in ms')
    const f = { id: ++this.focusSeq, task: String(o.task), priority: Math.min(PRIORITY.SAFETY - 1, o.priority ?? PRIORITY.FOCUS), until, untilDone, note: o.note || '', suppress: o.suppress || [], createdAt: now, seen: false, command: o.command || null, then: (o.then || []).map(e => ({ ...e })) }
    f.seen = this.tasks.some(t => this._matches(f, t))
    this.focuses.push(f)
    this._log(`focus on ${f.task} p${f.priority}${f.note ? ' ("' + String(f.note).slice(0, 60) + '")' : ''}`)
    if (this.running && !this._matches(f, this.running) && o.resumePrevious === false && this._prio(this.running) < PRIORITY.SAFETY) this.cancel(this.running.key, 'cancelled')
    this.resumeParked(f.task)
    this._saveFocus()
    this.emit('focus', f)
    this.pump()
    return f.id
  }
  focusList() { this._expireFocuses(); return this.focuses.map(f => ({ id: f.id, task: f.task, priority: f.priority, note: f.note, command: f.command, next: (f.then || []).map(e => e.note || e.command || e.task), untilDone: f.untilDone, leftS: Math.max(0, Math.round((f.until - this.now()) / 1000)), suppress: f.suppress })) }
  clearFocus(idOrTask) {
    const before = this.focuses.length
    this.focuses = idOrTask === undefined ? [] : this.focuses.filter(f => f.id !== idOrTask && f.task !== idOrTask)
    const gone = before - this.focuses.length
    if (gone) { this._log('focus cleared'); this._saveFocus(); this.pump() }
    return gone
  }
  _matches(f, t) { return t.name === f.task || t.key === f.task }
  // A focus must never outlive its job and keep the whole bot idle (04:35-04:38: a stale 'manual' focus suppressed every routine). So besides the time limit:
  //  - a focus whose task was seen and is no longer queued/running ends after 5 s (a ghost); it comes back if the task reappears inside those 5 s;
  //  - a focus whose task never showed up ends after ghostUnseenMs (10 min).
  _expireFocuses() {
    const now = this.now(), gone = []
    for (const f of this.focuses) {
      const live = this.tasks.some(t => this._matches(f, t))
      if (live) { f.seen = true; f.goneSince = null }
      let why = null
      if (f.until <= now) why = 'time'
      else if (f.seen && !live) { f.goneSince = f.goneSince || now; if (now - f.goneSince > 5000) why = 'gone' }
      else if (!f.seen && now - f.createdAt > (this.ghostUnseenMs ?? 10 * 60000)) why = 'unseen'
      if (why) gone.push([f, why])
    }
    if (!gone.length) return
    this.focuses = this.focuses.filter(f => !gone.some(([g]) => g === f))
    for (const [f, why] of gone) { this._log(`focus ended: ${f.task} (${why})`); this.emit('focus-end', f, why === 'time' ? 'time' : why) }
    this._saveFocus()
  }
  _focusOf(t) { for (let i = this.focuses.length - 1; i >= 0; i--) if (this.focuses[i].until > this.now() && this._matches(this.focuses[i], t)) return this.focuses[i]; return null }
  _prio(t) { const f = this._focusOf(t); return f ? f.priority : t.priority }
  // while a focus is active, background tasks (priority below chat) that are not its target wait; safety, sleep, eat and Walter's own tasks are not affected
  _behindFocus(t) { const now = this.now(); return this.focuses.some(f => f.until > now) && !this._focusOf(t) && t.priority < PRIORITY.CHAT && !t.ignoreFocus }
  _suppressed(t) { const now = this.now(); return this.focuses.some(f => f.until > now && f.suppress.some(n => n === t.name || n === t.key)) }

  // ---- outdoor gate: tasks that go outside (build, mining, treefarm, or def.outdoor) only start, and only keep running, when check() says it is safe
  // (daylight, health, no hostiles close). A focus on the task (Walter's explicit order) or gateOverride(ms) skips it. Held tasks emit 'gate-hold' once per reason.
  setGate(g) { this.gate = g }
  gateRecheck() { this._gateCache = new Map(); for (const t of this.tasks) t.heldUntil = 0; this.pump() }   // forget cached answers and holds (tests, or after the world changed)
  gateOverride(ms) { this.gateOverrideUntil = this.now() + ms; this._gateCache.clear(); for (const t of this.tasks) t.heldUntil = 0; this.pump() }
  _gateState(task, running) {
    if (!this.gate) return null
    const t = this.now(), name = (task ? task.name : '') + (running ? '|running' : '')
    if (!(this._gateCache instanceof Map)) this._gateCache = new Map()   // tolerate older code that reset the cache by assigning an object
    const c = this._gateCache.get(name)
    if (c && t - c.at < 800) return c.val
    let r = null
    try { const v = this.gate.check(task, { running: !!running }); r = v === false ? { ok: false, reason: 'it is safe again' } : (v && v.ok === false ? v : null) } catch (e) { this._log('gate check failed: ' + e.message) }
    this._gateCache.set(name, { at: t, val: r })
    return r
  }
  _gated(t, running) {
    if (!this.gate || this.now() < this.gateOverrideUntil) return null
    if (!(this.gate.names.has(t.name) || (t.def && t.def.outdoor))) return null
    return this._gateState(t, running)
  }

  _eligible(t) {
    if (t.status !== 'queued' && t.status !== 'paused') return false
    if (this.now() < t.notBefore) return false
    if (this._suppressed(t) || this._behindFocus(t)) return false
    const held = this._gated(t)
    if (held) {
      const hold = held.holdMs ?? this.gateMinHoldMs   // a check may ask for a shorter hold (a mob that wandered off)
      t.heldUntil = Math.max(t.heldUntil || 0, this.now() + hold)
      const tm = setTimeout(() => this.pump(), hold + 10); if (tm.unref) tm.unref()
      if (t.gateReason !== held.reason) { t.gateReason = held.reason; this._log(`holding ${t.name}: waiting for ${held.reason}`); this.emit('gate-hold', t, held.reason) }
      return false
    }
    if (t.heldUntil && this.now() < t.heldUntil && this.now() >= this.gateOverrideUntil) return false   // hysteresis: stay held for a while after a hold, the answer must not flap
    t.gateReason = null
    const focused = !!this._focusOf(t)
    if (this.now() < this.holdUntil && this._prio(t) < PRIORITY.CHAT && !t.ignoreHold && !focused) return false   // linger after a task Walter asked for
    if (t.idleOnly && !focused && this.now() - Math.max(this.lastChatAt, this.lastTalkAt) < this.idleAfterMs) return false
    return true
  }
  _best() {
    let best = null
    for (const t of this.tasks) {
      if (!this._eligible(t)) continue
      if (!best || this._prio(t) > this._prio(best) || (this._prio(t) === this._prio(best) && t.id < best.id)) best = t
    }
    return best
  }

  pump() {
    if (this._pumping) return
    this._pumping = true
    try {
      this._expireFocuses()
      const best = this._best()
      if (this.running) {
        const r = this.running
        const rHeld = this._gated(r, true)
        if (rHeld && !r.ctrl.aborted) r.heldUntil = Math.max(r.heldUntil || 0, this.now() + (rHeld.holdMs ?? this.gateMinHoldMs))
        if ((this._suppressed(r) || this._behindFocus(r) || rHeld) && !r.ctrl.aborted) this._abort(r, 'preempted')
        else if (best && this._prio(best) > this._prio(r) && r.preemptible && !r.ctrl.aborted) { r.preemptedBy = this._prio(best); this._abort(r, 'preempted') }
        else if (r.idleOnly && !this._focusOf(r) && this.now() - this.lastChatAt < this.idleAfterMs && !r.ctrl.aborted) this._abort(r, 'preempted')
        return
      }
      if (best) this._start(best)
    } finally { this._pumping = false }
  }

  _abort(task, reason) {
    if (!task.ctrl || task.ctrl.aborted) return
    task.ctrl.aborted = true; task.ctrl.reason = reason
    for (const w of task.ctrl.waiters.splice(0)) w(new AbortError(reason))
    this._log(`abort ${task.name}: ${reason}`)
    try { task.def.abort && task.def.abort(reason) } catch (e) { this._log(`abort hook failed: ${e.message}`) }
    task.graceTimer = setTimeout(() => this._detach(task), this.graceMs)
    if (task.graceTimer.unref) task.graceTimer.unref()
  }

  _detach(task) {
    if (this.running !== task) return
    this._log(`${task.name} did not stop within ${this.graceMs}ms; detached`)
    this._settle(task, { status: 'aborted' })
  }

  _start(task) {
    const ctrl = { aborted: false, reason: null, waiters: [] }
    task.ctrl = ctrl
    const resumed = task.runs > 0
    task.runs++; task.status = 'running'; task.startedAt = this.now(); this.running = task
    const ctx = {
      task, state: task.state, resumed,
      get aborted() { return ctrl.aborted }, get reason() { return ctrl.reason },
      checkpoint() { if (ctrl.aborted) throw new AbortError(ctrl.reason) },
      sleep(ms) {
        return new Promise((res, rej) => {
          if (ctrl.aborted) return rej(new AbortError(ctrl.reason))
          const w = (err) => { clearTimeout(tm); rej(err) }
          const tm = setTimeout(() => { const i = ctrl.waiters.indexOf(w); if (i >= 0) ctrl.waiters.splice(i, 1); res() }, ms)
          ctrl.waiters.push(w)
        })
      },
      // cb(AbortError) fires once if the task is aborted; returns a disposer
      onAbort(cb) {
        if (ctrl.aborted) { cb(new AbortError(ctrl.reason)); return () => {} }
        ctrl.waiters.push(cb)
        return () => { const i = ctrl.waiters.indexOf(cb); if (i >= 0) ctrl.waiters.splice(i, 1) }
      },
      progress(text) { task.progress = text }
    }
    this._log(`${resumed ? 'resume' : 'start'} ${task.name}`)
    this.emit('start', task)
    let p
    const hooks = this.preStart.filter(h => { try { return h.applies(task) } catch { return false } })
    try {
      p = hooks.length
        ? (async () => {
          for (const h of hooks) { try { await h.run(ctx, task) } catch (e) { if (e && e.name === 'AbortError') throw e; this._log(`pre-start hook failed for ${task.name}: ${e && e.message}`) } }
          ctx.checkpoint()
          return task.def.run(ctx)
        })()
        : Promise.resolve(task.def.run(ctx))
    } catch (e) { p = Promise.reject(e) }
    p.then(res => this._settle(task, res || { status: 'done' }, ctrl), err => this._settle(task, { status: 'error', error: err }, ctrl))
  }

  _settle(task, res, ctrl) {
    if (this.running !== task) return                 // already detached
    if (ctrl && ctrl !== task.ctrl) return
    clearTimeout(task.graceTimer)
    this.running = null
    const reason = task.ctrl && task.ctrl.reason
    const aborted = !!(task.ctrl && task.ctrl.aborted)
    const err = res.error
    task.progress = ''
    if (err && err.name === 'AbortError') res = { status: 'aborted' }
    if (aborted) {
      // Task was told to stop; decide where it goes.
      if (reason === 'preempted') {
        task.status = 'paused'; this._log(`paused ${task.name}`)
        if ((task.preemptedBy || 0) >= PRIORITY.SAFETY && this.safetyCooldownMs) {
          task.notBefore = this.now() + this.safetyCooldownMs
          const tm = setTimeout(() => this.pump(), this.safetyCooldownMs + 5); if (tm.unref) tm.unref()
        }
      }
      else if (reason === 'user-stop' && task.onUserStop === 'park') { this._park(task, 'stopped by Walter') }
      else if (reason === 'user-stop' || reason === 'cancelled' || reason === 'replaced') this._finish(task, 'cancelled')
      else this._finish(task, 'cancelled')
    } else if (res.status === 'error') {
      this._finish(task, 'failed'); task.error = err; this._log(`${task.name} failed: ${err && err.message}`); this.emit('failed', task, err)
    } else if (res.status === 'park') {
      // Walter: never stop and wait for him. A task that parks itself (blocked, no path, hold ...) is retried with a growing delay; only his own stop/park command parks for good.
      task.parkCount = (task.parkCount || 0) + 1
      const after = Math.min(300000, 20000 * Math.pow(2, Math.min(task.parkCount - 1, 4)))
      task.status = 'paused'; task.notBefore = this.now() + after; task.parkReason = res.reason || ''
      this._log(`${task.name} could not continue (${(res.reason || '').slice(0, 120)}); retrying in ${Math.round(after / 1000)} s`)
      const tm = setTimeout(() => this.pump(), after + 5); if (tm.unref) tm.unref()
    }
    else if (res.status === 'retry') {
      const after = res.afterMs || 15000
      task.status = 'paused'; task.notBefore = this.now() + after; this._log(`${task.name} will retry`)
      const tm = setTimeout(() => this.pump(), after + 5); if (tm.unref) tm.unref()
    }
    else this._finish(task, 'done')
    // let the world settle a tick before the next task grabs the pathfinder
    setImmediate(() => this.pump())
  }

  _finish(task, status) {
    task.status = status
    if (status === 'done' && (task.name === 'nav' || (task.def && task.def.linger)) && this.lingerMs > 0) {   // only walks Walter sent (or tasks that ask for it); a craft a module dispatches must not stall that module
      this.holdUntil = this.now() + this.lingerMs
      const tm = setTimeout(() => this.pump(), this.lingerMs + 5); if (tm.unref) tm.unref()
    }
    this.tasks = this.tasks.filter(t => t !== task)
    const ended = this.focuses.filter(f => f.untilDone && f.seen && this._matches(f, task) && !this.tasks.some(t => this._matches(f, t)))
    if (ended.length) {
      this.focuses = this.focuses.filter(f => !ended.includes(f))
      for (const f of ended) {
        this._log(`focus ended: ${f.task} (${status})`)
        this.emit('focus-end', f, status)
        if (status === 'done' && f.then && f.then.length) {   // a saved goal chain continues by itself
          const [next, ...rest] = f.then
          this._log(`next goal: ${next.note || next.command || next.task}`)
          try { this.focus({ ...next, priority: next.priority ?? f.priority, task: next.task || f.task, then: rest }) } catch (e) { this._log('chain failed: ' + e.message) }
          this.emit('focus-command', next, f)
        }
      }
      this._saveFocus()
    }
    this._log(`${status} ${task.name}`)
    this.emit(status === 'done' ? 'done' : 'ended', task)
  }
  _park(task, reason) { task.status = 'parked'; task.parkReason = reason; this._log(`parked ${task.name}: ${reason}`); this.emit('parked', task) }

  // ---- control ----
  cancel(key, reason = 'cancelled') {
    const t = this.tasks.find(x => x.key === key || x.name === key)
    if (!t) return false
    if (t === this.running) this._abort(t, reason)
    else this._finish(t, 'cancelled')
    return true
  }
  resumeParked(nameOrKey) {
    let n = 0
    for (const t of this.tasks) {
      if (t.status !== 'parked') continue
      if (nameOrKey && t.key !== nameOrKey && t.name !== nameOrKey) continue
      t.status = 'paused'; t.parkReason = null; t.notBefore = 0; n++
    }
    if (n) this.pump()
    return n
  }
  // Walter said stop/pause/stay: every task he can see stops now. Background tasks are parked until "resume", chat tasks cancelled.
  userStop() {
    this.lastUserStopAt = this.now()
    for (const t of [...this.tasks]) {
      if (t.priority >= PRIORITY.SAFETY) continue          // safety keeps protecting the bot
      if (t === this.running) this._abort(t, 'user-stop')
      else if (t.onUserStop === 'park') this._park(t, 'stopped by Walter')
      else this._finish(t, 'cancelled')
    }
  }
  // Any chat from Walter: idleOnly tasks yield now and stay quiet for idleAfterMs.
  noteChat() { this.lastChatAt = this.now(); this.pump() }
  noteTalk() { this.lastTalkAt = this.now(); this.pump() }

  // ---- background routines ----
  addPreStart(h) { this.preStart.push(h); return this }
  start(tickMs = 1000) {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), tickMs)
    if (this.timer.unref) this.timer.unref()
  }
  stop() { clearInterval(this.timer); this.timer = null }
  tick() {
    const now = this.now()
    for (const r of this.routines.values()) {
      if (!this.isEnabled(r.name) || now < r.nextCheck) continue
      r.nextCheck = now + r.intervalMs
      if (this.tasks.some(t => t.key === (r.key || r.name))) continue
      let want = false
      try { want = !!r.due() } catch (e) { this._log(`${r.name}.due failed: ${e.message}`) }
      if (!want) continue
      const def = r.make()
      this.submit({ priority: r.priority, idleOnly: r.idleOnly, onUserStop: 'park', key: r.key || r.name, ...def, name: def.name || r.name })
    }
    this.pump()
  }

  idle() { return !this.running && !this.tasks.some(t => t.status === 'queued') }

  status() {
    const now = this.now()
    const view = (t) => ({ name: t.name, priority: this._prio(t), band: bandOf(this._prio(t)), status: t.status, progress: t.progress, runs: t.runs, parkReason: t.parkReason, ageS: Math.round((now - t.createdAt) / 1000) })
    return {
      running: this.running ? { ...view(this.running), runningS: Math.round((now - this.running.startedAt) / 1000) } : null,
      queue: this.tasks.filter(t => t !== this.running && (t.status === 'queued' || t.status === 'paused')).sort((a, b) => this._prio(b) - this._prio(a)).map(view),
      parked: this.tasks.filter(t => t.status === 'parked').map(view),
      routines: [...this.routines.values()].map(r => ({ name: r.name, enabled: this.isEnabled(r.name), priority: r.priority })),
      quietForS: Math.round((now - this.lastChatAt) / 1000),
      focuses: this.focusList(),
      lingerS: Math.round(this.lingerMs / 1000), holdLeftS: Math.max(0, Math.round((this.holdUntil - now) / 1000)),
      idleAfterS: Math.round(this.idleAfterMs / 1000),
      history: this.history.slice(-15).map(h => ({ agoS: Math.round((now - h.t) / 1000), msg: h.msg }))
    }
  }
}

module.exports = { Scheduler, AbortError, PRIORITY, BANDS, bandOf }
