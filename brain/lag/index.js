// brain/lag: event-loop stall detector and finder. A blocked event loop stops keep-alive replies and the server resets the connection (ECONNRESET).
// Logs any stall over 1.5 s with what the autopilot was doing, and names the culprit when it can:
//   - bot events whose handlers run longer than 1 s (physicsTick, chunk, entity events ...): event name + handler names
//   - timers (setTimeout/setInterval) created after this module loads whose callback runs longer than 1 s: where the timer was created
// Reload the other modules after this one to get their timers covered.
module.exports = function register(api) {
  const { bot } = api
  let last = Date.now(), timer = null, worst = 0, stalls = 0
  const slow = []
  const note = (m) => { slow.push(new Date().toISOString().slice(11, 19) + ' ' + m); if (slow.length > 20) slow.shift(); api.log('lag', m) }
  const origEmit = bot.emit
  const where = () => { const s = (new Error().stack || '').split('\n').slice(2).find(l => /brain|join\.js|node_modules/.test(l) && !/[\\/]lag[\\/]index\.js/.test(l)) || '?'; return s.trim().replace(/^at /, '').slice(0, 140) }
  const G = global, origSI = G.setInterval, origST = G.setTimeout
  const origOn = bot.on, origAdd = bot.addListener, origRemove = bot.removeListener, origOff = bot.off
  const wrapped = new WeakMap()
  function wrapListener(ev, fn) {
    if (typeof fn !== 'function') return fn
    if (wrapped.has(fn)) return wrapped.get(fn)
    const made = where()
    const w = function (...a) { const t = Date.now(); try { return fn.apply(this, a) } finally { const d = Date.now() - t; if (d > 500) note(`slow '${String(ev)}' handler ${d} ms, added at ${made}`) } }
    wrapped.set(fn, w); return w
  }
  function wrap(fn, made) {
    if (typeof fn !== 'function') return fn
    return function (...a) { const t = Date.now(); try { return fn.apply(this, a) } finally { const d = Date.now() - t; if (d > 1000) note(`slow timer ${d} ms, created at ${made}`) } }
  }
  // installed at register time (this module loads first), so every later module's listeners and timers are wrapped
  bot.emit = function (ev, ...a) {
    const t = Date.now(); const r = origEmit.call(this, ev, ...a); const d = Date.now() - t
    if (d > 1000) note(`slow event '${String(ev)}' ${d} ms; handlers: ${this.listeners(ev).map(f => f.name || 'anon').join(',').slice(0, 200)}`)
    return r
  }
  bot.on = bot.addListener = function (ev, fn) { return origOn.call(this, ev, wrapListener(ev, fn)) }
  bot.removeListener = bot.off = function (ev, fn) { return origRemove.call(this, ev, (fn && wrapped.get(fn)) || fn) }
  G.setInterval = function (fn, ms, ...a) { return origSI(wrap(fn, where()), ms, ...a) }
  G.setTimeout = function (fn, ms, ...a) { return origST(wrap(fn, where()), ms, ...a) }
  return {
    name: 'lag',
    start() {
      timer = origSI(() => {
        const now = Date.now(), lag = now - last - 500
        last = now
        if (lag > 1500) {
          stalls++; worst = Math.max(worst, lag)
          const ap = bot._ap
          api.log('lag', `event loop stalled ${lag} ms (step ${ap && ap.G && ap.G.lastStep}, task ${(api.scheduler.status().running || {}).name || '-'})`)
        }
      }, 500)
    },
    stop() { clearInterval(timer); bot.emit = origEmit; bot.on = origOn; bot.addListener = origAdd; bot.removeListener = origRemove; bot.off = origOff; G.setInterval = origSI; G.setTimeout = origST },
    status: () => ({ stalls, worst, slow })
  }
}
module.exports.meta = { name: 'lag', version: 1 }
