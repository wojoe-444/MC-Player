// Text helpers for the chat matcher: normalisation, tokenising, edit distance. Pure, no I/O.

// Words that carry no command meaning. Removed from BOTH the phrase table and the user text, so the table can be written naturally.
const STOP = new Set((
  'a an the please plz pls can could would will shall you u ya your-not i id ill im ive hey hi hello yo hiya ' +
  'your bot ozogo444 ozogo ozo claude buddy pal mate dude bro man just now rn right quick quickly real really actually kinda maybe ' +
  'for of is are was were do does did it its this that these those and or then also so if we lets us let thanks thx thank ' +
  'kindly want wanna need needs gotta gonna going go-ahead ahead to too lol haha yeah yep yes sure alright all-right ' +
  'some any-of my our with-me please-do oh um uh hmm well anyway'
).split(/\s+/).filter(w => !w.includes('-')))
// "go", "me", "here", "there", "to-me" are meaningful, so they are NOT stop words ("to" is: "come to me" == "come me" on both sides).

// Slang, contractions and shorthand -> what the phrase table expects. A value with spaces expands to several tokens.
const FIX = {
  whats: 'what', whos: 'who', hows: 'how', wheres: 'where', ur: 'your', r: 'are', gimme: 'give', dont: 'dont', cant: 'cant',
  tmrw: 'tomorrow', bout: 'about', inv: 'inventory', invent: 'inventory', inven: 'inventory', invo: 'inventory', coords: 'coordinates', cords: 'coordinates', coord: 'coordinates',
  hp: 'health', hearts: 'health', hunger: 'hungry', cmere: 'come here', comere: 'come here', commere: 'come here', cmon: 'come',
  stahp: 'stop', stp: 'stop', hault: 'halt', nvm: 'never mind', nevermind: 'never mind', followme: 'follow me', folowme: 'follow me',
  gotobed: 'go to bed', zzz: 'sleep', nite: 'night', tonite: 'tonight', xp: 'experience', pos: 'position', loc: 'location',
  wp: 'waypoint', wps: 'waypoints', waypoint: 'waypoint', mobs: 'mobs', zombies: 'zombies', ya: 'you', thx: '', plz: '', pls: '',
  asap: '', immediately: '', immediatly: '', ugh: '', pleeease: '', pleaseee: ''
}

const NUM_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, a: 1, an: 1, couple: 2, few: 3, dozen: 12 }

// lowercase, strip accents/emoji/quotes, collapse whitespace. Keeps digits, '-', '.', ',', '(', ')', '=', ':' and '/' for coordinates.
function clean(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[−–—]/g, '-')
    .replace(/&/g, ' and ')
    .replace(/[^\x20-\x7e]/g, ' ')            // emoji and anything else non-ascii
    .replace(/\s+/g, ' ').trim()
}

// "@ozogo444, hey! follow me" -> "follow me". Leading bang/dot commands ("!follow") are accepted; a leading "/" never is.
function stripAddress(s) {
  let t = s
  for (let i = 0; i < 3; i++) {
    t = t.replace(/^[!.#>~*\s]+/, '').replace(/^@?(?:ozogo444|ozogo|ozo|bot|claude|buddy|pal|mate|dude|bro)\b[\s,:;!-]*/, '').replace(/^(?:hey|hi|yo|ok|okay|so|um|uh|well|oh|alright|right|yeah|yep|yes|sure|then|and|but|please|pls|plz)\b[\s,:;!-]*/, '')
  }
  return t.replace(/[\s,]*(?:ozogo444|ozogo)[\s!?.]*$/, '').trim()
}

// Words only: apostrophes dropped ("let's"->"lets"), everything non-alphanumeric splits. Numbers stay as tokens.
function words(s) {
  return s.replace(/'/g, '').replace(/[^a-z0-9\-\s]/g, ' ').replace(/(^|\s)-+(?=\s|$)/g, ' ').split(/\s+/).filter(Boolean)
}

const stem = (w) => w.length < 5 ? w : w.replace(/(ing|ed|es|er|s)$/, '')

// Damerau-Levenshtein (optimal string alignment).
function dl(a, b) {
  const al = a.length, bl = b.length
  if (!al) return bl
  if (!bl) return al
  const d = Array.from({ length: al + 1 }, (_, i) => { const r = new Array(bl + 1).fill(0); r[0] = i; return r })
  for (let j = 0; j <= bl; j++) d[0][j] = j
  for (let i = 1; i <= al; i++) for (let j = 1; j <= bl; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c)
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
  }
  return d[al][bl]
}
const sim = (a, b) => 1 - dl(a, b) / Math.max(a.length, b.length, 1)

// Typo budget by length: short words get none (to avoid "bed"->"bad"), 5-7 letters one edit, 8+ two.
const typoBudget = (len) => len <= 3 ? 0 : len <= 4 ? 1 : len <= 7 ? 1 : 2

module.exports = { STOP, FIX, NUM_WORDS, clean, stripAddress, words, stem, dl, sim, typoBudget }
