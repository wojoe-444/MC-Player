// Short instant replies for lines that go to Claude, chosen by what kind of line it is (Elephant-1's `kind` answer).
// No text is generated: the model only picks a kind, the words are fixed here. None promises an action or sounds like an order was taken: the bot is a player, not a servant (CLAUDE.md).
const ACKS = {
  question: ['Let me think about that.', 'Good question, let me check.', 'Hmm, let me look into that.'],
  task: ['Okay, let me work out how.', 'Noted, I will see what I can do.', 'Alright, looking into it.'],
  idea: ['Interesting idea, noted.', 'Noted, that goes on the list.', 'I will chew on that.'],
  feedback: ['Thanks, noted.', 'Understood, I will flag that.', 'Heard you, noted.'],
  chat: ['Heard you.', 'Got it.', 'Okay!']
}
const KINDS = Object.keys(ACKS)
const turn = {}

// -> a reply for `kind`, or null (unknown kind). Rotates so the same words never repeat back to back.
function pick(kind) {
  const list = ACKS[kind]
  if (!list) return null
  turn[kind] = ((turn[kind] ?? -1) + 1) % list.length
  return list[turn[kind]]
}

module.exports = { ACKS, KINDS, pick }
