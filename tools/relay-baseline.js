// node tools/relay-baseline.js [transcript.jsonl] [--since ISO]
// Baseline of the Claude relay from the DRIVER session's own transcript (works without any bot instrumentation): for every chat line the
// Monitor delivered ("<event>OGWO: ..."), the time until the driver's first model output and until it first appended to outbox.txt.
// Default transcript: the newest *.jsonl under ~/.claude/projects/*Downloads* that contains the chat Monitor.
const fs = require('fs')
const os = require('os')
const path = require('path')

function findTranscript() {
  const base = path.join(os.homedir(), '.claude', 'projects')
  let best = null
  for (const d of fs.readdirSync(base)) {
    if (!/Downloads$/.test(d)) continue
    for (const f of fs.readdirSync(path.join(base, d))) {
      if (!f.endsWith('.jsonl')) continue
      const p = path.join(base, d, f), st = fs.statSync(p)
      if ((!best || st.mtimeMs > best.m) && fs.readFileSync(p, 'utf8').includes('Watch incoming in-game chat')) best = { p, m: st.mtimeMs }
    }
  }
  return best && best.p
}
const args = process.argv.slice(2)
const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : '0'
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--since') || findTranscript()
if (!file) { console.log('no driver transcript found; pass one explicitly'); process.exit(1) }

const ev = []
for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
  let o; try { o = JSON.parse(l) } catch { continue }
  if (!o.timestamp || o.timestamp < since) continue
  const c = o.message && o.message.content
  let text = '', tools = []
  if (typeof c === 'string') text = c
  else if (Array.isArray(c)) for (const b of c) { if (b.type === 'text') text += b.text; else if (b.type === 'tool_use') tools.push(b) }
  ev.push({ ts: o.timestamp, type: o.type, text, tools })
}
const rows = []
const sec = (a, b) => (a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null)
for (let i = 0; i < ev.length; i++) {
  const e = ev[i]
  const m = /<event>(OGWO: [\s\S]*?)<\/event>/.exec(e.text)
  if (e.type !== 'user' || !m) continue
  let first = null, out = null
  for (let j = i + 1; j < ev.length && !out; j++) {
    const x = ev[j]
    if (x.type === 'user' && /<event>OGWO:/.test(x.text)) break
    if (!first && x.type === 'assistant') first = x.ts
    for (const t of x.tools) if (/outbox\.txt/.test(JSON.stringify(t.input)) && /(>>|Write|echo|printf)/.test(JSON.stringify(t.input))) { out = x.ts; break }
  }
  rows.push({ at: e.ts.slice(11, 19), first: sec(e.ts, first), outbox: sec(e.ts, out), line: m[1].slice(6, 60) })
}
const pct = (a, p) => { const s = a.filter(v => v != null).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null }
for (const r of rows) console.log(`${r.at}  first_model ${String(r.first == null ? '-' : r.first.toFixed(1)).padStart(5)} s  to_outbox ${String(r.outbox == null ? '-' : r.outbox.toFixed(1)).padStart(6)} s  ${r.line}`)
const o = rows.map(r => r.outbox), f = rows.map(r => r.first)
console.log(`\n${rows.length} lines. First model output: median ${pct(f, 0.5)} s, p90 ${pct(f, 0.9)} s. First outbox write: median ${pct(o, 0.5)} s, p75 ${pct(o, 0.75)} s, p90 ${pct(o, 0.9)} s (lines with no write before the next line are skipped).`)
