# brain/ module interface (v1)

The integrator (scheduler + furnace thread) owns `brain/index.js`, `brain/scheduler.js`, `brain/safehand.js`, `brain/util.js`,
`brain/furnace.js` and the edits to `join.js`. Everything else plugs in as a **module folder** with an `index.js`:

| folder | owner | what it provides |
|---|---|---|
| `brain/safety/`    | mob-safety thread | hostile detection, warn/retreat/fight, low-health hold |
| `brain/chat/`      | chat thread       | fuzzy command matching, per-user topic memory |
| `brain/dashboard/` | dashboard thread  | local status page + `status.json` |

`brain/index.js` loads each folder inside its own try/catch, so a broken module is logged (`BRAIN_MODULE_ERROR <name>`) and
skipped; it can never stop the bot from joining. Do **not** edit `join.js`, `run.js`, `excavate.js`, `farm.js` or restart the
bot. Hand your folder over, and the integrator wires it in at the next batched restart.

## 1. The entry point

```js
// brain/<area>/index.js
module.exports = function register(api) {
  // set up listeners, scheduler routines, commands here; do NOT start timers that cannot be stopped
  return {
    name: 'safety',                       // unique, lowercase
    start() {},                           // optional; called once after the bot has spawned and all modules registered
    stop() {},                            // optional; clear timers/listeners
    status() { return { /* JSON-serialisable */ } },   // optional; shown by the dashboard under status.modules[name]
    onChat(user, text) { return false },  // optional; see 3
    fallback(user, text) { return false } // optional; see 3
  }
}
module.exports.meta = { name: 'safety', version: 1 }
```

`register` is called once, synchronously, after `bot` has spawned. It must return quickly and must not throw for missing optional
data (state files may not exist).

## 2. What `api` contains

```js
api = {
  bot,                         // the mineflayer bot (already spawned)
  PRIORITY,                    // { SAFETY:100, SLEEP:80, EAT:70, CHAT:50, FARM:40, FURNACE:30, EXCAVATE:10, IDLE:1 }
  scheduler,                   // see 4
  say(text),                   // THE way to talk: rate-limited chat queue, duplicates dropped, <= ~230 chars. never bot.chat
  goals, tryGoto,              // pathfinder goals; tryGoto(goal,label,ms) -> Promise<{ok,secs,err}>; quiet (no "Here.")
  stopNav(),                   // stop the current pathfinder goal / control states
  safehand,                    // { ensureSafeForMove(), stow(), lavaMoment(fn), holdingLava(), safeItem() }  see 5
  gotoNear({ pos, radius, label, ctx, ms }),   // abortable walk next to a block (brain/util.js), true when within reach
  ownerName,                   // 'OGWO'
  dir,                         // absolute path of the Minecraft-Agent folder
  statePath(file),             // -> absolute path under brain/state/ for your persistent files (create nothing elsewhere)
  log(tag, msg),               // appends to brain/brain.log and keeps a ring buffer the dashboard can read
  now(),                       // Date.now() (tests may fake it)
  commands: {                  // see 3
    add({ name, match, run, help, risk }),
    list(),                    // [{ name, help, risk, canonical:[...] }]
    dispatch(user, text),      // run text as if Walter typed it (brain commands first, then legacy handleCommand). returns true if handled
  },
  status: { all() },           // { scheduler, furnace, modules:{name:status()}, chatTail:[...], logTail:[...], bot:{...} }  (for dashboard)
  events,                      // EventEmitter: 'chat' ({user,text}), 'task' ({event:'start'|'done'|'paused'|..., task})
}
```

## 3. Chat flow and commands

Every chat line from Walter goes through, in order:

1. `scheduler.noteChat()` (idle tasks yield for 3 minutes).
2. each module's `onChat(user, text)`; first one returning `true` wins and the line stops here.
3. brain commands registered with `commands.add` (exact, regex based, fast).
4. the legacy `handleCommand` in join.js.
5. each module's `fallback(user, text)` (the chat module goes here: fuzzy match, then `commands.dispatch(canonical)`).
6. if still unhandled: the integrator appends the line to `unhandled.log` and says the usual short ack.

Register commands like this (match is a RegExp tested against the lowercased, filler-stripped text, or `(user,t)=>bool`):

```js
api.commands.add({
  name: 'fight-mode', help: 'you can fight | do not fight', risk: 'high',   // 'high' = chat module must confirm fuzzy matches
  match: /\b(you can fight|fight back|defend (yourself|me))\b/,
  run(user, text) { setMode('fight'); api.say('OK, I will fight back with my sword.') }
})
```

