// Trigger manager: runs registered triggers on an interval (or on demand) and keeps their last result.
// A trigger is { id, title, run(ctx) -> { ok, summary, skipped?, ... } }. Settings live in config.triggers[id]:
// { enabled, intervalMin }. To add a new headless-Claude job (e.g. "drive the bots"), write one trigger module
// and register it in main.js; the manager, scheduling and the UI list pick it up.
const { EventEmitter } = require('events')

class TriggerManager extends EventEmitter {
  constructor(config, ctx, { firstRunDelayMs = 20000 } = {}) {
    super()
    this.config = config
    this.ctx = ctx
    this.firstRunDelayMs = firstRunDelayMs
    this.triggers = new Map()
    this.status = new Map()
    this.timers = new Map()
  }
  register(trigger) {
    this.triggers.set(trigger.id, trigger)
    this.status.set(trigger.id, { running: false, lastRun: null, lastResult: null, nextRun: null })
  }
  settings(id) {
    return { enabled: false, intervalMin: 5, ...(this.config.data.triggers[id] || {}) }
  }
  list() {
    return [...this.triggers.values()].map(t => ({ id: t.id, title: t.title, ...this.settings(t.id), ...this.status.get(t.id) }))
  }
  start() { for (const id of this.triggers.keys()) this.schedule(id, this.firstRunDelayMs) }
  stop() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear() }
  // (Re)arm one trigger. delayMs defaults to its interval. Disabled triggers have no timer.
  schedule(id, delayMs) {
    clearTimeout(this.timers.get(id))
    this.timers.delete(id)
    const st = this.status.get(id)
    const s = this.settings(id)
    if (!s.enabled) { st.nextRun = null; this.emit('update'); return }
    const d = delayMs ?? Math.max(1, Number(s.intervalMin) || 5) * 60000
    st.nextRun = new Date(Date.now() + d).toISOString()
    this.timers.set(id, setTimeout(() => this.runNow(id).catch(() => {}), d))
    this.emit('update')
  }
  setSettings(id, patch) {
    for (const [k, v] of Object.entries(patch)) this.config.set(`triggers.${id}.${k}`, v)
    this.schedule(id)
  }
  async runNow(id) {
    const t = this.triggers.get(id), st = this.status.get(id)
    if (!t) throw new Error('unknown trigger ' + id)
    if (st.running) return st.lastResult
    st.running = true; st.nextRun = null; this.emit('update')
    let result
    try { result = await t.run(this.ctx) } catch (e) { result = { ok: false, summary: String(e.message || e) } }
    st.running = false
    st.lastRun = new Date().toISOString()
    st.lastResult = result
    this.schedule(id)
    return result
  }
}

module.exports = { TriggerManager }
