import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))

test('manifest declares the DSH bundle and web client', () => {
  assert.equal(pkg.name, '@dsh-local/dsh-session-hub')
  assert.equal(pkg.dsh.bundle.patch, 'dsh-session-hub.cordis.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(existsSync(join(pluginRoot, pkg.dsh.bundle.patch)))
  assert.ok(existsSync(join(pluginRoot, 'lib/index.js')))
  assert.ok(existsSync(join(pluginRoot, 'lib/client.js')))
})

test('manifest points at the canonical repository and tested DSH release', () => {
  assert.equal(pkg.repository.url, 'git+https://github.com/zyf2492313716-cloud/dsh-session-hub.git')
  assert.equal(pkg.repository.directory, 'plugin')
  assert.equal(pkg.engines.node, '>=22.15')
  assert.equal(pkg.engines.dsh, '>=0.2.0')
  assert.equal(pkg.dsh.compatibility.dshReleases['0.2.1-rc.5'], 'compatible')
})
