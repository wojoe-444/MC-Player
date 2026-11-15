const test = require('node:test')
const assert = require('node:assert')
const mcData = require('minecraft-data')('1.21.6')
const { Recipe } = require('prismarine-recipe')('1.21.6')
const { altIngredients, withPlankVariants } = require('../brain/autopilot/plankvariants')

const id = (n) => mcData.itemsByName[n].id
const ingredientsOf = (recipes) => recipes.flatMap(r => r.delta.filter(d => d.count < 0).map(d => mcData.items[d.id].name))

test('planks: stripped logs, woods and stripped woods are added to the data recipe', () => {
  const item = mcData.itemsByName.spruce_planks
  const data = Recipe.find(item.id, null)
  assert.deepStrictEqual(ingredientsOf(data), ['spruce_log'])             // the data knows the plain log only: the bug
  const all = withPlankVariants(data, item, mcData, Recipe)
  assert.deepStrictEqual(ingredientsOf(all).sort(), ['spruce_log', 'spruce_wood', 'stripped_spruce_log', 'stripped_spruce_wood'])
  for (const r of all) { assert.strictEqual(r.result.count, 4); assert.strictEqual(r.requiresTable, false) }
})

test('planks: nether stems, bamboo and non-planks are handled; nothing is added twice', () => {
  assert.deepStrictEqual(altIngredients('crimson_planks'), ['stripped_crimson_stem', 'crimson_hyphae', 'stripped_crimson_hyphae'])
  assert.deepStrictEqual(altIngredients('bamboo_planks'), ['stripped_bamboo_block'])
  assert.deepStrictEqual(altIngredients('stick'), [])
  for (const n of ['oak_planks', 'cherry_planks', 'pale_oak_planks', 'crimson_planks', 'warped_planks', 'bamboo_planks', 'mangrove_planks']) {
    const item = mcData.itemsByName[n]
    const once = withPlankVariants(Recipe.find(item.id, null), item, mcData, Recipe)
    const twice = withPlankVariants(once, item, mcData, Recipe)
    assert.strictEqual(twice.length, once.length, n)
    for (const nm of altIngredients(n)) assert.ok(ingredientsOf(once).includes(nm), `${n} <- ${nm}`)
  }
  const stick = mcData.itemsByName.stick
  const sr = Recipe.find(stick.id, null)
  assert.strictEqual(withPlankVariants(sr, stick, mcData, Recipe).length, sr.length)
})

test('planks: a synthetic recipe crafts from the bag like a real one', () => {
  const item = mcData.itemsByName.spruce_planks
  const r = withPlankVariants(Recipe.find(item.id, null), item, mcData, Recipe).find(x => ingredientsOf([x])[0] === 'stripped_spruce_log')
  assert.deepStrictEqual(r.delta.map(d => [mcData.items[d.id].name, d.count]), [['stripped_spruce_log', -1], ['spruce_planks', 4]])
  assert.strictEqual(r.result.id, id('spruce_planks'))
})
