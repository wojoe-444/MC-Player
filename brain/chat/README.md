# brain/chat: understanding Walter's chat

Local, offline, no model. Turns free-form chat ("can u pls folow me", "come meet me where I am now, at the farm?", "go to x=100 z=-200",
"stpo") into the canonical command strings that the brain command table and the legacy `handleCommand()` already understand.
It runs at the **fallback** step (INTERFACE.md §3 step 5): only lines that nothing else recognised reach it.

## Files
| file | what |
|---|---|
| `index.js` | `register(api)` -> `{ name:'chat', onChat, fallback, status }`. Thin glue to the brain api. |
| `matcher.js` | `create({...})`: the whole engine; pure, injectable, used directly by the tests. |
| `intents.js` | the intent table (phrases, canonical strings, risk). Add phrasings here. |
| `text.js` | normalising, stop words, slang table, typo distance. |
| `../../test/chat.test.js`, `chat.legacy.test.js`, `chat.phrases.js` | tests and the phrasing corpus. |

Written files: only `api.statePath('chat-nearmiss.jsonl')` (capped at 256 KB). Reads `waypoints.json` (re-read when it changes).
Nothing else; no timers, no listeners, no process handlers.

## What it does
1. **Clean up**: lowercase, strip accents/emoji/quotes, drop "hey bot", "please", "can you", "for a second", leading `!`. Slash lines never match.
2. **Slots first**: coordinates (`100 64 -200`, `(100, 64, -200)`, `x=100 z=-200`, `100/64/-200`, F3 decimals), "save/remember this place as X",
   "go to <waypoint>" (fuzzy, partial names, typos, `go home` = House, Xaero names with coordinates in them), `find <block>` (registry names,
   plurals, ore), item questions ("how many torches do you have" -> `inventory`).
3. **Bag of words** against the phrase table, with typo repair (`folow`, `stpo`, `harvet`, `followme`) and a penalty for words the phrase does not
   explain, so statements that merely mention a command word ("this is the room we need to excavate the ceiling from") are ignored.
4. **Multi-sentence lines** are judged sentence by sentence ("you'll need to monitor your hunger... can you come meet me at the farm?" -> farm).
5. **Decision** (`decide`): `run` / `ask` / `say` / `none`.

| situation | result |
|---|---|
| stop/stay/wait/freeze (any wording, even "stop doing that") | runs at once, never confirmed, never blocked by an open question |
| read-only intents (inventory, status, where, time, ...) | runs from score 0.7 |
| movement/other low-risk | runs from 0.8; 0.55-0.8 asks `Did you mean "..."? (yes/no)` |
| high-risk jobs (harvest, craft, index, inspect, furnace-start, excavate, resume, fight) | exact phrase runs; any typo is confirmed first; weak matches (<0.75) are dropped silently |
| ambiguous waypoint ("go to portal") | `Which portal? 1) ... 2) ...` nearest first; answer with number, "the second", a name, or a coordinate |
| negation | "don't follow me" / "don't come" = stay; other negated jobs do nothing |
| no match | returns false: the integrator logs `unhandled.log` and sends its usual ack. The chat module never answers noise. |

A question stays open for 30 s; any other line abandons it. Answers are consumed in `onChat` (step 2) so a bare "yes" never reaches the legacy rules.

**Topic memory** (per user): `do that again` / `once more` repeats the last command that ran; `go there` / `go back there` reuses the last `go to ...`.
Only commands that actually dispatched successfully are remembered.

**Only the owner** (`api.ownerName`, "OGWO") is obeyed.

**Brain-native intents** (furnace-*, queue, resume, fight, mobs, dashboard) are only offered when `commands.list()` contains their canonical string,
and every other registered command becomes matchable from its `help` text (`"canonical | alt phrase | alt phrase"`), so new modules get fuzzy chat for free.

## Crafting and find (brain/crafting)
Offered only when `commands.list()` has `craft-item` / `find-item` (or when there is no command list, as in unit tests).
- `craft <item> [count]`: "make me some torches" -> `craft torch`, "can u craft 10 glass panes" -> `craft glass pane 10`, "make 4 chests", "a stack of sticks" -> `craft stick 64`,
  "a dozen torches", "make yourself a stone pickaxe". Item words are checked against the registry: exact (plural ok) runs; a family word ("planks", "pickaxe") is passed as typed so brain/crafting
  asks "Which one?"; a typo ("galss panes") or a single partial hit is confirmed first (`Did you mean "craft glass pane 10"? (yes/no)`); unknown words ("make it rain", "make sure you...") are not claimed.
  "craft tools", "make yourself a tool set" stay with the legacy tool-set intent.
- `find <thing>`: blocks as before; plain items ("find iron ingots") are added so brain/crafting's bag + chest search answers.
- Help texts containing `<...>`/`[...]` are not turned into literal phrases.

## Canonical strings it can emit
`follow me`, `come here`, `stay`, `inventory`, `status`, `what are your coordinates`, `what's around`, `what time is it`, `who's nearby`, `wake up`, `sleep`,
`list waypoints`, `describe the room`, `scan furnaces`, `harvest crops`, `store crops`, `farm routine on|off`, `index chests`, `inspect stations`, `craft tool set`,
`hi`, `excavation status`, `resume excavation`, `excavate`, `go to X Y Z`, `go to X Z`, `go to <waypoint>`, `save waypoint <name>`, `find <block>`,
plus the brain-native ones above and any registered command's first help alternative.
`test/chat.legacy.test.js` cuts `handleCommand()` out of the live `join.js` (read only) and checks each legacy-handled string hits the intended branch,
so a future edit to `join.js` that breaks a canonical string fails the tests.

## Limits
- English only, one intent per line (compound orders like "find a table and craft tools" are left to Claude; a `stop` always wins).
- Orders must start with the verb ("go/walk/come/head/meet/take me/..."): "the farm is nice" and "you would take buckets to the depot" are ignored on purpose.
- It does not know what is *possible*: `go to <far waypoint>` is passed on and `handleCommand` says it is out of range.
- Waypoint names that the legacy lookup cannot parse ("the first base", names with parentheses) are sent as coordinates instead.
- `craft <item>` is only emitted when brain/crafting is registered (legacy `craft` always makes the tool set).
- Legacy `find` strips a trailing `s` from the name (`find glass` looks for "glas"); not fixable from here.
- Short typos only: 4 letters or fewer get one edit, 8+ get two; a word that is a prefix of a command word ("sleepy") is not treated as a typo.
- `brain/nlu.js` (the first draft) is superseded by this folder and no longer used by anything; safe to delete.

## Tuning
`node --test test/chat.test.js test/chat.legacy.test.js` (about 3 s). `chat-nearmiss.jsonl` lists lines that scored 0.35-0.55 against some intent: good candidates
for new phrases in `intents.js`; `unhandled.log` (integrator) holds everything else. Add the new phrasing to `test/chat.phrases.js` first.
