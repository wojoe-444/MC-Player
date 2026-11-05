---
name: trial-server
description: Spin up a throwaway offline-mode vanilla Minecraft server and op'd test bots to trial a mineflayer plugin, bot module or fight/mining scenario without touching the live bots or the real world. Use when asked to test, benchmark or compare bot code, plugins or behaviors in game.
---

# Trial server

Test bot code on a disposable local server instead of the real world. The server runs in offline mode on its own port, so test bots join under any name with no Microsoft login, which means it never conflicts with live bots that use a real account.

Requires Java (a recent JDK) and Node 18+. First run downloads the official Mojang server jar (about 50 MB, sha1 verified against Mojang's manifest). Ask the user before the first download.

The world rules in `CLAUDE.md` (no slash commands, no teleporting, play fair) are rules for the real shared world. Test bots on the trial server may use cheats, but only on this disposable server; never point a trial script at the real world's port.

## Steps

1. Setup, once per folder. Downloads the jar, writes eula/properties, and makes the listed names operators:
   ```
   node .claude/skills/trial-server/scripts/server.js setup --version 1.21.6 --port 25599 --ops TrialA,TrialB
   ```
   Options: `--dir` (default `.trial-server`, git-ignored), `--mode flat|default` (flat is quick and predictable; use default for real terrain).
2. `node .claude/skills/trial-server/scripts/server.js start` (waits until the server is up), `status`, `log 30`. Built-in safety: the server runs at below-normal priority on 2 cores with a small view distance, only one trial server may run at a time (it refuses to start a second; `--force` overrides), and a watchdog stops it after 15 minutes (`--minutes N`, 0 = no limit). A trial server on a machine that is also running the real game and live bots can make everything freeze, so keep trials short and stop the server as soon as the results are in.
3. Write a trial script from `scripts/example-trial.js`: connect with `mineflayer.createBot({ host: 'localhost', port, username: 'TrialA', version })`, and build the scenario with slash commands (the bot is op). Pace commands about 200 ms apart; the server kicks for spam.
4. `node .claude/skills/trial-server/scripts/server.js stop` when done. It kills only the PID it started (`server.pid`). Never use `taskkill /IM java.exe` or `pkill java`, which could kill someone's real game or server.

## Scenario recipes (all via bot chat commands)

- Reset: `/gamemode survival`, `/clear @s`, `/kill @e[type=!minecraft:player]`, `/effect clear @s`, `/time set 18000`, `/gamerule doMobSpawning false`, `/gamerule doImmediateRespawn true`.
- Gear: `/item replace entity @s armor.head with minecraft:iron_helmet` (also `armor.chest`, `armor.legs`, `armor.feet`, `weapon.offhand`), `/give @s minecraft:iron_sword`.
- Mining/collecting: `/setblock x y z minecraft:oak_log`, `/fill x1 y1 z1 x2 y2 z2 minecraft:stone`; measure items collected and seconds.
- Fighting: `/summon minecraft:zombie x y z {PersistenceRequired:1b}` in a ring around the bot, run the combat code for up to about 60 s, record kills, damage taken (sum of drops in `bot.health`) and deaths.

## Doing it properly

- Compare against a baseline (the code you already have, or no code) with the same scenario, and repeat each variant at least 5 times in fresh bot sessions. Single runs are noisy.
- Log one JSON line per run and report means plus the caveats: flat world and placed blocks are easier than real terrain, damage totals ignore regeneration, small samples show "at least as good", not "better".
- Keep trial copies of plugins in their own folder (`plugin-eval/`), install exact versions, and leave the live bots and their state folders alone.
- Do not commit the server folder, jar or world; `.trial-server/` is git-ignored.
