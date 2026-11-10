// Evidence for one bot: the telemetry summary and new flags (brain/telemetry), plus the text logs the bot already writes,
// reduced to what a reviewer needs. Everything here is deterministic and read-only; the model only sees this compact result.
const fs = require('fs')
const path = require('path')

const stateDir = (bot) => path.join(bot.dir, 'brain', 'state')
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }

function tailText(file, maxBytes) {
  let fd
  try {
    const st = fs.statSync(file)
    fd = fs.openSync(file, 'r')
    const start = Math.max(0, st.size - maxBytes)
    const buf = Buffer.alloc(st.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    let s = buf.toString('utf8')
    if (start > 0) s = s.slice(s.indexOf('\n') + 1)
    return s.trimEnd()
  } catch { return null } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch {} }
}
const mtimeMs = (f) => { try { return fs.statSync(f).mtimeMs } catch { return 0 } }
const readJsonl = (text) => (text || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

// planner steps -> which actions fail again and again (same action + args, failing), and model trouble
function thinkSummary(lines) {
  const steps = lines.filter(l => l.ev === 'step')
  const byAction = {}, repeats = {}
  for (const s of steps) for (const r of s.results || []) {
    const a = byAction[r.a] = byAction[r.a] || { ok: 0, fail: 0 }
    r.ok ? a.ok++ : a.fail++
    if (!r.ok) { const k = `${r.a} ${JSON.stringify(r.args || {})} -> ${String(r.note || '').slice(0, 80)}`; repeats[k] = (repeats[k] || 0) + 1 }
  }
  const repeated = Object.entries(repeats).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => ({ times: n, what: k }))
  const other = {}
  for (const l of lines) if (l.ev && l.ev !== 'step') other[l.ev] = (other[l.ev] || 0) + 1
  return { steps: steps.length, byAction, repeatedFailures: repeated, otherEvents: other, lastThoughts: steps.slice(-3).map(s => String(s.thought || '').slice(0, 160)) }
}

function collectBot(bot, { now = Date.now(), staleMin = 5, since = 0, maxFlags = 6 } = {}) {
  const sd = stateDir(bot)
  const exists = fs.existsSync(bot.dir)
  const sumFile = path.join(sd, 'telemetry', 'summary.json')
  const summary = readJson(sumFile)
  const updated = summary && Date.parse(summary.updatedAt)
  const telemetry = !summary ? 'missing' : (now - updated > staleMin * 60000 ? 'stale' : 'live')
  const logsFresh = now - Math.max(mtimeMs(path.join(bot.dir, 'idle.log')), mtimeMs(path.join(sd, 'think-log.jsonl'))) < staleMin * 60000
  const active = exists && (telemetry === 'live' || logsFresh)

  const flagsAll = readJsonl(tailText(path.join(sd, 'telemetry', 'flags.jsonl'), 200 * 1024))
  const newFlags = flagsAll.filter(f => Date.parse(f.at) > since).slice(-maxFlags).map(f => ({ ...f, excerpt: (f.excerpt || []).slice(0, 45) }))
  const think = thinkSummary(readJsonl(tailText(path.join(sd, 'think-log.jsonl'), 60 * 1024)))
  const ev = {
    exists, telemetry, active,
    signature: [summary && summary.updatedAt, flagsAll.length ? flagsAll[flagsAll.length - 1].id : '', mtimeMs(path.join(bot.dir, 'idle.log'))].join('|'),
    telemetrySummary: summary ? { ...summary, recent: undefined } : null,
    activeDetectorFlags: summary ? summary.flags : [],
    newFlagWindows: newFlags,
    recentPositions: summary && summary.recent ? summary.recent : null,
    plannerSummary: think,
    idleLogTail: tailText(path.join(bot.dir, 'idle.log'), 3500),
    lessonsTail: tailText(path.join(sd, 'lessons.md'), 1200),
    hurt: readJson(path.join(sd, 'hurt.json')),
    joinLogTail: tailText(path.join(bot.dir, 'join.log'), 1200),
  }
  return ev
}

// the model gets a trimmed copy (the recent position table is only worth sending when a flag is active or there is no flag history at all)
function forModel(ev) {
  const o = { ...ev }
  delete o.signature
  if (!ev.activeDetectorFlags.length && ev.newFlagWindows.length === 0) o.recentPositions = ev.recentPositions && { ...ev.recentPositions, rows: ev.recentPositions.rows.filter((_, i) => i % 3 === 0) }
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined) delete o[k]
  return o
}

module.exports = { collectBot, forModel, thinkSummary, tailText, readJsonl, stateDir }
