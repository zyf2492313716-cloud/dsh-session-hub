/**
 * 导入 seed 的宿主契约测试。
 *
 * 关键点：不是检查源码里「有没有某个字符串」，而是**调用插件真实的
 * buildImportSeed 生成 seed，再用宿主的校验规则逐条验**。宿主加字段或改规则，
 * 这里立刻红——不用等用户导入时才发现。
 *
 * 宿主校验器见同目录 host-seed-contract.mjs（照抄 @deepseek-ai/dsh-session）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { assertSeedAccepted } from './host-seed-contract.mjs'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** 一个含用户消息、工具调用、工具结果、推理与最终文本的外部会话。 */
function demoSession() {
  return {
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
      {
        role: 'assistant',
        time: 1790000002000,
        parts: [{ type: 'text', text: '项目有两个文件。' }],
      },
    ],
  }
}

/** src 与 lib 是同一份逻辑的两个形态，seed 契约必须同时成立。 */
const BUILDS = [
  ['src', join(pluginRoot, 'src/index.js')],
  ['lib', join(pluginRoot, 'lib/index.js')],
]

for (const [label, path] of BUILDS) {
  test(`[${label}] the import seed is accepted by the host contract`, async () => {
    const { buildImportSeed } = await import(path)
    assert.equal(typeof buildImportSeed, 'function', `${label} must export buildImportSeed`)

    const seed = buildImportSeed(demoSession(), '继续处理')
    assertSeedAccepted(seed)
  })

  test(`[${label}] the import seed is accepted with an instruction and without one`, async () => {
    const { buildImportSeed } = await import(path)
    // 插件会拼一条「用户指示」的消息，两种入参都要能过宿主校验
    assertSeedAccepted(buildImportSeed(demoSession(), '继续处理'))
    assertSeedAccepted(buildImportSeed(demoSession(), ''))
    assertSeedAccepted(buildImportSeed(demoSession(), undefined))
  })
}

/**
 * 回归护栏：宿主曾要求 assistant/message 与 step/start 都带 data.stream，
 * tool/result 的 message.role 必须是 "tool" 且 toolCallId 与 source.callId 一致。
 * 这里按事件类型逐个断言，字段放错事件会立刻暴露。
 */
test('every seeded event carries the fields the host reads off it', async () => {
  const { buildImportSeed } = await import(join(pluginRoot, 'src/index.js'))
  const seed = buildImportSeed(demoSession(), '继续处理')

  const settlementEvents = seed.filter(
    (e) => e.type === 'assistant/message' || e.type === 'step/start',
  )
  assert.ok(settlementEvents.length >= 2, 'the demo session produces assistant/step events')
  for (const event of settlementEvents) {
    assert.ok(Array.isArray(event.data.stream), `${event.type} needs data.stream to be an array`)
    assert.ok(Number.isSafeInteger(event.data.turn) && event.data.turn >= 0, `${event.type} needs data.turn`)
    assert.ok(Number.isSafeInteger(event.data.step) && event.data.step >= 0, `${event.type} needs data.step`)
  }

  const toolResults = seed.filter((e) => e.type === 'tool/result')
  assert.ok(toolResults.length >= 1, 'the demo session produces a tool result')
  for (const event of toolResults) {
    assert.equal(event.data.message.role, 'tool', 'tool/result message.role must be "tool"')
    assert.equal(event.data.message.source.kind, 'tool')
    assert.equal(
      event.data.message.toolCallId,
      event.data.message.source.callId,
      'tool/result toolCallId must match source.callId',
    )
  }
})

/** seed 里不能出现宿主信封不认的键。 */
test('seed events only use envelope keys the host accepts', async () => {
  const { buildImportSeed } = await import(join(pluginRoot, 'src/index.js'))
  const seed = buildImportSeed(demoSession(), '继续处理')
  const allowed = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'])
  for (const [index, event] of seed.entries()) {
    for (const key of Object.keys(event)) {
      assert.ok(allowed.has(key), `seed event ${index} (${event.type}) has unexpected key "${key}"`)
    }
  }
})
