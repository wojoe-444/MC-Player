// Pure part of the router: build the Decisions request for one chat line and turn the model's answer into an action.
// No network, no bot. The model only chooses among labels we sent; anything else is rejected here.
const { NONE, GOTO, NONE_DESC } = require('./catalog')
const { KINDS } = require('./acks')

const DEFAULTS = { infoDirected: 0.9, infoMaxChars: 60, actMaxChars: 100, askMaxChars: 140, directed: 0.8, run: 0.8, margin: 0.25, ask: 0.55, instant: 0.5, place: 0.6 }

// state: { message, recent_chat?, doing?, last_command?, health?, food?, ... } (small JSON; no coordinates)
function buildRequest({ model, state, catalog }) {
  const criteria = {}
  for (const o of catalog.options) criteria[o.label] = o.desc
  criteria[NONE] = NONE_DESC
  const questions = {
    directed: {
      type: 'noul',
      instructions: 'Is the message a short order or question aimed at the Minecraft bot itself, asking it to act now or to report something about itself (where it is, its health, the time, what it carries or is doing), as opposed to conversation between players, a statement, feedback, planning or design talk, or a question for the AI assistant?',
      criteria: { true: 'A short order for the bot, or a question about the bot or its current state.', false: 'Conversation, statement, feedback, thinking out loud, or a request that needs the AI assistant.' }
    },
    command: {
      type: 'choice',
      instructions: 'Which single bot command does the message ask for? Choose "none" unless one command is clearly requested.',
      criteria
    }
  }
  questions.kind = {
    type: 'choice',
    instructions: 'What kind of message is this, as a conversation turn?',
    criteria: {
      question: 'A question that needs thought or investigation (why, how, what do you think, is X being used).',
      task: 'A request for work, a change or a new behavior to be done or built.',
      idea: 'A suggestion, wish or idea for how things could work in future.',
      feedback: 'An observation, correction, status comment or report of a problem.',
      chat: 'A casual remark, thanks or banter.'
    }
  }
  if (catalog.byLabel.has(GOTO)) {
    const places = {}
    for (const w of catalog.waypoints) places[w.name] = `saved place "${w.name}"`
    questions.place = { type: 'choice', instructions: 'If the message asks the bot to go to a saved place, which place is it?', criteria: places }
  }
  return { model, state, questions }
}

const prob = (a, label) => {
  if (!a) return 0
  const p = a.probabilities && a.probabilities[label]
  return typeof p === 'number' ? p : (label === a.choice && typeof a.confidence === 'number' ? a.confidence : 0)
}

// -> { action: 'run'|'ask'|'defer', reason, label?, canonical?, risk?, p?, margin?, directed?, place? }
// meta: { len } = length of the chat line
function interpret(resp, catalog, th = {}, meta = {}) {
  th = { ...DEFAULTS, ...th }
  const answers = resp && resp.answers
  const cmd = answers && answers.command
  if (!cmd || cmd.type !== 'choice' || typeof cmd.choice !== 'string') return { action: 'defer', reason: 'malformed' }
  const directed = answers.directed && typeof answers.directed.noul === 'number' ? answers.directed.noul : null
  const choice = cmd.choice
  const out = { directed, label: choice }
  if (choice === NONE) return { ...out, action: 'defer', reason: 'none', p: prob(cmd, NONE) }
  const opt = catalog.byLabel.get(choice.toLowerCase())
  if (!opt) return { ...out, action: 'defer', reason: 'unknown-label' }
  const p = prob(cmd, choice)
  let second = 0
  for (const [k, v] of Object.entries(cmd.probabilities || {})) if (k !== choice && typeof v === 'number' && v > second) second = v
  const margin = +(p - second).toFixed(3)
  Object.assign(out, { p, margin, risk: opt.risk })
  // a stop must never be held up by the "directed" gate
  if (opt.instant) return p >= th.instant ? { ...out, action: 'run', canonical: opt.canonical, reason: 'instant' } : { ...out, action: 'defer', reason: 'low-confidence' }
  // read-only reports are harmless: a short, very confident one is answered even when the 'directed' gate is unsure about a question
  const infoOk = opt.info && p >= th.infoDirected && (meta.len || 0) <= th.infoMaxChars
  if (directed !== null && directed < th.directed && !infoOk) return { ...out, action: 'defer', reason: 'not-directed' }
  if (p < th.ask) return { ...out, action: 'defer', reason: 'low-confidence' }

  let canonical = opt.canonical, shown = opt.canonical
  if (choice === GOTO) {
    const pl = answers.place
    const w = pl && pl.type === 'choice' && catalog.waypoints.find(x => x.name === pl.choice)
    const pp = w ? prob(pl, pl.choice) : 0
    if (!w || pp < th.place) return { ...out, action: 'defer', reason: 'no-place', place: w ? w.name : null }
    canonical = w.canonical; shown = 'go to ' + w.name.toLowerCase(); out.place = w.name
  }
  out.canonical = canonical; out.shown = shown
  // compound or rambling requests are Claude's, not a yes/no question (brain/chat leaves them to Claude too)
  if (!opt.info && (meta.len || 0) > th.askMaxChars) return { ...out, action: 'defer', reason: 'too-long' }
  // anything that digs, fights, takes items or starts a long job is never run on a model's say-so; fuzzy confidence: ask first
  if (opt.risk === 'high') return { ...out, action: 'ask', reason: 'high-risk' }
  // a long line that merely mentions an action ("... find a bed when it gets dark ...") is asked about, never run
  if (p >= th.run && margin >= th.margin && (opt.info || (meta.len || 0) <= th.actMaxChars)) return { ...out, action: 'run', reason: 'confident' }
  return { ...out, action: 'ask', reason: 'unsure' }
}

// -> { kind, p } when the model is sure enough what kind of line this was (for a fitting instant reply), else null
function pickKind(resp, min = 0.5) {
  const k = resp && resp.answers && resp.answers.kind
  if (!k || k.type !== 'choice' || !KINDS.includes(k.choice)) return null
  const p = prob(k, k.choice)
  return p >= min ? { kind: k.choice, p } : null
}

module.exports = { buildRequest, interpret, pickKind, DEFAULTS }
