// brain/pilot/latency: per-line timing of Walter's chat -> first reply of each kind, appended to brain/state/latency.jsonl.
//   quickMs   our fast voice (or any router tier reply) was sent
//   ackMs     a generic acknowledgement was sent
//   botMs     the first line the bot said at all after Walter's line (any source)
//   outboxMs  the driver (Claude) first appended to outbox.txt after the line, i.e. Claude's real reply latency
// outbox.txt is only WATCHED (read-only); join.js empties it within 250 ms of a write. Nothing here changes behaviour.
const fs = require('fs')
const path = require('path')

const one = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n)
const MAX_BYTES = 256 * 1024

function createLatency({ file, dir, now = Date.now, watch = true, flushAfterMs = 120000 } = {}) {
  let cur = null
  let watcher = null, lastOut = { text: '', at: 0 }
  const timers = new Set()

  function append(row) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, JSON.stringify(row) + '\n')
      if (fs.statSync(file).size > MAX_BYTES) { const l = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); fs.writeFileSync(file, l.slice(Math.floor(l.length / 2)).join('\n') + '\n') }
    } catch { /* logging only */ }
  }
  function flush() {
    if (!cur) return
    const c = cur; cur = null
    if (c.timer) { clearTimeout(c.timer); timers.delete(c.timer) }
    append({ t: new Date(c.t).toISOString(), text: one(c.text, 80), lane: c.lane, quickMs: c.quickMs ?? null, ackMs: c.ackMs ?? null, botMs: c.botMs ?? null, outboxMs: c.outboxMs ?? null, outboxLines: c.outboxLines || 0 })
  }
  function lineIn(text) {
    flush()
    cur = { t: now(), text, lane: 'unknown', outboxLines: 0 }
    cur.timer = setTimeout(flush, flushAfterMs)
    if (cur.timer.unref) cur.timer.unref()
    timers.add(cur.timer)
  }
  const since = () => now() - cur.t
  // kind: 'quick' | 'ack' | 'ran' | 'asked'
  function lane(kind) {
    if (!cur) return
    if (kind === 'quick' && cur.quickMs == null) { cur.quickMs = since(); cur.lane = 'quick' }
    else if (kind === 'ack' && cur.ackMs == null) { cur.ackMs = since(); if (cur.lane === 'unknown') cur.lane = 'ack' }
    else if ((kind === 'ran' || kind === 'asked') && cur.lane === 'unknown') cur.lane = kind
  }
  function botSaid() { if (cur && cur.botMs == null) cur.botMs = since() }
  function claudeWrote() {
    if (!cur) return
    cur.outboxLines++
    if (cur.outboxMs == null) cur.outboxMs = since()
  }

  function start() {
    if (!watch || !dir || watcher) return
    try {
      const f = path.join(dir, 'outbox.txt')
      watcher = fs.watch(dir, { persistent: false }, (ev, name) => {
        if (name !== 'outbox.txt') return
        try {
          const t = fs.readFileSync(f, 'utf8').trim()
          if (!t) return
          if (t === lastOut.text && now() - lastOut.at < 400) return        // Windows reports one write twice
          lastOut = { text: t, at: now() }
          claudeWrote()
        } catch { /* the file may be mid-rewrite */ }
      })
      watcher.on('error', () => { watcher = null })
    } catch { watcher = null }
  }
  function stop() { flush(); if (watcher) { try { watcher.close() } catch {} watcher = null } for (const t of timers) clearTimeout(t); timers.clear() }
  return { lineIn, lane, botSaid, claudeWrote, flush, start, stop, current: () => cur }
}

// rows -> { n, quick: {n,p50,p90}, ack, bot, outbox } (for tools/relay-report.js and the dashboard)
function summarize(rows) {
  const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
  const col = (k) => rows.map(r => r[k]).filter(v => typeof v === 'number')
  const mk = (k) => { const a = col(k); return { n: a.length, p50: pct(a, 0.5), p90: pct(a, 0.9) } }
  const first = rows.map(r => [r.quickMs, r.ackMs, r.botMs].filter(v => typeof v === 'number')).filter(a => a.length).map(a => Math.min(...a))
  return { n: rows.length, quick: mk('quickMs'), ack: mk('ackMs'), bot: mk('botMs'), outbox: mk('outboxMs'), firstReply: { n: first.length, p50: pct(first, 0.5), p90: pct(first, 0.9) } }
}

module.exports = { createLatency, summarize }
