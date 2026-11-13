/**
 * 宿主 seed 契约校验器 —— 照抄 `@deepseek-ai/dsh-session` 的校验逻辑。
 *
 * 为什么要在插件仓库里重写一遍：宿主对导入用的 seed 有硬校验，不合契约
 * 整份 seed 被拒（`seed ... has invalid settlement fields` / `message must
 * have role "tool"`）。这些校验只存在于宿主包内，插件侧看不到，于是「宿主
 * 升级 → 导入静默失败」只能等用户碰到才发现。
 *
 * 这里把宿主的规则原样搬过来，对插件真实生成的 seed 跑一遍：宿主加字段、
 * 改规则，插件这边立刻红。
 *
 * 规则来源：`@deepseek-ai/dsh-session@0.2.2-rc.1` 的
 * `assertSessionEventEnvelope` / `assertCurrentLlmShape` /
 * `assertAssistantSettlementShape` / `assertMessageEventShape` /
 * `validateSessionEventData`。
 *
 * 这三个函数在本插件声明的四个宿主版本（0.2.1-rc.5、0.2.2-alpha.2、
 * 0.2.2-alpha.3、0.2.2-rc.1）里逐字节相同（已按函数体哈希核对），
 * 所以这份校验器对整个兼容窗口都成立。
 */

/** 宿主允许出现在 seed 事件信封里的键。 */
const ENVELOPE_KEYS = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'])

/** 宿主认为「带消息体」的事件类型。 */
const MESSAGE_EVENT_TYPES = new Set([
  'developer/message',
  'system/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/** 各消息事件类型要求的 role。 */
const MESSAGE_ROLE_BY_TYPE = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
}

/** 宿主里要求额外校验的事件类型。 */
const CURRENT_LLM_TYPES = new Set([
  'request/header',
  'developer/message',
  'system/message',
  'user/message',
  'assistant/attempt',
  'assistant/message',
  'tool/result',
])

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

function hasProviderModel(value) {
  if (!isRecord(value)) return false
  return typeof value.provider === 'string' && value.provider.length > 0 &&
    typeof value.model === 'string' && value.model.length > 0
}

/** 宿主 assertAssistantSettlementShape：turn/step 是非负整数，stream 必须是数组。 */
function assertAssistantSettlementShape(data, type, index) {
  const turn = data?.turn
  const step = data?.step
  if (
    typeof turn !== 'number' || !Number.isSafeInteger(turn) || turn < 0 || Object.is(turn, -0) ||
    typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0 || Object.is(step, -0) ||
    !Array.isArray(data?.stream)
  ) {
    throw new Error(`seed ${type} at index ${index} has invalid settlement fields`)
  }
}

/** 宿主 assertMessageEventShape：消息体的 id / role / source / content 约束。 */
function assertMessageEventShape(event, subject) {
  const type = event.type
  if (!MESSAGE_EVENT_TYPES.has(type)) return
  const data = event.data
  const record = isRecord(data) ? data : undefined
  const message = type === 'user/message' ? record : record?.message
  if (!isRecord(message) || typeof message.id !== 'string' || message.id === '') {
    throw new Error(`${subject} lacks an identified message`)
  }
  const expectedRole = MESSAGE_ROLE_BY_TYPE[type]
  if (message.role !== expectedRole) {
    throw new Error(`${subject} message must have role "${expectedRole}"`)
  }
  const source = message.source
  if (!isRecord(source) || typeof source.kind !== 'string' || source.kind === '') {
    throw new Error(`${subject} message has invalid source`)
  }
  if (!Array.isArray(message.content)) {
    throw new Error(`${subject} message has invalid content`)
  }
  if (type === 'system/message') {
    if (source.kind !== 'system-prompt') {
      throw new Error(`${subject} message must have system-prompt source`)
    }
    return
  }
  if (type === 'assistant/message') {
    if (source.kind !== 'model' || !hasProviderModel(source)) {
      throw new Error(`${subject} message must have model source`)
    }
    return
  }
  if (type !== 'tool/result') return
  if (source.kind !== 'tool' || typeof source.callId !== 'string' || source.callId === '') {
    throw new Error(`${subject} message must have tool source`)
  }
  if (message.toolCallId !== source.callId) {
    throw new Error(`${subject} message has mismatched tool call ids`)
  }
}

/** 宿主 assertCurrentLlmShape。 */
function assertCurrentLlmShape(event, index) {
  const data = event.data
  const record = isRecord(data) ? data : undefined
  const type = event.type
  if (type === 'request/header') {
    const headerRecord = record?.header
    const config = headerRecord?.config
    if (!hasProviderModel(config)) {
      throw new Error(`seed request/header at index ${index} lacks provider/model`)
    }
    const reasoningEffort = config.reasoningEffort
    if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || reasoningEffort.length === 0)) {
      throw new Error(`seed request/header at index ${index} has an invalid reasoningEffort`)
    }
    const reason = record?.reason
    if (reason !== 'initial' && reason !== 'resume' && reason !== 'change' && reason !== 'series') {
      throw new Error(`seed request/header at index ${index} has an invalid reason`)
    }
    if (record?.startsSeries !== undefined && record.startsSeries !== true) {
      throw new Error(`seed request/header at index ${index} has an invalid startsSeries marker`)
    }
  }
  if (type === 'assistant/attempt') {
    assertAssistantSettlementShape(record, type, index)
    return
  }
  if (!MESSAGE_EVENT_TYPES.has(type)) return
  assertMessageEventShape(event, `seed ${type} at index ${index}`)
  if (type === 'assistant/message') assertAssistantSettlementShape(record, type, index)
}

/** 宿主 validateSessionEventData 里与本插件相关的部分。 */
function validateSessionEventData(event, subject) {
  const data = event.data
  if (event.type === 'tool/result') {
    if (!isRecord(data)) throw new Error(`${subject} data must be an object`)
    if (data.error === undefined) return
    const message = data.message
    if (!isRecord(message) || message.isError !== true) {
      throw new Error(`${subject} error requires message.isError === true`)
    }
  }
}

/** 宿主 assertSessionEventEnvelope。 */
export function assertSessionEventEnvelope(value, index) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`seed event at index ${index} has an invalid event envelope`)
  }
  const event = value
  for (const key in event) {
    if (!ENVELOPE_KEYS.has(key)) {
      throw new Error(`seed event at index ${index} has an invalid event envelope`)
    }
  }
  const type = event.type
  const seq = event.seq
  const time = event.time
  if (
    typeof type !== 'string' ||
    typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || Object.is(seq, -0) ||
    typeof time !== 'number' || !Number.isSafeInteger(time) ||
    event.data === undefined ||
    (event.ignorable !== undefined && event.ignorable !== true)
  ) {
    throw new Error(`seed event at index ${index} has an invalid event envelope`)
  }
  validateSessionEventData(event, `seed ${type} at index ${index}`)
  if (CURRENT_LLM_TYPES.has(type)) assertCurrentLlmShape(event, index)
}

/** 校验整份 seed；不合法时抛出与宿主同措辞的错误。 */
export function assertSeedAccepted(seed) {
  if (!Array.isArray(seed)) throw new Error('seed must be an array')
  seed.forEach((event, index) => assertSessionEventEnvelope(event, index))
  return seed
}
