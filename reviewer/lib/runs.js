// One line per run of a scheduled job, so a person can see what the loop did without opening a log (the Bot Dashboard app's "Memory loop" tab reads this).
//   <loop dir>/runs/<job>.jsonl     { at, job, ok, summary, costUsd, durationMs, ... }
const fs = require('fs')
const path = require('path')

const MAX_BYTES = 256 * 1024, KEEP = 500
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

module.exports = { append, read, fileOf }
