// node tools/pilot-review.js                      list the latest quick-voice replies and free-time decisions with numbers
// node tools/pilot-review.js mark talker 3 bad "said it can't take screenshots; it can"
// node tools/pilot-review.js mark director 2 good
// node tools/pilot-review.js lesson "never say you are idle"      adds a correction the quick voice sees in every prompt (brain/state/pilot-lessons.txt, last 8 used)
// node tools/pilot-review.js lessons                               show / `lessons clear` to empty
// Walter asked that Claude reviews the small models' choices now and then. This is that loop: verdicts land in brain/state/pilot-feedback.json.
// A director option whose bad verdicts outnumber good ones by 2+ cools down 4x longer (by 4+: 12x); talker verdicts are kept for the next review.
const fs = require('fs')
const path = require('path')
const S = path.join(__dirname, '..', 'brain', 'state')
const rows = (f) => { try { return fs.readFileSync(path.join(S, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse) } catch { return [] } }
const FB = path.join(S, 'pilot-feedback.json')
const LES = path.join(S, 'pilot-lessons.txt')
const readFb = () => { try { return JSON.parse(fs.readFileSync(FB, 'utf8')) } catch { return { options: {}, talker: { good: 0, bad: 0, notes: [] } } } }
const N = 12
const talk = () => rows('talker-log.jsonl').filter(r => r.action === 'say').slice(-N)
const dec = () => rows('pilot-log.jsonl').filter(r => r.kind === 'decision' && r.action !== 'wait').slice(-N)

const [cmd, a, b, c] = process.argv.slice(2)
if (cmd === 'mark') {
  const list = a === 'talker' ? talk() : a === 'director' ? dec() : null
  const row = list && list[Number(b) - 1]
  if (!row || !['good', 'bad'].includes(c)) { console.log('usage: mark talker|director <number> good|bad ["note"]'); process.exit(1) }
  const fb = readFb(); fb.options = fb.options || {}; fb.talker = fb.talker || { good: 0, bad: 0, notes: [] }
  const note = process.argv[6] || ''
  if (a === 'director') { const o = fb.options[row.id] = fb.options[row.id] || { good: 0, bad: 0, notes: [] }; o[c]++; if (note) o.notes = [...(o.notes || []), `${row.t.slice(0, 16)} ${c}: ${note}`].slice(-20) }
  else { fb.talker[c]++; if (note) fb.talker.notes = [...(fb.talker.notes || []), `${row.t.slice(0, 16)} ${c}: "${row.reply}" -> ${note}`].slice(-30) }
  fs.writeFileSync(FB, JSON.stringify(fb, null, 2))
  console.log(`recorded ${c} for ${a} #${b}${a === 'director' ? ' (' + row.id + ')' : ''}`)
} else if (cmd === 'lesson') {
  if (!a) { console.log('usage: lesson "text"'); process.exit(1) }
  fs.appendFileSync(LES, a.replace(/\s+/g, ' ').trim().slice(0, 160) + '\n'); console.log('added')
} else if (cmd === 'lessons') {
  if (a === 'clear') { fs.writeFileSync(LES, ''); console.log('cleared') } else console.log(fs.existsSync(LES) ? fs.readFileSync(LES, 'utf8') : '(none)')
} else {
  const fb = readFb()
  console.log('QUICK VOICE (latest first is the highest number)')
  talk().forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. ${r.t.slice(11, 19)} ${r.ms}ms  Walter: ${r.text.slice(0, 90)}\n      said: ${r.reply}${r.followup === false ? '   [marked complete]' : ''}`))
  console.log('\nFREE-TIME DECISIONS')
  dec().forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. ${r.t.slice(11, 19)} ${r.mode} ${r.action} ${r.id} via ${r.source}${r.p != null ? ' p=' + (+r.p).toFixed(2) : ''}${r.note ? ' (' + r.note + ')' : ''}`))
  console.log(`\nverdicts so far: talker ${JSON.stringify({ good: (fb.talker || {}).good || 0, bad: (fb.talker || {}).bad || 0 })}, options ${JSON.stringify(Object.fromEntries(Object.entries(fb.options || {}).map(([k, v]) => [k, `${v.good}+/${v.bad}-`])))}`)
}
