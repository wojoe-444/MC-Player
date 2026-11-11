# The bot's memory and its dawn brief

Jobs 3 and "Memory on disk" of `docs/MEMORY-LOOP.md`. The journal is the record; this is what the bot keeps from it, and the moment each day when it reads that and decides.

## Files (per bot, under `brain/state/memory/`)

| File | What | Written by |
| --- | --- | --- |
| `global.md` | What the bot wants to know every morning. At most 60 lines, five sections: Now, Policies, Traps, My own projects and wishes, How I use this folder. | the bot's brief; later the dream corrects Policies and Traps |
| `notes/<topic>.md` | Detail, read on demand. At most 10 files of 150 lines. | the same |
| `brief-request.json` | What the bot hands the laptop job when it wants a brief. | `brain/memory` |
| `brief-answer.json`, `brief-history.jsonl` | The model's answer, and one line per call. | `reviewer/lib/brief.js` |
| `brief.json` | The checked brief the step picker reads. | `brain/memory` |
| `brief-state.json` | Which request is waiting, and what code refused last time. | `brain/memory` |

The folder is a small local git repo. Every accepted write is a commit.

## The caps

A write that would pass a cap is refused and the reason is shown to the next brief, so the writer has to cut or move something down first. A policy needs its evidence. "My own projects and wishes" belongs to the bot: no other writer may change it (`store.writeGlobal` refuses).

## A brief

```json
{ "intent": "Today is for iron: smelt what I hold and find ore for an iron pickaxe.",
  "focus": ["iron-smelt", "iron"],
  "holds": [{ "step": "pursue", "untilDay": 58, "why": "its y -8 target cannot be dug with a stone pickaxe" }],
  "freeTime": { "choice": "vantage", "note": "the highest ground near home" },
  "ask": "Do you know where iron ore is near home?" }
```

What the picker does with it (`G.pick` in `autopilot/goals.js`):

- A held step is skipped.
- A focus step goes first when its own `need()` is true.
- Free time (`autopilot/whimsy.js`) gets its slot once per in-game day, in daylight, when the bot is healthy and fed.
- None of this ever jumps a survival step that is waiting.

## Limits, in code

Checked when the answer arrives (`brief.validate`) and again at every pick (`brief.active`):

- Step names must be ones the bot really has.
- No hold on a survival step (`eat`, `take-cover`, `recover`, `rebed`, `night-home`, `food`, `cook`, `shelter`, `move-home`) or on `whimsy`.
- At most three focus steps and three holds; a hold lasts at most three in-game days.
- A brief stops counting three hours after it was written.

No brief, for any reason, means the step list plays exactly as it does without one.

## Switch

`planner.brief` in the bot's `profile.json`: `true` or `false`. Unset, the brief is on for a hillclimber and off for an assistant. `BOT_BRIEF=0` in the environment turns it off.
