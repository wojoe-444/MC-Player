// Planks from stripped logs and woods.
// minecraft-data lists each planks recipe for the plain log only (spruce_planks <- spruce_log), but the server accepts the whole log tag:
// stripped logs, woods and stripped woods too. A bot holding only stripped_spruce_log therefore saw "no recipe", could not make a table,
// and sat without tools next to 17 logs (Westeros world 2026-11-14, where trees come stripped). withPlankVariants adds the missing recipes.

// item names that make `<wood>_planks` besides the plain log
function altIngredients(plank) {
  const m = /^(.+)_planks$/.exec(plank)
  if (!m) return []
  const w = m[1]
  if (w === 'bamboo') return ['stripped_bamboo_block']
  if (w === 'crimson' || w === 'warped') return [`stripped_${w}_stem`, `${w}_hyphae`, `stripped_${w}_hyphae`]
  return [`stripped_${w}_log`, `${w}_wood`, `stripped_${w}_wood`]
}

// recipes: what bot.recipesAll returned for `item`; Recipe: the class from prismarine-recipe(version).Recipe
function withPlankVariants(recipes, item, mcData, Recipe) {
  if (!item || !Recipe) return recipes
  const out = recipes.slice()
  for (const name of altIngredients(item.name)) {
    const ing = mcData.itemsByName[name]
    if (!ing || out.some(r => r.delta && r.delta.some(d => d.id === ing.id && d.count < 0))) continue
    out.push(new Recipe({ result: { id: item.id, count: 4 }, ingredients: [ing.id] }))
  }
  return out
}

module.exports = { altIngredients, withPlankVariants }
