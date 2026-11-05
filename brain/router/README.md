# brain/router: fast decision router (level 1)

Chat that no brain command, no legacy `handleCommand` rule and no `brain/chat` fuzzy match understood used to wait for the Claude relay
(`chat.log` -> the driver session). The router asks a small **decision model**, `baseten/elephant-1:free` on OpenRouter, which
**one registered command** the line asks for (or `none`) and runs it. Then, if the model cannot tell, the line goes to the fast lane (level 2,
`brain/fastlane`), and then to Claude as before. Claude still drives; the router only handles the obvious.

Level 0 `brain/chat` (local, instant) -> **level 1 `brain/router` (Elephant-1)** -> level 2 `brain/fastlane` (free chat model) -> Claude relay.

## What Elephant-1 is (and is not)
A 9B *decision model*: you send a `state` and typed `questions` (yes/no, choice, ordered score) and get probabilities and a confidence back in one
forward pass. It cannot generate text, so it **cannot write a command or fill a slot**. That fits a safety-first router: it can only pick a label we
sent. Coordinates, counts and item names stay in code (`brain/chat` parsers, `slots.js`). It is called through OpenRouter's **Decisions API**
(`POST https://openrouter.ai/api/alpha/decisions`, bearer key), not chat completions; the path says `alpha`, so expect it to move (it is `url` in `config.json`).
`pi` was not used: it is not on PATH (the global install is a stray half-finished temp folder) and a direct `fetch` is one hop shorter.

Per line, one request with three questions: `directed` (yes/no: is this an order for the bot?), `command` (choice among ~35 commands + `none`),
`place` (choice among the saved waypoints, nearest first, max 60). Request size is about 6 KB (~1.5k tokens, limit 16k).

## Turning it on
1. **Key** (Walter): create a free key at openrouter.ai/keys, then either set the user env var `OPENROUTER_API_KEY` or put the key alone on the first line of
   `brain\router\openrouter.key` (gitignored; read lazily, so adding it later needs no restart). The key is held in memory only, sent only as the `Authorization` header,
   and scrubbed from every error string; no log, status or chat line contains it. Tests assert this.
2. **Integrator:** add `'router'` to `MODULES` in `brain/index.js` **after `'chat'`** (fallback order is load order). Optionally also `'fastlane'` (status only). Nothing in `join.js` changes.
   It uses `api.commands`, `api.events` (the `'chat'` event is how it tells Walter's typing from Claude's `cmd.txt` lines), `api.say`, `api.statePath`, `api.log`.
3. **Modes** (`config.json` `mode`, saved choice in `brain/state/router-mode.json`, env `BOT_ROUTER_MODE` wins). Walter switches live in chat, no restart:
   - `router live` (default since 2026-10-26: Walter wants the models tested in the field): confident low-risk decisions run; everything risky is confirmed (below); the rest goes to Claude. The fast lane tier runs in this mode.
   - `router shadow`: asks the model, writes `brain/state/router-log.jsonl`, does **nothing** else (tiers are skipped unless `tiersInShadow`).
   - `router off`, `router status` (mode, key present, calls ok, median/p95 ms, breaker).
   `BRAIN_DISABLE=router` removes the module entirely.

## What Walter sees in game
- `router status`: two lines, Elephant-1 (lines seen, ran/asked/to Claude, median/p95) and the fast lane (calls, said/ran/asked/passed on, median/p95). `router last`: the last 3 decisions.
- **Silence when the pilot talks** (`config.acks`, default `auto`): if brain/pilot's quick voice tier (`talker`) is registered, the router says NOTHING automatic about lines it hands to Claude (no ack, no early ack, no kind reply); the chat-only Claude / pilot answer. The `'router'` event then carries `silent:true`, `ackText:null` and the `kind`. Without the pilot the acks below remain as a fallback; `always`/`never` force it. Commands, confirmations ("Did you mean ...?") and the on-demand `router status`/`router last` are never silenced.
- **Varied acks** (`acks.js`): a fifth question, `kind` (question / task / idea / feedback / chat), is answered in the same request. When a line goes to Claude, the bot says a fixed short reply for that kind instead of always "Got it, one moment." (rotating, no generation; none promises an action). Unsure kinds fall back to the old ack. A recognised command is never answered with an ack.