`risk: 'high'` is for anything that digs, takes items, fights or starts a long job. The chat module asks "Did you mean ...? (yes)"
before dispatching a fuzzy match of a high-risk command. Canonical strings you want the chat module to be able to produce must be
listed in `help` (first alternative before `|` is the canonical form).

The chat module should write nothing itself to `unhandled.log` and must never reply to a line it did not understand: Claude (the
driver) reads `chat.log` and answers open-ended chat.

## 4. Scheduler (brain/scheduler.js)

One task runs at a time; higher priority preempts (the running task is told to stop, goes to `paused`, and is resumed later by calling
`run` again with `ctx.resumed === true` and the same `ctx.state`).

```js
const task = scheduler.submit({
  name: 'safety', priority: PRIORITY.SAFETY,
  preemptible: false,          // default true
  idleOnly: false,             // true = only runs after 3 min without chat from Walter, yields the moment he types
  onUserStop: 'cancel',        // 'cancel' (default) | 'park' (stays parked until "resume"); priority >= SAFETY ignores "stop"
  key: 'safety',               // singleton key (default = name); resubmitting while it exists returns the existing task
  state: {},                   // survives pause/resume
  abort(reason) {},            // optional hook for code that cannot look at ctx (legacy flags)
  async run(ctx) {
    // ctx.aborted, ctx.reason, ctx.resumed, ctx.state
    ctx.checkpoint()           // throws AbortError if told to stop; call between atomic steps
    await ctx.sleep(250)       // abortable sleep
    ctx.onAbort(cb)            // cb(AbortError) when aborted; returns a disposer
    ctx.progress('3/10 chests')// shown on the dashboard
    return { status: 'done' }  // or { status:'park', reason } (needs Walter's go) or { status:'retry', afterMs }
  }
})
scheduler.routine({ name, priority, idleOnly, intervalMs, defaultEnabled:false, due(){...}, make(){ return { run } } })
scheduler.setEnabled('name', true)      // Walter's go; persisted
scheduler.status()                      // { running, queue, parked, routines, quietForS, history }
```

Rules for `run`: finish the current atomic step, then stand down fast (a few hundred ms). Never leave a pathfinder goal set when you
return; if you set one, clear it in `finally`. A task that ignores abort for 15 s gets detached.

## 5. Rules every module must keep (Walter's)

1. **Never move with a lava bucket selected.** Call `await safehand.ensureSafeForMove()` before any `tryGoto`/`setGoal`. Hold lava only in `safehand.lavaMoment`.
2. No breaking/placing blocks unless Walter asked (excavation and replanting are the explicit exceptions, and those live elsewhere).
3. No item piles on the ground; stop and tell Walter instead.
4. Chat is short and rare: use `say` only when something changes; no polling chatter. Never send anything starting with `/`.
5. Never start the furnace routine or resume the excavation: those need Walter's go (`scheduler.setEnabled`).
6. Do not add process-level handlers (`uncaughtException`, `process.exit`), `setInterval`s that cannot be stopped, or ports other than
   the dashboard's (127.0.0.1 only, read-only).
7. Persist only through `api.statePath(file)`.

## 6. Testing without the live bot

`test/mock-bot.js` gives an in-memory bot with the real 1.21.6 registry (inventory, chests, blocks, `tryGoto`, `goals`, `say`).
`node --test "test/*.test.js"` runs everything (Node 24 does not take a bare directory). Look at `test/furnace.test.js` and `test/mobs.test.js` for the pattern. The mock exports
`mockBot({ pos, health, food })`; extend it in your own `test/<area>.helpers.js` rather than editing it.

## 7. Existing drafts you can start from

- `brain/mobs.js` + `test/mobs.test.js` (safety thread): a pure `assess()` decision function plus a runtime that submits the `safety` task.
  Move it to `brain/safety/` and adapt to this interface. Default mode is **warn** (retreat + tell Walter); fighting needs Walter's OK.
- `brain/nlu.js` (chat thread): fuzzy phrase matcher producing canonical command strings. Untested draft; port/replace freely.
- Nothing exists yet for the dashboard. The data you need is in `api.status.all()`.

## 8. Hand-over checklist

- `node --test "test/*.test.js"` passes, including your own tests.
- `brain/<area>/README.md` with commands, files written, and anything the integrator must change in `join.js`.
- A short list of the chat phrases you tested.

## 9. Optional capabilities (excavation, nav)

Folders `brain/excavation/` and `brain/nav/` are loaded like the others. A handle may declare what it replaces:

