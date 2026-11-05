# Defensive opening playbook (hillclimber)

Status: DRAFT 1, 2026-11-05. Walter wrote the intro and section ONE up to "place your bed"; everything marked *(continued)* is a first continuation
for him to edit. Gaps, risks and open questions are in [defensive-opening.notes.md](defensive-opening.notes.md). Nothing here is wired into the bot yet.

Idea: a bot that can reliably defend itself and maintain a minimum existence (a safe farm, a tree source and a mine) will blossom from there. Armor is
the *result* of that foundation, not the opener. A fed, lit, sheltered bot with a renewable wood supply gets the iron and keeps it; a bot that
rushes armor with no foundation loses it with its next death.

Assumes: the player starts with a bed, in a biome with birch, oak or spruce trees nearby.

How the bot uses it: this is the bot's default opening, a script it follows and can depart from with a stated reason (it is a peer, not an
executor; see CLAUDE.md). Each phase has **Done when** conditions (things the bot can check from its inventory and the blocks it sees) and a
**Time box**. When a phase runs over its box, it moves on to the next item it can do and says why in `lessons.md`. It never stalls.
Free-time ("whimsy") is not scheduled over by this playbook.

---------------------------
Standing posture (applies in every phase)
---------------------------

1. **Underground is home, the surface is the work site.** The first room is the shelter, the bed, the chest and the furnace. Night is mine-time:
   when dusk comes, go down and keep working. Surface work happens by day.
2. **Light before work.** Every spot you will stand on, work on or plant on is lit (light 8 or more) before you start, so nothing spawns next to you.
3. **Close the door.** At dusk the shaft top is covered (a trapdoor or a block). Ladders keep zombies out, but not a hole in the ground.
4. **Never spend the bed.** Don't break it, and set the spawn at once (right-click it, day or night).
5. **Fight from cover, not in the open.** Skeleton archers are the top killer: shield up, break line of sight, close the distance only zig-zag and
   only above 10 health. Creepers: keep 8+ blocks away, never fight them near the farm.
6. **Stay stocked.** A stack of food, 32+ cobble, 16+ torches before any trip away from the shaft.
7. **One shaft, one mine.** No new surface breaches within ~100 blocks. Don't dig the house or other built blocks. Replant every tree you cut.
8. **Existing world rules still apply** (no cheats, line of sight, never walk with a lava bucket selected, chat short). Digging and placing in
   this playbook counts as the agreed job (rule 3) once Walter approves it.

---------------------------
Priorities:
---------------------------

# ONE: BASIC-SELF SUFFICIENCY (FOOD, WOOD, STONE)

Procedure:

Go around hand punching 15 wood. Create a crafting table. Create around 15 ladders and a wooden pickaxe. Find a place to create a mineshaft. The best place is relatively solid stone. Underground caves at this point in the game mean danger. Hand punch through dirt and use the wooden pickaxe to dig down around 15 blocks, placing ladders so that you can get back to the surface.

You are going to build your first single-room base here. The mineshaft should be in a corner of the room you dig out. Dig out with the wooden pickaxe and your hand so you have enough space to create another crafting table, place it against the future base wall, and make yourself a stone pickaxe and stone axe. 

Dig out the room to about 6x6 size, 3 blocks height, place your bed *(continued)* against the far wall and right-click it to set your spawn. The cobble from the dig is your building stock, so keep all of it.

*(continued)* Fit out the room, in this order:
1. Stone sword. Furnace (8 cobble) against the wall next to the second crafting table. Chest (8 planks) by the bed. Stone hoe (needed in TWO).
2. Torches: smelt spare logs into charcoal in the furnace and craft torches (charcoal + stick). You don't need coal yet. Light the room and the shaft every ~6 blocks.
3. Cover the shaft top, as per posture rule 3. Make sure there is a way to put the cover back from below.
4. Food: kill the animals you meet while punching trees (wooden sword first), cook the meat in the furnace. Keep 12+ cooked food. If animals are scarce, move to berries and then to the farm in TWO.
5. Pick up any sapling that drops from leaves while chopping. Put them in the chest, keeping at least 6 for TWO. Plant the others on the spot.

Done when: stone pickaxe, stone axe, stone sword, furnace, chest, bed (spawn set), 16+ torches, 32+ cobble, 12+ food, 6+ saplings, shaft cover in place.
Time box: first dusk. If dusk arrives earlier, the room (even half-dug) is the shelter: go down, seal, and finish ONE at night.

# TWO: THE SAFE SURFACE (FARM AND TREE SOURCE) *(continued)*

