# Roadmap: phases for both bots

Approved by Walter on 2026-11-10. Build in phase order; inside a phase, follow the numbering. Sources: the "Bot Act 2 plan: taste, structure, scale" doc, and the "Bot phase plan: gaps and long-distance travel design" doc (https://claude.ai/artifact/HDkPDFYnhkw5E7gpnEccKi), which has the reasoning, the full ranked table and the open "verify" items.

These are rules of play and goals, not orders. The bots keep their own free-time slot (see CLAUDE.md); nothing here schedules over it, and a bot may propose changes or decline a job that clashes with the agreed rules, explaining why.

## Rules that hold in every phase

- **Tools:** use the minimum tool that does the job; no wood tools after the early game. Stone is the default. Iron pickaxe for diamond, gold, redstone and emerald. Diamond pickaxe for obsidian and ancient debris. Iron shovel, axe and sword are not made.
- **The switch (Walter, 2026-11-10):** the tool and armor rules flip only once diamond tools and armor with Mending are secured; after that it is maintenance only. Until then: no crafted armor (free armor that drops from a mob farm may be worn), no iron or diamond tools beyond the pickaxes above.
- **Taste:** no stray blocks on the surface; one laddered mineshaft per area, rooms branching off it; shafts recorded in the shared registry; underground first for anything that must not be blown up; trees above ground are kept; grass is cleared in lit areas (flowers stay).
- **Play fair:** survival-legit, no x-ray, no teleporting, flying, elytra or ender-pearl travel; lava rule (never walk with a lava bucket selected); no item piles.

## Phase 1: Subsistence

Food, stone tools, bed, shelter, torches. Done on the Earth map.

## Phase 2: Industry and structure

1. Laddered mineshaft with registry and the 250-block reuse rule; close old staircases.
2. Storage room off the shaft with themed double chests, overflow target, reset-gear chest, lean kit and fixed hotbar.
3. Lit area and torch spacing; grass clearing; cave safety (light or fill caves next to built rooms).
4. Tree farm by the base (saplings, lit grid, natural trees kept); later moved underground.
5. **Respawn network:** a spare bed and a mini reset chest (stone pickaxe, sword, bread, torches) at the base, the mine room and each travel camp.
6. **Hopper smelter** on charcoal from the tree farm; 3 or 4 furnaces first (5 iron per hopper). The bot takes furnace output by hand when it wants the XP.
7. **Underground crop farm and composter** (wheat, carrots, potatoes, water, torches; surplus composts into bone meal). Check Serene Seasons behaviour underground.
8. Mob farm. **XP rule:** keep the kill step bot-made so XP orbs drop; the farm gives string, bones, arrows, gunpowder and free armor. Built by `brain/autopilot/mobfarmbuild.js` (think-brain skill `mob_farm`); design, numbers and limits in `brain/mobfarm/README.md`.
9. **Animal pens** (cows, sheep, pigs, chickens): shear sheep instead of killing, keep leather. Wool feeds beds and the travel kit.
10. **Sugarcane farm** (paper, books, bookshelves later).
11. Glow lichen with shears and bone meal.
12. Late Phase 2: **pointed dripstone and safe lava farms** (design below).
13. Late Phase 2: **camps and short trips** on the travel network (design below).
14. Optional: cobblestone generator, only if cave-filling outruns the stone supply.

## Phase 3: Structured mining base

1. A mining room at one Y level with food, chests, torches, a bed or small farm.
2. **Building-material taste: move on from cobblestone.** Intentional builds (rooms, halls, stations, farms' visible shells) use smooth stone, stone bricks and similar polished stone, not raw cobblestone. Cobblestone stays only as a deliberate texture inside a larger build (a mixed wall, a foundation course, a rustic accent). This is a taste principle, not a survival rule: it applies from early Phase 3, once it is cheap to follow, meaning cobblestone is abundant, fuel farms are running (the charcoal and hopper smelter from Phase 2) and autosmelters exist to turn cobblestone into stone. Before then, cobblestone is fine for functional fill, cave sealing and scaffolding. It could later become a reviewer taste rule (a detector that flags raw cobblestone in finished builds), so keep the wording checkable.
3. **Diamond pickaxe** for obsidian: save 3 diamonds before Phase 3.5.
4. **Villager hall** (design in `brain/villagers/DESIGN.md`), once Walter says "approve villager plan". Priority: it holds the librarian with Mending.
5. **Fishing station.** Offered to the bot, not scheduled over its free time.
6. **Item sorter** at the storage room entrance (needs steady iron).
7. **Multi-day journeys, boat legs and desire paths** (design below).
8. **Iron golem farm** after the hall.

## Phase 3.5: Nether portal

Portal with a safe shell on the far side. Add the Nether support kit (piglin bartering, blaze rods, Nether wart) and a respawn anchor in the far-side shell. Nether travel stays on logged, verified segments only (`brain/nav/nether.js`).

## Phase 4: Enchanting and potions

Bookshelves from sugarcane and pen leather, enchanting from the XP plan, villager books (Mending first), and brewing (below) as the defence layer until diamond armor with Mending exists. Cure villagers for cheaper trades. Then the tool and armor switch: about 33 diamonds, one Mending book per item, an anvil (31 iron). Mending repairs from kill XP, so the bot holds the mended tool at the mob farm.

**Brewing (early Phase 4, right after the Nether kit from 3.5).** Needs blaze rods (stand and fuel) and Nether wart (base for every potion), so it cannot start before Phase 3.5. Build a brewing stand beside the enchanting area, with a water source, glass bottles from sand, and a Nether wart patch on soul sand as a steady supply. Priority order: **fire resistance** first (magma cream), so the bots have it before deeper Nether work and the endgame; then **healing** (glistering melon), **regeneration** (ghast tear) and **strength** (blaze powder). Keep a small potion stack in the reset-gear chest and in the travel kit. Potions are used on the bot's own judgement.

## Phase 5: Endgame

Endgame pack: pearls, blaze powder, stronghold hunt over the travel network, dragon kit (bow, arrows, blocks, water bucket). The Ender Dragon.

**Shulker box farm (late-game goal, important).** Walter's call: shulker boxes are hugely convenient (portable storage that keeps its contents when carried for the travel kit, sorter overflow and the reset-gear chest), so this is a priority once the bots are ready for it, not an optional extra. It needs End access and an End city with ships, so it comes after the Ender Dragon and the outer-islands trip. Shulkers drop shells only when killed, so the farm is a long-term project: find a city, keep a few shulkers alive (a shulker hit by another's bullet can spawn a new one), and build a safe, lit, mob-proof farm room. Design it on the same terms as the other farms (underground-first, bot-made kills for XP). Add a design doc before building.

## Design: long-distance travel (camps as nodes)

Walter's idea: cross long distances in day-long legs, each ending at a nice-looking camp that is logged and left standing, so later crossings and returns are safer.

- **Network file:** `travel-network.json`, the same shape as `nether-network.json` (nodes, segments, hazards, verified). Camps also go to Xaero as a "Camps" waypoint set. A segment is scouted after one walk, verified after a walk back or a second clean walk, blocked after an incident. Returns use verified segments only.
- **Timing:** a game day is 20 real minutes; walking is safe for about ticks 0 to 11,500. Plan about 1,500 blocks per day on foot and about 2,500 by boat (verify boat speed). Start choosing a camp site at tick 9,500, start building by 10,500, finish before 12,000. If the deadline passes, use the existing dig-in fallback (`brain/safety/entomb.js`) and log a failed camp.
- **Camp:** 5 by 5 outside, 3 by 3 inside, 3 high, about 95 blocks; stone plinth, biome-matched planks, bed, cache chest, crafting table, two torches, door and a sign with the name and day. No tree felling. Never near a village, outpost, temple or mansion. On arrival the bot checks for hostiles, a missing door or bed, or a crater, then repairs or marks the node lost.
- **Kit (added to the lean kit):** 32 wool on the first crossing (12 once camps exist), 64 planks, 64 cobblestone or stone bricks, a boat and a crafting table, 32 torches, a door, a chest and a sign, two days of food plus a stack, a water bucket, 16 dirt, a stone shovel.
- **Safer returns:** camps join the shelter list in `brain/safety/shelter.js`; a bed in each camp is a forward respawn point with a mini reset kit; retrace the verified line; hold in camp for thunderstorms or when the next node is out of reach by tick 10,500; store the season with water segments (Serene Seasons freezes water).
- **Boat legs:** used when a route crosses 40 or more contiguous water cells; avoid deep ocean; a 3-block dock with a sign and a tied boat at each end. Prototype boat steering on a river in the trial server first.
- **Desire paths** (only on verified segments, in this order, always the bot's own project): record every walk; after 3 walks, smooth the stored line to the fastest track; clear brush (never fell a trunk); fill 1-block holes and cut 1-block bumps; from 4 walks make dirt path blocks with a stone shovel, at most 10% of leg time. No torches along the road.
- **Build order:** network file and recorder; camp blueprint and deadline on the trial server; one-day round trip of 800 blocks; kit manager and planner, first multi-day crossing; boats; desire paths.
- Camps, docks and path building count as an agreed job under rule 3 (no digging or placing unless part of an agreed job).

## Design: dripstone and safe lava farms

A stalactite drips whatever fluid source sits directly above its root block, into a cauldron up to about 10 blocks below. One column, top to bottom: stone cap, lava source ringed by stone, a plain stone root block, pointed dripstone with the tip down, two air blocks, a cauldron on a stone floor. Verify these mechanics on the trial server before building.

- **Collecting:** take stalagmites and the bottom tip of stalactites, working tip first and upward, standing outside the column. A falling stalactite hurts badly and there is no armor. Never break the block a stalactite hangs from; never drop onto a stalagmite. Add "under a stalactite" as a no-stand cell. Dripstone caves below y 18 need a leashed, lit trip entered from the mine level.
- **Building:** gallery 1 wide and 4 high cut in solid stone at least 3 blocks from the shaft, storage room and chests, lit and behind a door. Place lava once through a side hole inside `safehand.lavaMoment()`, plug the hole with stone on the next tick (lava flows every 30 ticks), water bucket ready, abort if health is below 14. Record the pocket, root and gallery as no-dig cells in the shared registry and protect them in `brain/nav/reach.js`.
- **Safeguards:** nothing flammable within 3 blocks of a pocket; if lava ever shows in the gallery, pour water on the source, stone over the opening, leave. Build near the base, because farms tick only while a player is in simulation distance.
- **Output and cost:** about a bucket per drip in a few game days (estimate, verify); each cauldron is 7 iron, so start with two. The furnace upkeep in `brain/furnace.js` already fills buckets from `lava_cauldron` depots.

## Not planned

Horses (no horse control in Mineflayer), elytra and ender-pearl travel (fair-play rules), totems (they need raids), netherite, kelp or bamboo fuel on inland maps, maps (the bot has coordinates and Xaero data).

## Open items

- Rule 3 agreed job for camps, docks and paths: approved with this roadmap.
- Villager plan: still waits for Walter's "approve villager plan".
- Who names camps: default is the bot, from the nearest landmark or biome.
- Mechanics from memory that need one trial-server pass each: bed spawn by day, dripstone fill rate, boat speed, sugarcane light need, crops under Serene Seasons.
