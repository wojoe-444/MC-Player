// Findings persistence. Per bot (inside the bot folder, where the driver thread and the dashboard already look):
//   brain/state/review/findings.json   latest state: open findings with first/last seen, recently resolved, last run
//   brain/state/review/history.jsonl   one line per run
//   REVIEW-FINDINGS.md                 the same, readable (next to chat.log)
const fs = require('fs')
const path = require('path')

const RANK = { high: 3, med: 2, low: 1 }
const MAX_MISSED = 2          // an open finding the model neither repeats nor resolves for 2 runs is closed as "no longer seen"

const dirOf = (bot) => path.join(bot.dir, 'brain', 'state', 'review')
const fileOf = (bot) => path.join(dirOf(bot), 'findings.json')
function load(bot) { try { return JSON.parse(fs.readFileSync(fileOf(bot), 'utf8')) } catch { return null } }

// deterministic high-severity detector flags the model did not cover still reach the findings
const DETECTOR_KIND = { jumping: 'excessive_jumping', pillar_failing: 'pillar_failing', oscillating: 'oscillating', stuck: 'stuck', idle: 'idle', wrong_tool: 'wrong_tool', cannot_harvest: 'wrong_tool', no_tool: 'wrong_tool', staircase: 'staircase', surface_blocks: 'surface_blocks', torch_spacing: 'torch_spacing', repeated_failure: 'repeated_failure', lava_in_hand: 'rule_violation' }

function detectorFindings(bot, flags, covered) {
  const out = []
  for (const f of flags || []) {
    if (f.sev !== 'high') continue
    const kind = DETECTOR_KIND[f.kind] || 'other'
    if (covered.some(c => c.kind === kind)) continue
    out.push({ key: `${bot.id}-detector-${f.kind}`, kind, severity: 'high', confidence: 'med', title: `Detector: ${f.kind.replace(/_/g, ' ')}`.slice(0, 80), evidence: f.msg, suggestion: 'Raised by the in-bot detector; the model did not comment on it. Watch the bot and check the flagged window.', source: 'detector' })
  }
  return out
}

// merge one run's answer for one bot into the stored state; pure (returns the new state)
function merge(prev, bot, answer, { now, run, evidence, age = true }) {
  const at = new Date(now).toISOString()
  const open = new Map(((prev && prev.open) || []).map(f => [f.key, f]))
  const resolved = [...((prev && prev.recentlyResolved) || [])]
  const seen = new Set()
  const incoming = [...(answer.findings || []), ...detectorFindings(bot, evidence && evidence.activeDetectorFlags, answer.findings || [])]
  for (const f of incoming) {
    seen.add(f.key)
    const old = open.get(f.key)
    open.set(f.key, { source: 'model', ...f, firstSeen: old ? old.firstSeen : at, lastSeen: at, seenRuns: (old ? old.seenRuns : 0) + 1, missedRuns: 0 })
  }
  for (const key of answer.resolved || []) {
    const old = open.get(key)
    if (old && !seen.has(key)) { open.delete(key); resolved.unshift({ ...old, resolvedAt: at, why: 'no longer happening' }) }
  }
  for (const [key, f] of [...open]) {
    if (seen.has(key) || !age) continue
    const missed = (f.missedRuns || 0) + 1
    if (missed >= MAX_MISSED) { open.delete(key); resolved.unshift({ ...f, resolvedAt: at, why: 'not seen in the last runs' }) } else open.set(key, { ...f, missedRuns: missed })
  }
  return {
    bot: bot.name, id: bot.id, updatedAt: at, status: open.size ? 'issues' : 'ok', summary: answer.summary || '',
    open: [...open.values()].sort((a, b) => (RANK[b.severity] - RANK[a.severity]) || (b.lastSeen > a.lastSeen ? 1 : -1)),
    recentlyResolved: resolved.slice(0, 15),
    lastRun: run,
  }
}

function offlineState(prev, bot, { now, run, reason }) {
  const at = new Date(now).toISOString()
  return { ...(prev || { open: [], recentlyResolved: [] }), bot: bot.name, id: bot.id, updatedAt: at, status: 'offline', summary: reason, lastRun: run }
}

function toMarkdown(s, { model } = {}) {
  const L = [`# Review findings: ${s.bot}`, '', `_Updated ${s.updatedAt}${model ? ` by ${model}` : ''}. Status: **${s.status}**. ${s.summary || ''}_`, '',
    'Written by the spectator reviewer (reviewer/). Read by the driver thread and shown in the Bot Dashboard app. Never posted to game chat.', '']
  if (!s.open.length) L.push(s.status === 'offline' ? '_Bot looks offline; nothing reviewed._' : '_No open findings._', '')
  for (const f of s.open) {
    L.push(`## [${f.severity.toUpperCase()}] ${f.title}`, `\`${f.key}\` · ${f.kind} · confidence ${f.confidence} · first seen ${f.firstSeen} · seen in ${f.seenRuns} run(s)${f.source === 'detector' ? ' · detector only' : ''}`, '',
      `**Evidence:** ${f.evidence}`, '', `**Suggestion:** ${f.suggestion}`, '')
  }
  if ((s.detectorEvents || []).length) {
    L.push('## Detectors the reviewer wrote', '', 'Small non-blocking checks the reviewer turns judgement into. Enabled only after replaying them on captured telemetry (fires on the bad window, quiet on normal play). Source and origin: brain/state/detectors/.', '')
    for (const e of s.detectorEvents.slice().reverse()) L.push(e.action === 'enabled'
      ? `- ENABLED \`custom_${e.name}\` (${e.at}): ${e.title || ''}. ${e.why || ''} Fired on ${e.validated.firedOnBad.length}/${e.validated.badWindows.length} bad windows, ${e.validated.firedOnNormal.length}/${e.validated.normalWindows} normal.`
      : `- rejected \`${e.name}\` (${e.at}): ${e.reason}`)
    L.push('')
  }
  if (s.recentlyResolved.length) {
    L.push('## Recently resolved', '')
    for (const f of s.recentlyResolved.slice(0, 8)) L.push(`- ${f.title} (\`${f.key}\`) resolved ${f.resolvedAt}: ${f.why}`)
    L.push('')
  }
  return L.join('\n')
}

function save(bot, state, { model } = {}) {
  fs.mkdirSync(dirOf(bot), { recursive: true })
  const tmp = fileOf(bot) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1)); fs.renameSync(tmp, fileOf(bot))
  fs.appendFileSync(path.join(dirOf(bot), 'history.jsonl'), JSON.stringify({ at: state.updatedAt, status: state.status, summary: state.summary, open: state.open.map(f => `${f.severity}:${f.key}`), run: state.lastRun }) + '\n')
  try { fs.writeFileSync(path.join(bot.dir, 'REVIEW-FINDINGS.md'), toMarkdown(state, { model })) } catch {}
  trimHistory(bot)
}
function trimHistory(bot) {
  const f = path.join(dirOf(bot), 'history.jsonl')
  try { if (fs.statSync(f).size > 512 * 1024) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-400).join('\n') + '\n') } catch {}
}

module.exports = { load, save, merge, offlineState, toMarkdown, detectorFindings, fileOf, dirOf, MAX_MISSED }