A small fenced, lit patch around the shaft top that provides food and wood without wandering.

Procedure:
1. Pick the patch: flat, ideally within 4 blocks of natural water (farmland needs water within 4 blocks, and a bucket needs iron), within ~12 blocks of the shaft top, clear of the existing trees you still need.
2. Tree source: birch (one-block sapling, never forms a 2x2 giant) if you have it, else oak, else spruce. Plant on a lattice with 3 blocks between trunks, a torch in the middle of every lattice square. Start with 6 saplings. Replant the sapling every time a tree is cut. Saplings need open sky above and light 9+.
3. Farm: break grass for seeds, till with the hoe, plant wheat in a block next to the water, 12 plants to start, 24 later. Fence it (fence plus gate) and put torches around so it is lit at night too. Bread needs 3 wheat.
4. Light the whole patch and the path to the shaft to 8+. This is the single biggest defensive investment: it takes away the dark ground that skeletons, zombies and creepers spawn on near home.
5. Every harvest and every felled tree goes into the chest in the room. Fuel for the furnace comes from the trees: logs to charcoal.

Done when: 6 saplings planted (3-block lattice, lit), 12 wheat growing, fence and torches around the patch, a stack of bread or cooked food in the chest, 24+ torches.
Time box: 2 in-game days. It can be interleaved with THREE (surface by day, mine by night).

# THREE: THE MINE (STONE, COAL, IRON) *(continued)*

The first-room shaft is the one established mine. Branch off it; don't breach the surface elsewhere.

Procedure:
1. From the room, extend the ladder shaft down to around y 16 to 40 (iron is common at 15 to 50). Torch every ~6 blocks and put a ladder in every cell, and leave a niche to rest in.
2. At the bottom, strip mine: 1x2 tunnels in straight lines, a branch every 3 blocks, torch every ~6. Mine only ores you can see. Collect coal along the way (it replaces charcoal for torches).
3. Safety rules while mining: never dig straight down; if a tunnel opens into a cave, ravine or water, place a block, back off and go around; if lava shows, stop, wall it off, and don't path near it; 64+ cobble in the bag for plugging and walling; if a mob appears in a 1-wide tunnel, fight in the tunnel, don't run.
4. Come up when food is below 8 points, torches below 6, or the bag is full. Smelt iron in the furnace in the room. Mine at night, farm and chop by day.

Done when: 3+ coal, 32+ cobble stored, iron coming in steadily (the first 6 ingots buy the shield and sword; the full kit in FOUR costs 33), the mine lit with torches all the way back to the shaft.
Time box: no box. This phase is open-ended, but check in with TWO every day (harvest, replant, torch) so the farm and trees don't rot.

# FOUR: IRON, IN THIS ORDER *(continued)*

Craft as the ingots arrive, in this order (THREE and FOUR run interleaved):
1. **Shield** (6 planks and 1 ingot). Blocks arrows and creeper blasts from the front. This is the biggest defensive gain per ingot. Off-hand always.
2. **Iron sword** (2).
3. **Bucket** (3). Carries water for the farm, putting out fire and cancelling a fall. Never walk with a lava bucket selected.
4. **Iron pickaxe** (3). Needed for diamonds.
5. **Chestplate** (8), then **leggings** (7), then **helmet** (5), then **boots** (4). Best protection per ingot first.

Wear everything from the moment it is crafted. Don't carry armor as cargo, and don't take armor from chests to wear without asking Walter.
Done when: shield, sword, bucket, pickaxe and all four armor pieces worn.

# FIVE: HAND BACK TO THE PLANNER *(continued)*

The playbook is complete. The bot's own planner (think.js) takes over with a base that feeds, lights and replaces itself: diamonds, the nether,
building, whimsy. The standing posture still applies.

---------------------------
Appendix: numbers
---------------------------

- Ladder 7 sticks gives 3, so 15 ladders is 35 sticks, about 18 planks. Wood budget for 15 logs (about 60 planks): 4 table, 18 ladders, 3 pick, 4 second table, 8 chest, about 14 for sticks, hoe, sword handles, fence, and a spare.
- Wooden pickaxe lasts 59 blocks, stone 131. A 6x6x3 room is 108 blocks: make the stone pickaxe after the first ~10 stone blocks and dig the rest with it.
- Iron kit: shield 1, sword 2, bucket 3, pickaxe 3, armor 24 (5+8+7+4), total 33.
- Torch: 1 coal or charcoal and 1 stick gives 4.
