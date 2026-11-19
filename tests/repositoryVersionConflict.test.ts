import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryEntryRepository } from '../src/repository/memoryRepository'
import { EntryWriteError } from '../src/repository/errors'
import { FakeStorage } from './helpers'

function installStorage(): void {
  ;(globalThis as { localStorage?: Storage }).localStorage = new FakeStorage()
}

describe('乐观并发：版本冲突与最近数据', () => {
  it('版本匹配时写入并把版本加一', async () => {
    installStorage()
    const repo = new MemoryEntryRepository()
    const created = await repo.create('note', { title: '并发目标', content: '' })
    const stored = await repo.update(created.id, { title: '第一次修改' }, created.version)
    assert.equal(stored.version, created.version + 1)
    assert.equal(stored.title, '第一次修改')
  })

  it('过期版本被拒绝，错误携带最新条目且不覆盖数据', async () => {
    installStorage()
    const repo = new MemoryEntryRepository()
    const created = await repo.create('note', { title: '并发目标', content: '' })
    const first = await repo.update(created.id, { title: '窗口 A 修改' }, created.version)

    await assert.rejects(
      () => repo.update(created.id, { title: '窗口 B 修改' }, created.version),
      (error: unknown) => {
        assert.ok(error instanceof EntryWriteError)
        assert.equal(error.code, 'conflict')
        assert.equal(error.latest?.version, first.version)
        assert.equal(error.latest?.title, '窗口 A 修改')
        return true
      },
    )

    const current = (await repo.listAll()).find((entry) => entry.id === created.id)
    assert.equal(current?.title, '窗口 A 修改', '冲突写入不得落库')
    assert.equal(current?.version, first.version)
  })

  it('缺少期望版本时不允许盲写', async () => {
    installStorage()
    const repo = new MemoryEntryRepository()
    const created = await repo.create('note', { title: '并发目标', content: '' })
    await assert.rejects(
      () => repo.update(created.id, { title: '盲写' }, undefined as unknown as number),
      (error: unknown) => {
        assert.ok(error instanceof EntryWriteError)
        assert.equal(error.code, 'conflict')
        return true
      },
    )
  })
})
