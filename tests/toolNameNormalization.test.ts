import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeToolCallName } from '../src/services/toolNameNormalization'

const allowed = new Set(['create_entry', 'search_notes', 'delete_entry'])

test('工具名归一化：正常名称保持不变', () => {
  assert.equal(normalizeToolCallName('create_entry', allowed), 'create_entry')
})

test('工具名归一化：去掉上游混入的 Harmony 控制标记', () => {
  assert.equal(normalizeToolCallName('create_entry<|channel|>json', allowed), 'create_entry')
  assert.equal(normalizeToolCallName('create_entry<|channel|>', allowed), 'create_entry')
})

test('工具名归一化：未注册名称仍原样返回，交由执行层拦截', () => {
  assert.equal(
    normalizeToolCallName('create_entry_evil<|channel|>json', allowed),
    'create_entry_evil<|channel|>json',
  )
  assert.equal(normalizeToolCallName('unknown<|channel|>json', allowed), 'unknown<|channel|>json')
})

test('工具名归一化：控制标记在前或名称本身含尖括号时不处理', () => {
  assert.equal(normalizeToolCallName('<|channel|>create_entry', allowed), '<|channel|>create_entry')
  assert.equal(normalizeToolCallName('create<entry>', allowed), 'create<entry>')
})
