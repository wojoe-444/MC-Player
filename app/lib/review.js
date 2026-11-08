// "review" trigger: every few minutes, hand the bots' recent logs to a headless `claude -p --model haiku` session
// and keep its written review. Read-only for now: it can read files, nothing else. Later triggers can reuse
// collectBotEvidence() / runClaude() to act on the bots instead of only describing them.
const fs = require('fs')
const path = require('path')
const { runClaude } = require('./claude')

const BOTS = (cfg) => [
  { id: 'ozo', name: 'OzoGo444', dir: cfg.dashboard.ozoDir },
  { id: 'smeo', name: 'Smeo444', dir: cfg.dashboard.smeoDir },
]

function tailText(file, maxBytes) {
  let fd
  try {
    const st = fs.statSync(file)
    fd = fs.openSync(file, 'r')
    const start = Math.max(0, st.size - maxBytes)
    const buf = Buffer.alloc(st.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    let s = buf.toString('utf8')
    if (start > 0) s = s.slice(s.indexOf('\n') + 1) // drop the cut-off first line
    return s.trimEnd()
  } catch { return null } finally { if (fd !== undefined) try { fs.closeSync(fd) } catch {} }
}

function fileSig(file) {
  try { const st = fs.statSync(file); return `${st.size}:${Math.floor(st.mtimeMs)}` } catch { return 'none' }
}

// Files whose growth means "something happened since the last review".
const WATCHED = ['idle.log', 'join.log']
const TAILS = [
  ['idle.log', 6000, 'what the bot did recently'],
  ['join.log', 4000, 'connection, chat and server messages'],
  [path.join('brain', 'state', 'lessons.md'), 2500, 'lessons the bot wrote about itself'],
  [path.join('brain', 'state', 'hurt.json'), 2000, 'damage by cause'],
  [path.join('brain', 'state', 'think-log.jsonl'), 3000, 'planner decisions'],
]

function collectBotEvidence(bot) {
  const sections = []
  for (const [rel, bytes, what] of TAILS) {
    const t = tailText(path.join(bot.dir, rel), bytes)
    if (t) sections.push(`### ${rel.replace(/\\/g, '/')} (${what}, last ~${bytes} bytes)\n${t}`)
  }
  const signature = WATCHED.map(f => fileSig(path.join(bot.dir, f))).join('|')
  return { bot, sections, signature, exists: fs.existsSync(bot.dir) }
}

const INSTRUCTIONS = `You are reviewing two Minecraft bots (OzoGo444 and Smeo444) for their owner, Walter, from their recent logs.
The bots are independent players in a shared world, not tools: judge whether they are making progress, and say what you would change in
how they are played, in a friendly, honest, short voice. Do not invent facts that the logs do not show.

Write Markdown, at most 180 words, with these parts:
1. **Status** - one line per bot: alive/dead/disconnected/idle, and what it is working on.
2. **Problems** - stalls, loops, repeated failures, deaths, damage patterns. "None seen" is a fine answer.
3. **Suggested next steps** - up to 3 concrete suggestions (what a driver should tell or change for the bot).
If nothing meaningful happened since the logs began, say so in one line instead.`

function buildPrompt(evidence, now = new Date()) {
  const parts = [INSTRUCTIONS, `\nCurrent time: ${now.toISOString()}\n`]
  for (const e of evidence) {
    parts.push(`\n## ${e.bot.name} (folder: ${e.bot.dir})`)
    if (!e.exists) parts.push('(bot folder not found)')
    else if (!e.sections.length) parts.push('(no logs found)')
    else parts.push(e.sections.join('\n\n'))
  }
  return parts.join('\n')
}

function createReviewTrigger({ reviewsDir, getConfig, run = runClaude, now = () => new Date() }) {
  let lastSignature = null
  const trigger = {
    id: 'review',
    title: 'Review bot logs with headless Claude',
    async run() {
      const cfg = getConfig()
      const evidence = BOTS(cfg).map(collectBotEvidence)
      if (!evidence.some(e => e.exists)) return { ok: false, summary: 'No bot folders found. Check the paths in settings.' }
      const signature = evidence.map(e => e.signature).join('||')
      if (signature === lastSignature) return { ok: true, skipped: true, summary: 'No new log activity since the last review; skipped.' }
      fs.mkdirSync(reviewsDir, { recursive: true })
      const res = await run({
        command: cfg.claude.command, model: cfg.claude.model, timeoutMs: cfg.claude.timeoutMs,
        prompt: buildPrompt(evidence, now()), cwd: reviewsDir,
        addDirs: evidence.filter(e => e.exists).map(e => e.bot.dir),
      })
      if (!res.ok) return { ok: false, summary: res.error }
      lastSignature = signature
      const at = now().toISOString()
      fs.mkdirSync(reviewsDir, { recursive: true })
      const file = path.join(reviewsDir, at.replace(/[:.]/g, '-') + '.md')
      fs.writeFileSync(file, `<!-- ${at} model=${cfg.claude.model} ${res.durationMs}ms -->\n${res.text}\n`)
      return { ok: true, at, file, text: res.text, summary: res.text.split('\n').find(l => l.trim()) || 'Review done', costUsd: res.costUsd }
    },
  }
  return trigger
}

function listReviews(reviewsDir, limit = 20) {
  try {
    return fs.readdirSync(reviewsDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, limit)
      .map(f => ({ name: f, at: f.slice(0, -3), text: fs.readFileSync(path.join(reviewsDir, f), 'utf8').replace(/^<!--.*-->\n/, '') }))
  } catch { return [] }
}

module.exports = { createReviewTrigger, listReviews, buildPrompt, collectBotEvidence, tailText }
