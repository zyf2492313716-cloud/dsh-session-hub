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

/** 官方最新三个版本窗口（npm @deepseek-ai/dsh 的 latest 之前最近三个未弃用发行版）。 */
const LATEST_THREE = ['0.2.2-alpha.2', '0.2.2-alpha.3', '0.2.2-rc.1']

test('manifest points at the canonical repository and tested DSH release', () => {
  assert.equal(pkg.repository.url, 'git+https://github.com/zyf2492313716-cloud/dsh-session-hub.git')
  assert.equal(pkg.repository.directory, 'plugin')
  assert.equal(pkg.engines.node, '>=22.15')
  assert.equal(pkg.engines.dsh, '>=0.2.0')
  assert.equal(pkg.dsh.compatibility.dshReleases['0.2.1-rc.5'], 'compatible')
})

test('manifest covers the latest-three window with exact per-release records', () => {
  const declared = pkg.dsh.compatibility.dshReleases
  for (const release of LATEST_THREE) {
    assert.equal(declared[release], 'compatible', `${release} must be declared explicitly`)
  }
})

test('every declared release satisfies the engines.dsh range', () => {
  const range = pkg.engines.dsh
  assert.ok(range.startsWith('>='), 'this plugin pins a single lower bound')
  const lower = range.slice(2)
  const cmp = (a, b) => {
    const pa = a.split(/[-+]/)[0].split('.').map(Number)
    const pb = b.split(/[-+]/)[0].split('.').map(Number)
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
    return (a.split('-')[1] || '~').localeCompare(b.split('-')[1] || '~', undefined, { numeric: true })
  }
  for (const [release, verdict] of Object.entries(pkg.dsh.compatibility.dshReleases)) {
    if (verdict !== 'compatible') continue
    assert.ok(cmp(release, lower) >= 0, `${release} declared compatible but below engines.dsh ${range}`)
  }
})

test('the node source contract states the real write paths', async () => {
  const src = await readFile(join(pluginRoot, 'src/index.js'), 'utf8')
  assert.ok(!src.includes('零写入'), 'header must not claim zero writes: /continue and /export do write')
  for (const marker of ['/session-hub/api/continue', '/session-hub/api/export', 'state.json', 'history.jsonl']) {
    assert.ok(src.includes(marker), `header should name the write surface: ${marker}`)
  }
})

test('client inject omits removed dsh-client-runtime and non-graph packages', () => {
  const inject = pkg.dsh.client.inject ?? []
  assert.ok(!inject.includes('@deepseek-ai/dsh-client-runtime'))
  assert.ok(!inject.includes('@deepseek-ai/dsh-client-ui-slots'))
})
