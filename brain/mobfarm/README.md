# brain/mobfarm: the underground mob farm (ROADMAP Phase 2, item 8)

Bones, arrows (skeleton drops), string, gunpowder, spider eyes and the free armor that mobs drop, for bows and arrows. Walter's benchmark is Smeo's farm in the
prior world (dark spawning platform, a drop into a shaft, hoppers into a chest, the bot finishing mobs with a stone sword through a gap). This one is built
by the bot itself, underground, off the laddered shaft, with nothing it could not do as a regular player.

Two files do the work:

| file | what |
|---|---|
| `geometry.js` | pure: `layout(frame)` (every cell of the farm), `candidates(shaft, rooms)` (where it may go), `shell(L)`, `waterLevels(L)`. Tested offline for all four directions. |
| `../autopilot/mobfarmbuild.js` | the build routine: phases that survive a restart, think-brain skill `mob_farm`, fallback step `mob-farm-build`, writes the config the kill routine reads |
| `../autopilot/mobfarm.js` | the existing kill routine (assistant step `mob-farm`): hits what landed through the slit, empties the chest into overflow chests. Now also walks to `chestSpot` first |

## The shape

```
 platform level Yp                            kill level Y0 = Yp - 22

  corridor  pads and trench (diamond, R=9)     corridor  K    S   slit  pocket
  k=1,2     |k-kc|+|j| <= 9, 2 high, dark       (lit)    bot stair  |  (L)
  [plug]    water trench through j (sources     --------> <3>        |   |
            at j=+-8)  ==> hole at (kc,0)       torches   eye ----> o <-+ landing cell, hopper under it
                              |                                        |
                              | 22 blocks, one cell wide, no ladder    chest under the hopper
                              v                                        (opened from the stair's foot)
```

* **Spawning platform.** A diamond room (17 across, 2 high, about 160 pad cells) with no light in it: monsters spawn only at block light 0, so the only door,
  the 2-block corridor, is plugged with stone when the build ends and the corridor torches are on the other level. The floor is natural rock.
* **Water.** A one-wide trench through the middle (floor dug out one block) with a source at each tip, 8 cells from the hole. The last flowing cell beside the
  hole is the lowest level, so it pushes mobs into the hole but never pours a waterfall down it (checked in vanilla: the column stays dry). Random strolls pick
  targets up to 10 blocks away, about half of them across the trench, so wandering mobs end up in the water.
* **Drop.** 22 blocks (`Yp - Y0`), one cell wide, no ladder (a ladder would cancel the fall). A 20 HP mob (zombie, skeleton, creeper, husk, stray) lands with
  1 to 2 HP, so the kill, and the XP orbs, belong to the bot. Spiders land at 10 HP, witches at 7 or 8; they fight like any mob.
* **Kill chamber.** The pocket is two cells high over a hopper that points down into a chest. All walls are the natural rock. The bot stands at K, exactly 3 cells
  from the landing cell (a creeper starts its fuse inside 3.0, sword reach to the hitbox is 2.7) and hits through a one-cell slit with rock above and below it: a
  mob two cells high cannot come through (the unit test walks every reachable cell). The stair down to the chest runs in the lane beside the corridor so the wall
  in front of the pocket stays whole.
* **Where.** `candidates()` takes the shaft record: the platform ceiling stays 4 rock blocks under the surface, the kill level is the highest that fits, the
  farm leaves away from the ladder wall (or to a side), and it skips any spot where an open cell would touch another room in the registry (the storage room).
  A shaft that is too shallow is refused with the depth it would need (`status().needBottom`): the mining routine can deepen it.

## What the bot needs

2 water buckets (crafted from 3 iron each, filled at the nearest water it can see; the routine tries), a hopper (5 iron and a chest), 4 torches, 24 stone-ish blocks
(cobblestone and friends; the dig itself yields hundreds), a pickaxe. It makes more stone pickaxes as they break (the farm is about 800 blocks) and picks its portable
crafting table up again. It does not need a sword for the build. The storage room comes first (the fallback step waits for it; the think-brain may start earlier).

## How the think-brain uses it

`think.js` skill **`mob_farm {action: build|work|status}`**: `build` runs the resumable build for as long as the step budget allows and says what phase it is in or what is
missing; `work` runs the kill routine once; `status` is cheap. The fallback routine list has `mob-farm-build` (after `storage-room`) for when the planner is off.

Phases (saved in `st.mobFarmBuild.phase`): `chamber` -> `platform` -> `column` -> `fit` -> `water` -> `done`. A failure rests the step for a few minutes and
tries again where it stopped; liquid or a no-dig area in the chosen spot moves the next try to another side or level.
When done it writes `brain/state/mobfarm.json` (the existing kill routine and roadmap predicate `2.8.mobfarm` read it; an older file is kept as `mobfarm.old.json`)
and a registry room `type: 'mobfarm'`.

**Waiting.** Mobs spawn only farther than 24 blocks from the player and despawn when the player is over 32 away, so the bot should rest 25 to 30 blocks from the
platform: the corridor by the shaft at the kill level (`rest` in `mobfarm.json`) is 22 to 30 blocks from every pad. At the kill spot itself about half the pads are
inside 24. The farm competes for the mob cap with every other dark space near the bot, so lit caves help.

## Checked in vanilla 1.21.6 (trial server)

* `tools/trial/mobfarm-lab.js` builds the shape with `/fill` and measures: water settles as designed (hole dry, last cell at level 1), zombies put on the pads walk into
  the trench and land (5 of 13 in two minutes, no spawn pressure), landing HP 1 to 2 for zombie, skeleton and creeper at a 22 drop, the bot kills 6 of 6 through the
  slit, rotten flesh arrives in the chest through the hopper.
* `tools/trial/mobfarm-build-lab.js` runs the real build routine (real skills, real ladder registry) as a survival bot in solid stone: it digs, seals and fits the whole
  farm, then zombies and the existing kill routine work it. Nothing outside the plan is dug (every air cell in the box is in the dig list).

## Known limits

* Spawn rate is modest (the platform is 160 cells in a world where each spawn attempt picks a random place); it makes bones and arrows over hours, not a stack a minute.
* Skeletons that land can shoot through the slit once before they are hit; the kill pass stops when health drops under 8.
* Spiders can climb the pocket wall into the slit. They are fought like any other mob.
* Rotten flesh fills the chest first; the kill routine moves loot to the overflow chests. A hopper filter is a possible later step.
* The water buckets need a water source somewhere in sight to be filled; if none is known the build waits at `fit` and says so.
