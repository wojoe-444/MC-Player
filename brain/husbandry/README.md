# brain/husbandry: animal pens and the glow lichen farm

ROADMAP Phase 2, item 9 (animal pens: cows, sheep, pigs, chickens; shear sheep instead of killing) and item 11 (glow lichen with shears and bone meal).
Written for winter food resilience (Serene Seasons): a fenced, lit pen that holds a breeding stock and a larger winter herd, plus a lichen wall that makes light.
Tested offline only (`test/husbandry*.test.js`, mock world). **Nothing here has been run against the live game yet**; see "Not verified live".

## What it does

| piece | file | what |
|---|---|---|
| pen blueprint | `blueprint.js` | pure. A 7x7 interior (config `pen.w/d`), a fence ring (31 fences), a fence gate in the middle of the south side, torches on the posts (7; corners and every 4th post, never over the gate, every interior cell within 7 steps of one). Ordered fences, gate, torches. |
| site survey | `survey.js` | `findPenSite`: flat (`maxDy` 0), natural, dry, loaded ground, at least 60% grass inside (sheep regrow wool by eating grass), clear of other pens, trees and player blocks. `findLichenWall`: a plain stone face 3 wide, 2 high, open air two deep in front, no water or lava within 2. |
| herd policy | `herd.js` | pure. `decide(census, ...)` returns what to breed (pairs), cull (adults only), shear. Targets per species (`herd.targets`), x1.5 in winter. Never culls below the breeding pair (`minStock` 2), never a baby; food low halves the keep level; an overfull pen is thinned from the species with the most spare adults. |
| engine | `engine.js` | `buildPen`, `lure`, `breed`, `shear`, `cull`, `tendPen`, `tendLichen` (seed, bone meal, shear), `runBuild/runTend/runLichen` (the scheduler entry points). |
| module | `index.js` | chat commands, two scheduler tasks (`husbandry`, `lichen`) and two idle routines that only visit pens and farms that already exist. |
| state | `state.js` | `brain/state/husbandry-state.json`: pens (with `built`, `lit`, last census, `breedBlocked`), lichen walls, stats, `winter`. |

## Chat

| say | does |
|---|---|
| `build an animal pen` / `build another animal pen` | picks a site (or resumes an unfinished pen), crafts what it can, builds fence, gate and torches. Says what is missing instead of placing half a pen. |
| `tend the pens`, `breed the animals`, `shear the sheep`, `cull the herd` | one visit: lure what is missing, shear, breed pairs, thin the surplus |
| `start a glow lichen farm`, `tend the lichen` | finds a stone wall (or uses the saved one), seeds, bone-meals, shears down to the seed |
| `pen status`, `how are the animals` | one line: pens, herd counts, lichen, season, totals |
| `it is winter` / `it is summer` | sets the season flag (the bot cannot read Serene Seasons itself); default is winter |
| `pen routine on` / `off`, `stop the pen work` | the two idle routines (on by default; they do nothing until a pen or a lichen wall exists) |

The think-first autopilot has one action, `pens {op: build|tend|lichen|status}`, that calls the same engine through `bot._husbandry`. The hunting skills leave animals
inside a built pen alone (`S.penned`), so the food routine cannot eat the breeding stock; the cull is the only thing that kills them.

## Rules it keeps

* Survival-legit: a clear ray (`api.canSee`) to every block placed or opened and every animal fed, sheared or hit; reach limits; nothing placed but the pen's own fence,
  gate and torches and glow lichen on the farm wall; somebody else's block on the ring is left alone (reported as blocked).
* No half pens: materials are checked first (`Missing` names what is short); the crafter (the autopilot's `S.craft` when loaded) is asked for the gap.
* The gate is never left open: the bot enters, closes it behind, works inside, and leaves the same way (the `finally` of `tendPen`). Danger (health under 12, a hostile within 10, night for outdoor work) stops it before the gate opens.
* Food is put away before leaving the pen so the animals stay; lure hops are 4 blocks with a wait, and it goes back for stragglers.
* Drops of a cull or a shearing are walked over (no item piles). The lava bucket rule is `safehand`'s.
* Breeding: both parents within seconds, 5 minute cooldown per animal (`fedAt`). If a species fails to produce a baby three runs in a row it is put on hold for 30 minutes (season, food or room); the policy then does not cull below the breeding pair either way.
* Tools: the best sword in the bag (stone is enough); shears for sheep and lichen; no new tool tier is made.

## Not verified live (check these first)

1. Entity metadata keys in 1.21.6: baby = index 16, sheep wool byte = index 17 (bit `0x10` = sheared). Wrong keys make every animal an adult and every sheep woolly.
2. Whether Serene Seasons blocks breeding in winter. The code copes (see the hold above) but the targets and the winter factor are guesses.
3. Torches on fence posts and `placeBlock` against a fence top; fence gate open/close through `activateBlock`; animals following through a gate that the bot opens (the lure sim in the tests walks the animals along the bot's trail).
4. Lichen: bone meal via `activateBlock` on a lichen block, `bot.dig` with shears dropping lichen, and the spread rate. Item names `glow_lichen`, `bone_meal`, `shears`.
5. Chickens: the seeds the bot actually carries (wheat seeds first).

## Follow-ups not done here

* Using the harvested lichen as light in rooms (instead of torches) and storing the wool/leather/lichen in the themed chests.
* Moving the pen underground, and a `lead`-based lure for mobs that ignore food.
* A dashboard card for the herd counts.
