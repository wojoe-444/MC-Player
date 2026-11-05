# brain/fastlane: router escalation level 2

A second fast tier behind `brain/router` (Elephant-1) and in front of the Claude relay. It calls OpenRouter's free chat router
(`model: "openrouter/free"`, `POST /api/v1/chat/completions`) directly over HTTP (no pi CLI needed).
It covers what the decision model struggles with: short free-text replies, filling command slots (coordinates, saved place, block, item) and
ambiguous quick asks. Claude still drives everything complex.

**It never acts.** `decide()` returns a decision; the router executes, asks, says or escalates.

## Interface (already wired by brain/router/index.js as tier `fastlane`)

```js
const { createFastlane } = require('../fastlane')
const fl = createFastlane({ now, env, fetch, keyFile, log, statePath, config, validate })   // validate = router/slots.js validate
fl.wants(level1Decision, text)       // sync, no network
fl.available()                       // sync: { ok } | { ok:false, reason: no-key | breaker:<why> | budget | busy }
const r = await fl.decide({ user, text, state, catalog, reg, deadlineMs })   // never throws
// r = { action: 'run'|'ask'|'say'|'escalate', reason, canonical?, shown?, risk?, reply?, confidence?, partial?, ms, model, cached?, level: 2 }
fl.status()                          // calls, ok, errors, latencyMs {p50,p95,max}, breaker, byReason, today/maxPerDay, recent
```

`catalog` is `router/catalog.build()` output, `reg` is `{ blocks, items }` (`regFrom(bot)` builds it from `bot.registry`).

## Safety rules (all tested offline, test/fastlane.test.js)

- **One command or one short reply.** The model may only return JSON `command` / `reply` / `escalate`. Any command string goes through
  `router/slots.js validate()`, the same gate as every other tier: closed catalog, valid coordinates, registry-checked `find`/`craft`, no `/`, no control characters.
- **Slots must trace back to the chat line:** numbers the user did not type, and waypoint/block/item names with no word in the line, are rejected.
- **Confirmation gate:** high-risk commands, `craft`, `save waypoint`, multi-step asks (only the first step is offered, marked "first step only") and
  mid-confidence picks are always `ask` ("Did you mean ...? (yes/no)"), never `run`. `run` needs confidence >= 0.8 (info commands >= 0.65, stop-type >= 0.5).
- **Replies** (`say`): at most 140 chars, plain text, no leading `/`, no links or keys, no promises of action ("I will", "on my way") and no claims of work done.
  The prompt only allows greetings, thanks, banter and answers from STATE (health, food, current task). `allowReplies: false` turns them off.
- **Prompt injection:** the chat line and STATE are fenced as data; whatever the model returns is still validated by the rules above.
- **Complex text never goes out:** long lines, 4+ sentences, or explain/why/how-do-I/plan/design/build/write go straight to Claude, no call.
- **Key:** `OPENROUTER_API_KEY`, else `brain/fastlane/openrouter.key`, else `brain/router/openrouter.key` (all `*.key` gitignored). Held in memory only and
  scrubbed from errors, status and logs. State sent to the model has no coordinates.

## Timeouts, latency, fallback

- Hard timeout `timeoutMs` 4000 (and never longer than the router's `deadlineMs`). Any failure (timeout, 4xx/5xx, 429, bad JSON, empty content,
  invalid command) returns `escalate`, which the router turns into the normal Claude relay (unhandled.log + ack).
- Breaker: 3 consecutive failures pause 60 s; 429 honours retry-after; 401/402/403 pause 10 min; a rolling median above `slowMedianMs` (5000) pauses 10 min.
- Latency (p50/p95/max over the last 100 calls), the model OpenRouter actually routed to, and every decision are recorded (`fl.status()`, `brain/state/fastlane-log.jsonl`, capped).
- Repeated identical lines within 2 min are served from a small cache.
- `maxPerDay` 100000 (effectively uncapped: Walter said the key has its own monthly budget; about 5 cents per 1000 calls); only level-1 defers reach this tier.

## Files

`index.js` (createFastlane, `register` status handle, `regFrom`), `decide.js` (prompt, JSON parse, interpret, reply sanitiser, `wants`), `client.js`
(HTTP, key, breaker, latency), `config.json`, `bench.js` (`node brain/fastlane/bench.js --dry` / live with a key), `.gitignore`.
Writes only `brain/state/fastlane-log.jsonl` through `api.statePath`.

## Measured (Walter's key, 13 lines, `node brain/fastlane/bench.js --models a,b,c`)

`openrouter/free` is a roulette: it routes to reasoning models that burn the token budget (empty content) and to non-chat models. With
`extraBody {"reasoning":{"enabled":false}}` it works, but quality varies per call (2 of 12 usable in one run), so it is a poor level 2.
Cheap paid non-reasoning models are reliable (all 13 calls ok, final prompt with examples; "right" = the expected command or a sensible reply):

| model | $/M in/out | right | p50 / p95 ms | $/call |
|---|---|---|---|---|
| mistralai/ministral-8b-2512 | 0.15 / 0.15 | 12/13 | 623 / 1113 | 0.000054 |
| meta-llama/llama-3.1-8b-instruct | 0.05 / 0.08 | 12/13 (10 in an earlier run) | 654 / 1007 | 0.000033 |
| meta-llama/llama-3.3-70b-instruct | 0.10 / 0.32 | 13/13 | 1256 / 6556 | 0.000250 |
| qwen/qwen3-30b-a3b-instruct-2507 | 0.09 / 0.30 | 12/13 | 1741 / 2936 | 0.000151 |
| mistralai/mistral-small-3.2-24b-instruct | 0.075 / 0.20 | 11/13 | 1574 / 2863 | 0.000130 |

Pinned: `mistralai/ministral-8b-2512` (Walter agreed 2026-10-26), `extraBody {}`, `maxPerDay` 100000. Each call sends about 1.3k tokens.
