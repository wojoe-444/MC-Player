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

// The planner log only says something about NOW if the planner is on and the log is being written. On 2026-11-10 the reviewer reported "380 model errors,
// steps 0" for 16 runs in a row from a log last written on 2026-11-04 by a planner that is switched off (think-off file). Counts from a dead log are
// replaced by a plain statement, so the model cannot mistake history for a live fault.
const PLANNER_LIVE_MS = 30 * 60000
function plannerEvidence({ summary, logMtime, switchedOff, now }) {
  const ageMin = logMtime ? Math.round((now - logMtime) / 60000) : null
  if (switchedOff || ageMin === null || now - logMtime > PLANNER_LIVE_MS) {
    return { plannerRunning: false, switchedOff: !!switchedOff, logLastWritten: logMtime ? new Date(logMtime).toISOString() : null, note: switchedOff ? 'The planner is switched off on this bot (think-off file), so no planner activity is expected. Not a fault, and the old log says nothing about now.' : (ageMin === null ? 'There is no planner log on this bot.' : 'The planner log has not been written for ' + ageMin + ' min, so its old counts say nothing about now.') }
  }
  return { plannerRunning: true, logAgeMin: ageMin, ...summary }
}

// brain/inspect writes summary.json (one row per inspected build) and <build>.md (findings, a block-light map of the spawning room, two cutaways as text).
// Only builds that fail (or have warnings) send their pictures, trimmed: the model reads the picture, the numbers say where to look. Older than 3 hours = not evidence.
function buildInspections(sd) {
  const sum = readJson(path.join(sd, 'inspect', 'summary.json'))
  if (!sum || !sum.rooms) return 'no inspection has run on this bot yet (it needs the farm\'s chunks loaded)'
  const out = {}
  for (const [id, r] of Object.entries(sum.rooms)) {
    if (r.skipped) { out[id] = { skipped: r.skipped }; continue }
    const ageMin = Math.round((Date.now() - Date.parse(r.at || 0)) / 60000)
    const row = { ok: r.ok, faults: r.faults, warns: r.warns, ageMin, headline: r.headline, stats: r.stats }
    if ((!r.ok || r.warns) && ageMin < 180) { try { row.report = fs.readFileSync(path.join(sd, 'inspect', r.file), 'utf8').slice(0, 5200) } catch { /* ignore */ } }
    out[id] = row
  }
  return out
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
  const thinkFile = path.join(sd, 'think-log.jsonl')
  const think = plannerEvidence({ summary: thinkSummary(readJsonl(tailText(thinkFile, 60 * 1024))), logMtime: mtimeMs(thinkFile), switchedOff: fs.existsSync(path.join(sd, 'think-off')), now })
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
    buildInspections: buildInspections(sd),
    hurtLifetimeTotals: readJson(path.join(sd, 'hurt.json')),
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

module.exports = { collectBot, forModel, thinkSummary, plannerEvidence, tailText, readJsonl, stateDir }
