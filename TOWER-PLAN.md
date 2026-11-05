# My tower (OzoGo444's personal build)

Walter pre-approved this build (2026-10-26). It is survival-legit: every block is placed from a spot with a clear line of sight, nothing is dug except a temporary cobblestone pillar I stand on, and only the blocks below are ever placed.

**Pictures** (in `pov\`): `tower-plan-iso.png` (outside), `tower-plan-cutaway.png` (interior), `tower-plan-layers.png` (every course as a grid).
Regenerate any time: `node tools/tower-plan.js` (it reads brain/build/blueprint.js, so it always matches the real build).

## Shape and size
- **5 x 5 tower**, walls 9 courses tall (courses 0-8), then a **lookout deck** at course 9 (an octagon of 45 cells, 7 x 7 with the four corners cut), a **stone-brick parapet** at course 10 and **4 torches** on top at course 11. Total height about 12 blocks above the ground.
- **Corners**: spruce logs (36). **Walls**: stone bricks. **Door** on the south face (2 high). **Window slits** (open air) at courses 2 and 6 in the middle of every face.
- **Inside**: a spruce-plank floor at course 4 (3 x 3 with an opening for the ladder), a **ladder** on the west wall from the ground to the deck, and on the ground floor my **bed, chest and crafting table** (placed if I have them), plus a wall torch.
- **Site**: to be chosen by the survey (best so far: about -957, 152, 2303). The survey wants flat, dry, tree-free ground away from your base; the first choice (the meadow at -984, 2292) was too hilly.

## Materials (blocks placed, from the blueprint)
| block | count |
|---|---|
| stone bricks | 118 |
| spruce planks | 52 |
| spruce log | 36 |
| ladder | 10 |
| torch | 5 |
| bed | 1 |
| crafting table | 1 |
| chest | 1 |
| spruce door | 1 |

(The 4 torches on top plus 1 interior wall torch are the 5 torches; stone bricks are crafted from stone, planks from logs.)

## How it goes up
1. Foundation (fill low cells), then a temporary cobblestone pillar in the middle: I jump-place it up as I go (up to about 11 blocks).
2. Each course of the ring from the pillar top, bottom to top; the floor at course 4; the deck, parapet and torches at the top. Every block is placed against a block I can see.
3. I take the pillar down from the top with a pickaxe, then place the ladder bottom-up while climbing, fill the last deck and floor cells, furnish the inside, and put the door in last.

## Layers (relative cells, x east, z south, origin = north-west corner of the 5 x 5)
- **course 0**: 4 spruce log, 11 stone bricks, 1 ladder, 1 bed, 1 crafting table, 1 chest, 1 spruce door
- **course 1**: 4 spruce log, 11 stone bricks, 1 ladder
- **course 2**: 4 spruce log, 8 stone bricks, 1 ladder, 1 torch
- **course 3**: 4 spruce log, 12 stone bricks, 1 ladder
- **course 4**: 4 spruce log, 12 stone bricks, 8 spruce planks, 1 ladder
- **course 5**: 4 spruce log, 12 stone bricks, 1 ladder
- **course 6**: 4 spruce log, 8 stone bricks, 1 ladder
- **course 7**: 4 spruce log, 12 stone bricks, 1 ladder
- **course 8**: 4 spruce log, 12 stone bricks, 1 ladder
- **course 9**: 44 spruce planks, 1 ladder
- **course 10**: 20 stone bricks
- **course 11**: 4 torch