- `provides: ['excavation']`: the built-in excavation adapter commands (`excavate-start`, `excavate-resume`; they wrap the legacy excavate.js) are removed
  when the module registers, so register your own `excavate...` commands. Your task must be `scheduler.submit({ name:'excavation', priority: PRIORITY.EXCAVATE, onUserStop:'park', ... })`
  and must only ever start from Walter's command ("excavate" / "resume excavation"), never from a routine without his go.
- `provides: ['nav'], navigate(goal, label, dynamic)`: replaces the built-in scheduled navigation (what `join.js` `navigate()` calls). It must return a scheduler
  task at PRIORITY.CHAT with key 'nav', replace an earlier nav task, stop pathfinding when aborted, and resume the same goal when resumed.
- Walking limits that hold for every module: pathfinder never digs or places, max drop 3 blocks (`infiniteLiquidDropdownDistance` stays off), doors are tended by join.js.

## 10. Line of sight (Walter's survival-legit rule)

Before every attack, shot, container open, block interaction, break or placement there must be a clear ray from the bot's eye to the target, as if a
crosshair could point at it (a mob behind a 1-block wall must not be hit; a chest behind a hopper cannot be opened). Shared helpers (brain/los.js):

- `api.canSee(target)`: sync, true/false. `target` is an entity (position + height; tests feet, middle and head), a block (from `bot.blockAt`) or a Vec3 block position
  (tests the centre and a point just inside each face; a ray that reaches the target block first counts).
- `await api.ensureLineOfSight({ ctx, target, label })`: for blocks it walks to a standable spot within arm's reach with a clear view if the current spot has none
  (never digs or places) and returns true/false; for entities it only reports (reposition yourself, or give up on that target).
- Furnace upkeep applies it to every chest open and every cauldron click and records "no clear line of sight to the chest" instead of opening it.
- `join.js` additionally guards `bot.attack` (skips and logs to los.log). In tests the mock bot has `bot.world.raycast` (first non-air block).

## 11. Smeltables into the auto-furnaces (shared helper)

`await api.depositSmeltables({ ctx, force, quiet })` (brain/furnace.js, rules in brain/smeltables.js). Call it instead of keeping your own list.
- Trigger: does nothing (`{ skipped:true }`) while more than 6 inventory slots are free; `force:true` deposits regardless (the furnace pass does).
- Deposits: raw_iron/gold/copper, ancient_debris, any *_ore, sand/red_sand, clay(_ball), cobbled_deepslate, netherrack, kelp, cactus, wet_sponge, stone,
  cobblestone above 48, raw food above the 64-food stack (cooked food counts first; potatoes keep 16 as seed), logs above 32. Keeps coal/charcoal, tools, buckets.
- Walks to the nearest reachable input chest (clear line of sight, never digs), repeats with the next if full, never throws anything away.
- Returns `{ moved:{name:count}, left:[{name,count}], full, cantReach, skipped }`. When `full` is true every input chest is full or out of reach: **pause your job and wait for Walter**
  (the helper already told him, at most every 10 minutes). `api.smeltablesPlan()` lists what would be deposited right now.
- It uses the 3 input chests in furnace-config.json that the pathfinder can reach (S1's input chest at -1043,132,2273 is retried every 30 minutes).

## 12. Focus: steering priorities from natural language (scheduler.focus)

`api.scheduler.focus({ task, priority = 60, until = 'done', note, suppress = [], resumePrevious = true, maxMs })` returns an id.
- `task`: name or key of the task to favour; it may not exist yet (the focus applies as soon as it is submitted). While the focus lasts the task's *effective* priority is `priority`
  (capped below SAFETY; sleep 80 and eat 70 still win above 70). A focus on a parked task unparks it, and a focused idle-only task ignores the quiet window.
- `until`: `'done'` (until that task finishes, capped by `maxMs`, default 30 min), a duration in ms, or an epoch ms (> 1e12). It ends by itself and everything goes back to the normal queue and routines.
- `suppress`: names of tasks held back while the focus lasts (a running one is paused). `resumePrevious:false` cancels the task that was running instead of pausing it.
- `note`: Walter's own wording, shown by `focus status` and in `scheduler.status().focuses`.
- `scheduler.focusList()`, `scheduler.clearFocus(idOrTask?)` (no argument clears all). Events: 'focus', 'focus-end'. Chat: "focus status", "clear focus".
- Safety, and the linger/queue rules, are unchanged. Walks (name 'nav') queue behind each other; a follow is replaced by the next order.
