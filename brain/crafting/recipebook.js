// The server's recipe book, for fast bulk crafting. Since 1.21.2 a client can ask the server to fill the crafting grid with a recipe
// (packet craft_recipe_request {windowId, recipeId = displayId, makeAll}); the server moves the ingredients itself, and a click on the result
// slot with shift crafts everything in the grid. The display ids come from recipe_book_add packets, which the server sends at login, so
// something has to be listening from the start: join.js keeps them in bot._recipeBook (Map displayId -> RecipeDisplay), see README.md.
// This module also listens on its own for later unlocks, so a missing early listener only costs the recipes known at login.
//
//   const book = createRecipeBook(bot)
//   book.find(recipe)  -> { id, shaped, width, height } | null     (recipe = prismarine-recipe / mineflayer recipe)
//   book.size()        -> number of known crafting displays

// item id of a SlotDisplay ({type, data}); null when it does not name one item
function slotItem(d) {
  if (!d) return null
  switch (d.type) {
    case 'item': return typeof d.data === 'number' ? d.data : null
    case 'item_stack': return d.data && (d.data.itemId ?? d.data.item ?? null)
    case 'with_remainder': return slotItem(d.data && d.data.input)
    case 'composite': return Array.isArray(d.data) && d.data.length ? slotItem(d.data[0]) : null
    default: return null
  }
}
// every item id a SlotDisplay can stand for, or 'any' when it is a tag (resolved by the server)
function slotItems(d) {
  if (!d) return []
  switch (d.type) {
    case 'item': case 'item_stack': { const i = slotItem(d); return i == null ? [] : [i] }
    case 'tag': return 'any'
    case 'with_remainder': return slotItems(d.data && d.data.input)
    case 'composite': {
      const out = []
      for (const x of d.data || []) { const s = slotItems(x); if (s === 'any') return 'any'; out.push(...s) }
      return out
    }
    default: return []
  }
}

function createRecipeBook(bot) {
  const map = bot._recipeBook instanceof Map ? bot._recipeBook : (bot._recipeBook = new Map())
  const client = bot._client
  if (client && typeof client.on === 'function' && !bot._recipeBookListening) {
    bot._recipeBookListening = true
    client.on('recipe_book_add', (p) => { if (p.replace) map.clear(); for (const e of p.entries || []) if (e && e.recipe) map.set(e.recipe.displayId, e.recipe.display) })
    client.on('recipe_book_remove', (p) => { for (const id of p.recipeIds || []) map.delete(id) })
  }

  function find(recipe) {
    if (!recipe || !recipe.result) return null
    const need = new Set(recipe.delta.filter(d => d.count < 0).map(d => d.id))
    const shapeW = recipe.inShape ? Math.max(...recipe.inShape.map(r => r.length)) : null
    const shapeH = recipe.inShape ? recipe.inShape.length : null
    let best = null
    for (const [id, disp] of map) {
      if (!disp || (disp.type !== 'crafting_shaped' && disp.type !== 'crafting_shapeless')) continue
      const d = disp.data || {}
      if (slotItem(d.result) !== recipe.result.id) continue
      const shaped = disp.type === 'crafting_shaped'
      if (!!recipe.inShape !== shaped) continue
      if (shaped && (d.width !== shapeW || d.height !== shapeH)) continue
      // ingredients: every item this recipe uses must be possible in the display (tags are resolved by the server)
      let ok = true, any = false
      const have = new Set()
      for (const ing of d.ingredients || []) { const s = slotItems(ing); if (s === 'any') any = true; else s.forEach(x => have.add(x)) }
      for (const n of need) if (!have.has(n) && !any) { ok = false; break }
      if (!ok) continue
      const score = any ? 1 : 2     // a display that names the very items wins over one that only has tags
      if (!best || score > best.score) best = { id, shaped, width: d.width || null, height: d.height || null, score }
    }
    return best
  }
  return { find, size: () => map.size, map }
}

module.exports = { createRecipeBook, slotItem, slotItems }
