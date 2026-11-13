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

/** 上游要求：/session-hub/api/* 必须与官方 /api 网关一样过 Connection 的准入围栏。 */
test('the session-hub routes go through the DSH access admission', async () => {
  const src = await readFile(join(pluginRoot, 'src/index.js'), 'utf8')
  assert.ok(src.includes("'connection'"), 'the plugin must inject the connection service')
  assert.ok(src.includes('requestRejection(req)'), 'the handler must reject unauthorized requests at entry')
  assert.ok(
    src.includes('content type must be application/json'),
    'POST must require application/json, like the official /api gateway',
  )
})

/** 上游要求：启动时不得把其他助手历史里的工作区登记进 DSH。 */
test('startup does not register other agents\' workspaces into DSH', async () => {
  const src = await readFile(join(pluginRoot, 'src/index.js'), 'utf8')
  const startup = src.slice(src.indexOf('webServer.register({ kind:'))
  assert.ok(
    !startup.includes('registerClaudeWorkspaces'),
    'startup must not register Claude workspaces into DSH',
  )
  assert.ok(
    !/syncWorkspaces\(webCtx\.workspaceRegistry\)\.catch/.test(startup),
    'startup must not bulk-register external workspaces into DSH',
  )
  assert.ok(
    startup.includes('migrateImportedGrouping'),
    'startup should still re-attach already imported sessions to existing workspaces',
  )
  assert.ok(src.includes('registerClaudeWorkspaces') === false, 'the startup-only helper should be gone')
  assert.ok(src.includes('/session-hub/api/workspaces/sync'), 'the explicit user-triggered sync endpoint stays')
})

/**
 * DSH 0.2.2+ 的 seed 契约：assistant/message 前后各有 step/start、step/end，
 * 且 data.stream 必须是数组——缺一宿主直接拒收整份 seed（导入静默失败）。
 */
test('the import seed carries the step boundaries and stream the host requires', async () => {
  const src = await readFile(join(pluginRoot, 'src/index.js'), 'utf8')
  const build = src.slice(src.indexOf('function buildImportSeed'))
  assert.ok(build.includes("type: 'step/start'"), 'seed needs a step/start before each assistant message')
  assert.ok(build.includes("type: 'step/end'"), 'seed needs a step/end after each assistant message')
  assert.ok(build.includes('stream: []'), 'assistant/message data.stream must be an array')
  // 只数代码里的类型声明，注释里提到这些名字的不算
  const countType = (name) => (build.match(new RegExp(`type: '${name}'`, 'g')) ?? []).length
  const assistantMessages = countType('assistant/message')
  const stepStarts = countType('step/start')
  const stepEnds = countType('step/end')
  assert.equal(stepStarts, assistantMessages, 'every assistant message needs a step/start')
  assert.equal(stepEnds, assistantMessages, 'every assistant message needs a step/end')
})
/** 导入时按需建工作区：启动不登记，用户点了「接续」才登记并归组。 */
test('importing registers the session workspace on demand so grouping still works', async () => {
  const src = await readFile(join(pluginRoot, 'src/index.js'), 'utf8')
  const attach = src.slice(src.indexOf('async function attachImportedToWorkspace'))
  assert.ok(
    attach.includes('workspaceSvc.create(cwd)'),
    'attach must create the workspace when the cwd is not registered yet',
  )
})

test('client inject omits removed dsh-client-runtime and non-graph packages', () => {
  const inject = pkg.dsh.client.inject ?? []
  assert.ok(!inject.includes('@deepseek-ai/dsh-client-runtime'))
  assert.ok(!inject.includes('@deepseek-ai/dsh-client-ui-slots'))
})
