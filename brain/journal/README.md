# The journal

One record per bot per day that a person, a scheduled agent or the bot itself can search in one read. It is job 1 of `docs/MEMORY-LOOP.md`: the transcript layer the later jobs (dawn brief, dream, fixer, digest) read. No model is involved.

## Files (per bot, under `brain/state/journal/`)

| File | What |
| --- | --- |
| `YYYY-MM-DD.jsonl` | One JSON line per event, filed by the UTC date of the event. |
| `YYYY-MM-DD.day.json` | That day's rollup, rebuilt every 5 minutes, at each in-game dawn and at shutdown. |
| `state.json` | How far each source log has been read, and which items and steps have been seen before. |

Days older than 30 are deleted. A day file past 16 MB takes salient events only.

## Events

Every event has `at` (ISO time, UTC) and `k` (kind). `day` is the in-game day when it is known. `sal: 1` marks an event to look at first.

| `k` | Fields | From | Salient when |
| --- | --- | --- | --- |
| `start` | `bot`, `commit` | the bot process starting | |
| `dawn` | `day`, `prevDay` | the in-game day turning | |
| `step` | `step`, `prev`, `pos`, `hp`, `held` | `runlog/steps.jsonl` | |
| `result` | `step`, `out` (`ok`, `explore`, `fail`, `timeout`, `error`, `aborted`, `parked`), `ms` | `G.onStepEnd` in `autopilot/goals.js` | |
| `alarm` | `ev` (`raised` or `cleared`), `type` (`STALL`, `THRASH`), `id`, then `cause`, `step`, `pos`, `fix`, `level` or `secs`, `level`, `fix` | watchdog lines in `lessons.md` | cleared at fix level 2 or above |
| `reflex` | `n`, `mobs`, `pos` | cave reflex lines in `lessons.md` | |
| `death` | `cause`, `pos`, `doing`, `had`, `lessons`, `adjusted`, `underground`, `light` | death post-mortems in `lessons.md` | always |
| `flag` | `kind`, `sev`, `msg`, `id`, `data` | `telemetry/flags.jsonl` (the raw excerpt stays there) | the first high flag of a kind in six hours |
| `items` | `items: { name: count }`, one event per 10 minutes | `acquired.jsonl` | |
| `first` | `what` (`item` or `step`), `id` | the first time this bot got that item or ran that step | always |
| `gate` | `rule`, `packet`, `blocked`, `n`, `why`, `owner`, `site` | `gate-log.json` | a packet was blocked |
| `commit` | `commit`, `subject`, `same` (a restart on the same code) | `runlog/commits.jsonl` | |
| `registry` | `added`, `removed` | the shared `registry.json` | always |
| `chat` | `from`, `text` | chat from another player | the speaker is a person, not a bot |
| `brief` | `text` (the intent), `focus`, `holds`, `freeTime`, `ask`, `dropped` | the dawn brief being applied (`brain/memory`) | always |
| `whimsy` | `choice`, `did`, `note`, `pos` | the bot's free-time step | |
| `note` | `tag`, `text` | any other `lessons.md` entry (`[think]`, `[inspect]`, ...) | |

Another module can add an event with `bot._journal.add(kind, fields, { sal })`.

## Rollup

`steps[id]`: `runs`, `minutes`, `ok`, `fail`, `timeout`, `other`, `alarms`, `stalledMin`. `alarms`: raised, cleared, stalled minutes, worst fix level, by type. `flags` by kind and `flagsHigh`. `deaths`, `items`, `firsts`, `gate`, `commits` (distinct), `starts`, `chat`, `reflexes`, `notes`. `salient`: up to 80 one-line summaries. `gameDays[day]`: the same in brief, per in-game day.

## Reading it

```
node tools/journal.js --state <bot folder> days
node tools/journal.js --state <bot folder> day 2026-11-10
node tools/journal.js --state <bot folder> search lava --k death --since 2d
node tools/journal.js --state <bot folder> salient --since 6h
```

## First run

There is no backfill switch. On its first run the journal reads the existing logs from the start and files what it finds by date, up to 30 days back, so the record begins with history. Events read back this way carry no in-game `day`, because the logs they come from did not record one.
