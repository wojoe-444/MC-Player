// The iron kit the bot owns but never made: an iron pickaxe, and ladders for the shaft.
// 2026-11-11: both bots held 14-20 iron ingots and the sticks for 14 hours, and the dawn brief put `tool-kit` in focus seven times and asked Walter why it
// made nothing. It could not: tool-kit only ever made stone pickaxes (its need() read "a pickaxe, two of them"), and the one place that crafted an iron
// pickaxe was inside the iron step's own mining, which the brief had on hold. So pursue and the shaft (which need the pick and ladders) waited on a step
// that had no way to produce them. This is that way. Pure of the world: it works on the skill set S that plan.js already has.
const PICK_INGOTS = 3, LADDER_STICKS = 7, LADDERS = 3

// an iron (or better) pickaxe is missing and the bag holds what it takes (3 ingots; sticks may come from planks or logs)
const wantsPick = (S) => S.count(/^(iron|diamond|netherite)_pickaxe$/) < 1 && S.count('iron_ingot') >= PICK_INGOTS && S.count('stick') + S.planks() * 2 + S.logs() * 8 >= 2
// ladders for the shaft: 3 of them, from 7 sticks (planks and logs make sticks), once the pickaxe is settled so the ingots are not the question
const wantsLadders = (S) => S.count('ladder') < LADDERS && S.count('stick') + S.planks() * 2 + S.logs() * 8 >= LADDER_STICKS

const wants = (S) => wantsPick(S) || wantsLadders(S)

// craft what is missing, pickaxe first. -> { pick: bool, ladders: bool } with what the bag holds afterwards
async function make(S, note = () => {}) {
  const out = {}
  if (wantsPick(S)) { const ok = await S.craft('iron_pickaxe', 1).catch(() => false); note(`tool-kit: iron pickaxe ${ok ? 'made' : 'not made'}`) }
  if (wantsLadders(S)) { const ok = await S.craft('ladder', LADDERS).catch(() => false); note(`tool-kit: ladders ${ok ? 'made' : 'not made'}`) }
  out.pick = S.count(/^(iron|diamond|netherite)_pickaxe$/) >= 1; out.ladders = S.count('ladder') >= LADDERS
  return out
}

module.exports = { wants, wantsPick, wantsLadders, make, PICK_INGOTS, LADDER_STICKS, LADDERS }