## Decisions (`decide.js`, thresholds in `config.json`)
| model says | bot does |
|---|---|
| `none`, or `directed` < 0.5, or command p < 0.55, or an unknown label | Claude (see below) |
| stop-style command (`stay`, `wake up`, `do not fight`...), p >= 0.5 | runs at once, skips the `directed` gate |
| a **high-risk** command (digs, fights, takes items, long job, crafting) | never run on a model's say-so: `Did you mean "excavate"? (yes/no)` |
| low risk, `directed` >= 0.8, p >= 0.8, 0.25 ahead of the runner-up, line <= 100 chars (read-only reports: any length) | runs through `api.commands.dispatch` |
| action asked about in a line over 140 chars, or `directed` < 0.8 | Claude (long/compound lines are Claude's; a field sample showed a long statement about finding a bed would otherwise have run `sleep`) |
| low risk, 0.55 <= p < 0.8 or too close to call | `Did you mean "..."? (yes/no)` |
| `goto-waypoint` | runs only if the `place` answer is a real waypoint with p >= 0.6; canonical follows the chat module's rules (names that `handleCommand` cannot parse become coordinates) |

Confirmation: 30 s, owner only, answered in `onChat` (step 2) so a bare "yes" never reaches the legacy rules; any other line abandons the question.
Only the owner (`OGWO`) is ever served. After the await, an answer is dropped (and goes to Claude) when it is older than `staleMs` (10 s) or a later line contains stop/wait/cancel/etc.

## Failure and fallback (live mode)
No key, breaker open, daily budget used, or a request already in flight: the router **does not take the line** (`fallback` returns false) and the integrator logs `unhandled.log` and
says its usual ack, exactly as without the router. Once a request is in flight the router owns the hand-off: on `none`, low confidence, timeout (3 s), 429, 5xx, bad JSON or any
exception it appends `unhandled.log`, says the same ack (`Got it, one moment.` / `Let me think about that.`, once; also sent early if the model takes over 2.5 s), and Claude
reads `chat.log` as before. Breaker: 3 consecutive failures pause calls 60 s; 429 honours `retry-after`/`x-ratelimit-reset`; 401/402 pause 10 min. `maxPerDay` (100000 since Walter's key has a monthly budget; 45 was for the free tier) is a local
budget because free OpenRouter models are capped (reported: 20 requests/min, 50/day without purchased credits, 1000/day with); the real cap for this model is **unverified**. The fast lane shares the same account cap.

## Escalation hook (level 2 and anything after)
The router publishes `api.router = { addTier, validate, tiers }` (set in `register`, so other modules call it from their `start()`).
```js
api.router.addTier('name', async (ctx) => result, { timeoutMs: 6000 })
// ctx   = { user, text, shadow, state, previous:[{tier,action,reason,label,p,directed}], signal, timeoutMs,
//           catalog:{ options:[{label,canonical,risk,instant,desc}], waypoints:[{name,canonical}] },
//           validate(commandString) -> {ok,canonical,risk,shown,instant}|{ok:false,reason},
//           rawCatalog, reg }                      // rawCatalog/reg: for tiers that build their own prompts
// result = { action:'run',   canonical, confidence? }   // low-risk commands run; high-risk are turned into a confirmation
//        | { action:'ask',   canonical }                // always confirmed
//        | { action:'reply', text, handoff? }           // said in chat (<= 220 chars, control chars and a leading "/" stripped); handoff:true also writes unhandled.log
//        | { action:'defer', reason? } | null           // next tier, then Claude
```
Tiers run in registration order after level 1 defers (any reason except `stale`/`superseded`), each with its own timeout and `AbortSignal`; throwing, timing out or returning garbage just means "defer".
**Every `canonical` is re-checked by `slots.js`** before anything happens: a catalog command, `go to x [y] z` (coordinate limits), `go to <waypoint>`, `find <block>` (registry), `craft <item> [n]`
(registry, 1..2304, always confirmed), `save waypoint <name>`. Nothing else can be dispatched. The fast lane (`brain/fastlane`, `createFastlane`) is wired in automatically when its folder exists
(`config.fastlane: false` disables); in shadow mode tiers are skipped unless `tiersInShadow` is true, so shadow does not spend the shared daily allowance.

## Files
`index.js` module glue, modes, confirmation, tiers · `decide.js` request + interpretation (pure) · `catalog.js` closed command list · `slots.js` command validation · `client.js` HTTP, key, timeout, breaker ·
`config.json` · `bench.js` · `.gitignore` (key file). Written: `brain/state/router-log.jsonl` (256 KB cap: text, decision, p, ms; never the key) and `router-mode.json`. Appends `unhandled.log` only for hand-offs.
Tests: `node --test test/router.test.js test/router.tiers.test.js` (offline, fake fetch; they never touch the network).

## Measuring latency (needs the key)
`node brain/router/bench.js --n 25` sends a spread of the labelled phrase corpus (`test/chat.phrases.js`, incl. Walter's real lines) at 3.2 s spacing and prints per-line decision, cold first call, warm median/p95/max
and accuracy; `--lines chat.log` replays real chat; `--dry` shows the catalog and request size without the network. `router status` in game reports the live median/p95.
Measured 2026-10-26 with Walter's key, 25 lines, 3.2 s apart: Elephant-1 **cold first call 431 ms, warm median 177 ms, p95 416 ms, max 785 ms, 0 errors**; 22/25 against the labelled corpus (the misses are stop phrases and "are you hungry?", which brain/chat already handles before the router sees them). Request ~6 KB.

## Known limits
- English; one command per line; compound requests ("find a table and craft tools") go to Claude. `find`, `craft`, coordinates and `save waypoint` are only available through level 2 (they need free text) or `brain/chat`.
- Elephant-1 has no "unsure" beyond its probabilities; thresholds are guesses until the shadow log has real data (`router-log.jsonl`: look at `p` of lines you would have wanted run).
- The model is five days old with a single provider; the fallback to Claude is the safety net.
- The free tier may log prompts. The request holds the chat line, health/food, the current task name and waypoint names, no coordinates.
