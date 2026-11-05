// brain/pilot/focus: turns a stored priority directive (directives.js) into a scheduler.focus() call (INTERFACE.md section 12).
// The quick voice names the focus in free words ("the tower", "mining iron"); this maps it to scheduler task names. Unmatched words still hold
// the director's free time (directives.hold) but steer no task.
const TASKS = [
  ['build', /\b(tower|build|building|house|cottage|hall|home|room for myself|personal)\b/i],
  ['mining', /\b(min(e|ing)|iron|diamond|coal|ore|redstone|lapis|copper|gold)\b/i],
  ['treefarm', /\b(tree|trees|wood|chop|chopping|logs?|grove|lumber|sapling)/i],
  ['farm', /\b(farm|farming|crops?|harvest|wheat|carrots?|potato)/i],
  ['furnace', /\b(furnace|furnaces|smelt|smelting|lava|fuel)\b/i],
  ['excavation', /\b(excavat|dig|digging|carv)/i],
  ['lighting', /\b(light|lighting|torch|torches)\b/i],
  ['villager-upkeep', /\b(villager|villagers|trading hall)\b/i],
  ['craft', /\b(craft|crafting)\b/i]
]
const taskFor = (text) => { const t = String(text || ''); for (const [name, re] of TASKS) if (re.test(t)) return name; return null }
const PRIORITY = { now: 65, soon: 60, background: 45 }

// d: a directive entry { id, focus, urgency, persist, minutes, then, avoid, wording, expiresAt } -> { task, suppress, args } | null
// checkCommand(text) -> canonical string | null: lets the caller validate a chained step's command against the real catalog
function plan(d, checkCommand = () => null) {
  const task = taskFor(d.focus) || taskFor(d.wording)
  if (!task) return null
  const suppress = [...new Set((d.avoid || []).map(taskFor).filter(Boolean))].filter(t => t !== task)
  const until = d.persist === 'minutes' ? Math.max(1, d.minutes || 30) * 60000 : d.persist === 'until_told' ? 12 * 3600000 : 'done'
  const maxMs = d.persist === 'until_told' ? 12 * 3600000 : d.persist === 'once' ? 45 * 60000 : d.persist === 'minutes' ? undefined : 3 * 3600000
  // a chain ("tower first, then the iron mine"): later steps in order; the scheduler starts each when the one before is done
  const then = (d.after || []).map(a => ({ task: taskFor(a.focus) || taskFor(a.command), priority: PRIORITY[d.urgency === 'now' ? 'soon' : d.urgency] || 60, until: 'done', note: String(d.wording || '').slice(0, 200), focus: a.focus, ...(a.command && checkCommand(a.command) ? { command: checkCommand(a.command) } : {}) })).filter(s => s.task || s.command)
  return { task, suppress, then, args: { task, priority: PRIORITY[d.urgency] || 60, until, note: String(d.wording || '').slice(0, 200), suppress, resumePrevious: d.then !== 'idle', ...(maxMs ? { maxMs } : {}), ...(then.length ? { then } : {}) } }
}

module.exports = { plan, taskFor, TASKS }
