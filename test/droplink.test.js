// A scratch checkout that borrows node_modules through a link must lose the link, not the folder it points at (2026-11-11: two deploy runs deleted 20 packages
// from the live bots' node_modules). Real directories, no git: the link is made and dropped the way tools/deployer.js and reviewer/lib/fixer.js do.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs'), os = require('os'), path = require('path')
const { dropLink } = require('../tools/deployer')
const fixer = require('../reviewer/lib/fixer')

for (const [name, drop] of [['deployer', dropLink], ['fixer', fixer.dropLink]]) {
  test(`${name}: dropping the borrowed node_modules link leaves the real folder whole`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'droplink-'))
    const real = path.join(root, 'live', 'node_modules'), wt = path.join(root, 'scratch', 'wt')
    fs.mkdirSync(path.join(real, 'ajv'), { recursive: true }); fs.writeFileSync(path.join(real, 'ajv', 'index.js'), 'module.exports = 1')
    fs.mkdirSync(wt, { recursive: true })
    fs.symlinkSync(real, path.join(wt, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.ok(fs.existsSync(path.join(wt, 'node_modules', 'ajv')), 'the link works before')
    assert.equal(drop(path.join(wt, 'node_modules')), true)
    assert.equal(fs.existsSync(path.join(wt, 'node_modules')), false, 'the link is gone')
    fs.rmSync(path.join(root, 'scratch'), { recursive: true, force: true })           // what is left to delete is safe to delete
    assert.ok(fs.existsSync(path.join(real, 'ajv', 'index.js')), 'the real folder is untouched')
    fs.rmSync(root, { recursive: true, force: true })
  })
  test(`${name}: nothing there, or a real directory, is fine to delete around`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'droplink-'))
    assert.equal(drop(path.join(root, 'node_modules')), true)
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true })
    assert.equal(drop(path.join(root, 'node_modules')), true)
    assert.ok(fs.existsSync(path.join(root, 'node_modules', 'x')), 'a real folder is left for the caller to delete, not removed here')
    fs.rmSync(root, { recursive: true, force: true })
  })
}
