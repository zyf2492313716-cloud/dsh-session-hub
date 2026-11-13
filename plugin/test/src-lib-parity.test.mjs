/**
 * src 与 lib 的一致性守卫。
 *
 * 背景：这个插件的 `lib/` 是提交进仓库的构建产物，但 tsdown 不是本包的依赖，
 * 所以历史上一直是手工同步 src 与 lib。2026-11 出过一次分叉：src 里补的 seed
 * 契约适配没同步进 lib，发布出去的版本导入直接失败——而两边各自单看都没问题。
 *
 * 这里不要求字节相同（不同 tsdown 版本的产物格式有差异，逐一比对会变成噪音），
 * 只要求**公共 API 的存在性与行为一致**：任何一边改了导出或改了返回行为，
 * 另一边没跟上，这��就会红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const src = await import(join(pluginRoot, 'src/index.js'))
const lib = await import(join(pluginRoot, 'lib/index.js'))

/** 插件对外承诺的 API。 */
const PUBLIC_API = [
  'apply',
  'buildImportSeed',
  'invalidateSourceCache',
  'listBySource',
  'listWorkspaces',
  'overview',
  'readSession',
  'searchSessions',
]

test('src and lib expose the same public API', () => {
  for (const name of PUBLIC_API) {
    assert.equal(typeof src[name], 'function', `src must export ${name}`)
    assert.equal(typeof lib[name], 'function', `lib must export ${name}`)
  }
  const srcNames = Object.keys(src).sort()
  const libNames = Object.keys(lib).sort()
  assert.deepEqual(
    srcNames,
    libNames,
    'src and lib must export exactly the same names — a new export must land in both',
  )
})

/** 同一输入下，src 与 lib 必须给出同样的结果。 */
test('src and lib produce the same seed for the same session', () => {
  const session = {
    source: 'claude',
    id: 'sess-demo',
    title: '演示会话',
    cwd: '/tmp/demo-proj',
    agent: 'claude',
    model: 'claude-sonnet-4',
    cost: 0,
    timeCreated: 1790000000000,
    timeUpdated: 1790000000000,
    messages: [
      { role: 'user', time: 1790000000000, parts: [{ type: 'text', text: '帮我看看项目' }] },
      {
        role: 'assistant',
        time: 1790000001000,
        parts: [
          { type: 'reasoning', text: '先看看目录结构' },
          { type: 'tool', tool: 'Bash', input: '{"command":"ls"}', output: 'a.ts\nb.ts' },
        ],
      },
      { role: 'assistant', time: 1790000002000, parts: [{ type: 'text', text: '项目有两个文件。' }] },
    ],
  }
  const shape = (seed) =>
    seed.map((e) => [e.type, e.data?.turn ?? null, e.data?.step ?? null, e.data ? 'stream' in e.data : null])

  assert.deepEqual(
    shape(src.buildImportSeed(session, '继续处理')),
    shape(lib.buildImportSeed(session, '继续处理')),
    'src and lib must build the same seed shape — a change in one needs the other',
  )
})

/** 导出的只读查询函数在两份实现下也必须一致。 */
test('src and lib agree on the read-only query APIs', () => {
  for (const name of ['overview', 'listBySource', 'listWorkspaces', 'searchSessions']) {
    assert.deepEqual(
      src[name]('all'),
      lib[name]('all'),
      `${name} must behave the same in src and lib`,
    )
  }
})
