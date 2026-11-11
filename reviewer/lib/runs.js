// One line per run of a scheduled job, so a person can see what the loop did without opening a log (the Bot Dashboard app's "Memory loop" tab reads this).
//   <loop dir>/runs/<job>.jsonl     { at, job, ok, summary, costUsd, durationMs, ... }
const fs = require('fs')
const path = require('path')

const MAX_BYTES = 256 * 1024, KEEP = 500, NL = String.fromCharCode(10)
const fileOf = (cfg, job) => path.join(cfg.loopDir, 'runs', `${String(job).replace(/[^a-z0-9-]/gi, '')}.jsonl`)

function append(cfg, job, row, now = Date.now()) {
  try {
    const f = fileOf(cfg, job)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.appendFileSync(f, JSON.stringify({ at: new Date(now).toISOString(), job, ...row }) + '\n')
    if (fs.statSync(f).size > MAX_BYTES) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-KEEP).join('\n') + '\n')
    return true
  } catch { return false }
}

// A run that did nothing on purpose, with the reason ("all bots offline", "another deploy is running"): without it a job that fires every ten minutes and
// skips looks the same as a job that never fires. A streak of the same reason is one row that counts up, so a night offline is one line, not a hundred.
function skip(cfg, job, reason, now = Date.now()) {
  try {
    const f = fileOf(cfg, job), at = new Date(now).toISOString()
    let lines = []; try { lines = fs.readFileSync(f, 'utf8').split(NL).filter(Boolean) } catch { /* first row */ }
    let last = null; try { last = JSON.parse(lines[lines.length - 1]) } catch { /* none */ }
    const hhmm = (iso) => String(iso).slice(11, 16) + 'Z'
    if (last && last.skipped === reason) {
      last.n = (last.n || 1) + 1; last.at = at; last.summary = `skipped: ${reason} (${last.n} times since ${hhmm(last.since)})`
      lines[lines.length - 1] = JSON.stringify(last)
      fs.writeFileSync(f, lines.join(NL) + NL)
      return true
    }
    return append(cfg, job, { ok: true, skipped: reason, n: 1, since: at, summary: `skipped: ${reason}` }, now)
  } catch { return false }
}

// newest first, across jobs
function read(cfg, { jobs = null, limit = 40 } = {}) {
  const out = []
  let files = []; try { files = fs.readdirSync(path.join(cfg.loopDir, 'runs')).filter(f => f.endsWith('.jsonl')) } catch { return out }
  for (const f of files) {
    if (jobs && !jobs.includes(f.slice(0, -6))) continue
    let text = ''; try { text = fs.readFileSync(path.join(cfg.loopDir, 'runs', f), 'utf8') } catch { continue }
    for (const l of text.split('\n').filter(Boolean).slice(-limit)) { try { out.push(JSON.parse(l)) } catch { /* a torn line */ } }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit)
}

module.exports = { append, skip, read, fileOf }
