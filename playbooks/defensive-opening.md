# Defensive opening playbook (hillclimber)

Status: DRAFT 2, 2026-11-05. Walter's intro and section ONE are his words; everything marked *(continued)* is Claude's continuation for him to edit.
Gaps, risks and open questions: [defensive-opening.notes.md](defensive-opening.notes.md). Nothing here is wired into the bot yet.

## The framework (Walter)

This is a framework, not a precise order. Get to a place where you have a small base that could be surrounded by enemies without bothering you one
bit, because you are growing your own food, planting trees for wood, and have a mine you can safely travel between. If you die, you wake up in a good
place to restock on food, build new gear, and get back to work. Armor is a result of that foundation, not the opener: a fed, lit, sheltered bot with
a renewable wood supply gets the iron and keeps it, while a bot that rushes armor with no foundation loses it on its next death.

The bot is a peer, not an executor (CLAUDE.md). It may reorder, skip or extend anything below with a stated reason, and its free-time slot is never
scheduled over. What it does not skip is the end state.

## Assumptions

- **A bed is assumed, for convenience.** Re-making the bed after every respawn is policy (wool from sheep, or a spare from the chest), so a death never
  stalls the hillclimb. Set the spawn the moment the bed is placed (right-click it, day or night).
- A biome with birch, oak or spruce trees is nearby.
- **Home site: the existing `Claude-Base-2` waypoint** (in the bot's `waypoints.json`). The room, shaft, farm and trees go in or beside that area, and
  the bot returns to it as home. It still respects the existing no-dig zones and the established-shaft rule (one surface shaft, no new breaches within ~100 blocks).

## The end state (what "done" looks like)

A phase list can change; these four pillars are the point. Each has checks the bot can read from its inventory and the blocks it sees.

1. **A shelter-and-respawn hub.** A dug-out room (about 6x6x3) next to the shaft, with bed (spawn set), chest, furnace, crafting table and torches, and a covered
   shaft top. *Checks:* spawn set, a restock chest holding spare stone tools, torches, cobble and food, and no unlit spawnable block inside the room.
2. **A safe, growing food supply.** A fenced, lit farm beside the shaft top. *Checks:* 12+ crops growing, light 8+ on every spawnable block around the farm
   and the path to the shaft, and 12+ cooked food or bread in the chest.
3. **A renewable wood supply.** A lit tree patch (birch preferred, 3-block lattice with a torch in each square), replanted on every cut. *Checks:* 6+ trees
   planted and lit, saplings in the chest, logs obtainable without searching, and charcoal from spare logs for torches.
4. **A safe mine you can travel between.** One established ladder shaft from the room, lit all the way down, with strip-mining branches off the bottom.
   *Checks:* torches to the surface, 32+ cobble to plug openings, and no open caves or lava next to the route.

When all four hold, the base can be surrounded by enemies and nothing is lost. Then the iron kit (below) is built on top of it, and the planner takes over.

## Standing posture (every phase)

1. **Underground is home, the surface is the work site.** At dusk go down and keep working. Night is mine-time; surface work is for daylight.
2. **Light before work.** Everything you will stand on, work on or plant on is lit (light 8 or more) before you start.
3. **Close the door.** At dusk the shaft top is covered with a trapdoor or a block, which can be put back from below.
4. **Never spend the bed.** Don't break it. Re-make it after a respawn at once.
5. **Fight from cover.** Skeleton archers are the top killer: shield up, break line of sight, close the distance zig-zag and only above 10 health.
   Creepers: keep 8+ blocks away and never fight them near the farm.
6. **Stay stocked.** A stack of food, 32+ cobble and 16+ torches before any trip away from the shaft.
7. **Replant every tree you cut.** Don't dig the house or other built blocks.
8. **The world rules still apply** (no cheats, line of sight, never walk with a lava bucket selected, short chat). Digging and placing in this playbook counts as an
   agreed job (rule 3) once Walter approves it.

## Sleep (Walter's rule)

- If Walter is in **survival mode** (as a human player): sleep every 3 days (the 3rd night) when he does.
- Otherwise: attempt to sleep, give it about 60 seconds, then get up and get back to work **if the other bots aren't sleeping** (read `bots-sleep.json`). Don't stall in bed.
- With the room as home, the bed is a few steps from the work, so the attempt is cheap.

## A worked example: the first hour (Walter's procedure, not a script)

# ONE: BASIC-SELF SUFFICIENCY (FOOD, WOOD, STONE)

Procedure:

Go around hand punching 15 wood. Create a crafting table. Create around 15 ladders and a wooden pickaxe. Find a place to create a mineshaft. The best place is relatively solid stone. Underground caves at this point in the game mean danger. Hand punch through dirt and use the wooden pickaxe to dig down around 15 blocks, placing ladders so that you can get back to the surface.

You are going to build your first single-room base here. The mineshaft should be in a corner of the room you dig out. Dig out with the wooden pickaxe and your hand so you have enough space to create another crafting table, place it against the future base wall, and make yourself a stone pickaxe and stone axe. 

Dig out the room to about 6x6 size, 3 blocks height, place your bed *(continued)* against the far wall and right-click it to set your spawn. The cobble from the dig is your building stock, so keep all of it.

*(continued)* Then fit out the room (pillar 1), in any order that suits the day:
- Stone sword; a furnace (8 cobble) beside the second crafting table; a chest (8 planks) by the bed; a stone hoe for the farm.
- Torches from charcoal (smelt spare logs; charcoal plus a stick), so no coal trip is needed yet. Light the room and the shaft about every 6 blocks.
- Cover the shaft top (posture rule 3).
- Food: kill animals met while punching trees (wooden sword first) and cook the meat. Berries if animals are scarce.
- Keep saplings that drop from leaves: plant some on the spot, keep 6+ in the chest for the tree patch.

If dusk arrives before this is done, the room (even half-dug) is the shelter: go down, seal, and finish at night.

# TWO: THE SAFE SURFACE (pillars 2 and 3) *(continued)*

A small fenced, lit patch around the shaft top that gives food and wood without wandering.
- Site: flat, within ~12 blocks of the shaft top, ideally within 4 blocks of natural water (farmland needs water within 4 blocks, and a bucket costs 3 iron).
- Trees: birch if available (one-block sapling, never a 2x2 giant), else oak, else spruce. A 3-block lattice with a torch in each square. Replant on every cut.
- Farm: seeds from grass, hoe, wheat beside the water; 12 plants to start, 24 later. Fence it with a gate, and torch around it. Bread needs 3 wheat.
- Light the whole patch and the path to the shaft to 8+. This is the biggest defensive investment: it removes the dark ground that skeletons, zombies
  and creepers spawn on near home.
- Harvest and logs go to the chest. Spare logs become charcoal for torches.

# THREE: THE MINE (pillar 4) *(continued)*

- Extend the ladder shaft to about y 16 to 40 (iron is common at 15 to 50), a torch about every 6 blocks, a niche to rest in.
- At the bottom, strip mine: 1x2 tunnels, a branch every 3 blocks, torch about every 6. Mine only ores you can see. Coal replaces charcoal when found.
- Never dig straight down. If a tunnel opens into a cave, ravine or water, plug it and go around. If lava shows, wall it off and stay away. Fight in the tunnel
  if a mob appears in a 1-wide corridor.
- Come up when food is under 8 points, torches under 6, or the bag is full. Smelt iron in the room's furnace. Mine at night, farm and chop by day.

# FOUR: THE IRON KIT, ON TOP OF THE FOUNDATION *(continued)*

Suggested order as the ingots arrive (a suggestion; the bot may adapt):
1. Shield (6 planks and 1 ingot): the biggest defensive gain per ingot, off-hand always.
2. Iron sword (2).
3. Bucket (3): water for the farm, fire, and cancelling a fall.
4. Iron pickaxe (3): needed for diamonds.
5. Chestplate (8), leggings (7), helmet (5), boots (4): best protection per ingot first.

Wear each piece from the moment it is crafted. Don't take armor from shared chests without asking Walter.

# FIVE: HAND BACK TO THE PLANNER *(continued)*

When the four pillars hold and the kit is worn, the bot's planner (think.js) takes over from a base that feeds, lights and replaces itself: diamonds,
the nether, building, whimsy. If the bot dies, it wakes in the hub, restocks, re-makes the bed if needed, and goes back to work.

## Appendix: numbers

- Ladder: 7 sticks gives 3, so 15 ladders is 35 sticks, about 18 planks. 15 logs is about 60 planks: 4 table, 18 ladders, 3 pickaxe, 4 second table, 8 chest, about 14 for sticks, hoe, sword handles, fence, and a spare.
- Wooden pickaxe lasts 59 blocks, stone 131. A 6x6x3 room is 108 blocks: make the stone pickaxe after the first ~10 stone blocks and dig the rest with it.
- Iron kit: shield 1, sword 2, bucket 3, pickaxe 3, armor 24 (5+8+7+4), total 33.
- Torch: 1 coal or charcoal and 1 stick gives 4.
