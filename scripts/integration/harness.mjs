import { createServer } from 'vite'

/**
 * 集成测试运行环境：复用现有 Vite（devDependency）把真实源码加载进 Node，
 * 不打包、不引入新依赖，也不复制任何业务逻辑。
 *
 * 加载的是真实模块：
 * - src/store/useAssistantStore.ts（完整 agent loop）
 * - src/services/aiClient.ts（浏览器直连 SSE 解析）
 * - src/store/useEntryStore.ts + MemoryEntryRepository（真实仓储）
 */

const CONFIG_KEY = 'bianqian.assistant.ai.v2'
const PROFILE_ID = 'integration-profile'

class FakeStorage {
  constructor() {
    this.map = new Map()
  }
  get length() {
    return this.map.size
  }
  clear() {
    this.map.clear()
  }
  getItem(key) {
    return this.map.get(key) ?? null
  }
  key(index) {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key) {
    this.map.delete(key)
  }
  setItem(key, value) {
    this.map.set(key, String(value))
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function createRuntime() {
  if (!globalThis.localStorage) {
    globalThis.localStorage = new FakeStorage()
  }
  if (!globalThis.window) {
    globalThis.window = globalThis
  }

  const vite = await createServer({
    root: process.cwd(),
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  })

  const [
    assistantMod,
    entryMod,
    repoMod,
    deleteMod,
    deleteExecMod,
    selectionMod,
    toolsMod,
    registryMod,
    freeModelsMod,
    historyRepoMod,
    historyRecorderMod,
    historyRecoveryMod,
    deleteHistoryMod,
  ] = await Promise.all([
    vite.ssrLoadModule('/src/store/useAssistantStore.ts'),
    vite.ssrLoadModule('/src/store/useEntryStore.ts'),
    vite.ssrLoadModule('/src/repository/index.ts'),
    vite.ssrLoadModule('/src/services/deleteProposals.ts'),
    vite.ssrLoadModule('/src/services/deleteExecution.ts'),
    vite.ssrLoadModule('/src/services/alarmSelectionExecution.ts'),
    vite.ssrLoadModule('/src/services/agentTools.ts'),
    vite.ssrLoadModule('/src/services/alarmSelections.ts'),
    vite.ssrLoadModule('/src/services/freeModels.ts'),
    vite.ssrLoadModule('/src/repository/executionRepository.ts'),
    vite.ssrLoadModule('/src/services/executionRecorder.ts'),
    vite.ssrLoadModule('/src/services/executionHistoryRecovery.ts'),
    vite.ssrLoadModule('/src/services/deleteConfirmationHistory.ts'),
  ])

  const assistant = assistantMod.useAssistantStore
  const entries = entryMod.useEntryStore
  const repository = repoMod.getRepository()
  const historyRepo = () => historyRepoMod.getAgentExecutionRepository()

  async function listHistory(query = {}) {
    return historyRepo().list(query)
  }

  function getHistory(id) {
    return historyRepo().getById(id)
  }

  function getHistorySteps(id) {
    return historyRepo().getSteps(id)
  }

  function createHistoryRecord(record) {
    return historyRepo().create(record)
  }

  function upsertHistoryStep(step) {
    return historyRepo().upsertStep(step)
  }

  function deleteHistory(id) {
    return historyRepo().deleteById(id)
  }

  function clearHistory() {
    return historyRepo().clear()
  }

  function flushHistory() {
    return historyRecorderMod.getExecutionRecorder().flush()
  }

  async function recoverHistory() {
    historyRecoveryMod.resetHistoryRecoveryForTests()
    await historyRecoveryMod.recoverInterruptedExecutions()
  }

  async function selectAlarm(proposalId, entryId, alarmId) {
    const result = await selectionMod.confirmAlarmSelection({
      proposalId,
      entryId,
      alarmId,
      env: toolsMod.createAgentToolEnv(),
    })
    entries.setState({ entries: await repository.listAll() })
    return result
  }

  function cancelSelection(proposalId, messageId) {
    registryMod.cancelAlarmSelection(proposalId)
    if (messageId) assistant.getState().markToolSelectionCancelled(messageId, proposalId)
  }

  function expireSelection(proposalId) {
    registryMod.expireAlarmSelection(proposalId, Date.now() + 24 * 3600_000)
  }

  function getSelection(proposalId) {
    return registryMod.getAlarmSelection(proposalId)
  }

  /** 模拟授权执行前被篡改：只改 patch，不扩大 allowedFields */
  function tamperSelection(proposalId, extra) {
    const proposal = registryMod.getAlarmSelection(proposalId)
    if (!proposal) throw new Error(`selection ${proposalId} not found`)
    proposal.patch = { ...proposal.patch, ...extra }
  }

  /** 模拟用户直接编辑提醒（不是通过 agent）：用于验证快照失效 */
  async function updateEntryDirect(id, patch) {
    await repository.update(id, patch)
    entries.setState({ entries: await repository.listAll() })
  }

  function configureProfile({
    baseUrl,
    model,
    apiKey = '',
    temperature = 0,
    maxTokens = 1024,
    reasoning = null,
  }) {
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({
        version: 2,
        activeId: PROFILE_ID,
        profiles: [
          {
            id: PROFILE_ID,
            name: 'integration',
            provider: '',
            baseUrl,
            model,
            apiKey,
            temperature,
            maxTokens,
            reasoning,
          },
        ],
      }),
    )
  }

  /** 直接选中内置免费模型：与桌面端 activeId 为 free:<source>:<model> 时一致 */
  function configureFreeModel(id) {
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({ version: 2, activeId: id, profiles: [] }),
    )
  }

  /** 受控失败注入：默认只影响下一次匹配的创建；times 为负数时持续失败 */
  let createFailure = null
  let createFailureRemaining = 0
  const originalCreate = repository.create.bind(repository)
  repository.create = async (kind, input) => {
    if (createFailure && createFailureRemaining !== 0 && createFailure(kind, input)) {
      if (createFailureRemaining > 0) createFailureRemaining -= 1
      throw new Error('INJECTED_TEST_CREATE_FAILURE')
    }
    return originalCreate(kind, input)
  }

  function injectCreateFailure(predicate, { times = 1 } = {}) {
    createFailure = predicate
    createFailureRemaining = times
  }

  function injectCreateFailureOnce(predicate) {
    injectCreateFailure(predicate)
  }

  function clearCreateFailure() {
    createFailure = null
    createFailureRemaining = 0
  }

  /** 受控失败注入：默认只影响下一次匹配的修改；times 为负数时持续失败 */
  let updateFailure = null
  let updateFailureRemaining = 0
  const originalUpdate = repository.update.bind(repository)
  repository.update = async (id, patch) => {
    if (
      updateFailure &&
      updateFailureRemaining !== 0 &&
      updateFailure(id, patch)
    ) {
      if (updateFailureRemaining > 0) updateFailureRemaining -= 1
      throw new Error('INJECTED_TEST_UPDATE_FAILURE')
    }
    return originalUpdate(id, patch)
  }

  function injectUpdateFailure(predicate, { times = 1 } = {}) {
    updateFailure = predicate
    updateFailureRemaining = times
  }

  function clearUpdateFailure() {
    updateFailure = null
    updateFailureRemaining = 0
  }

  /** 受控失败注入：只影响下一次删除确认的 moveToTrash */
  let trashFailureOnce = false

  function injectTrashFailureOnce() {
    trashFailureOnce = true
  }

  function clearTrashFailure() {
    trashFailureOnce = false
  }

  async function reset(profile) {
    // 先落盘旧场景的历史写入，再换仓储 / 清空存储，避免迟到写入污染下一个场景
    await flushHistory()
    historyRecorderMod.resetExecutionRecorderForTests()
    historyRecoveryMod.resetHistoryRecoveryForTests()
    localStorage.clear()
    if (profile.freeModelId) configureFreeModel(profile.freeModelId)
    else configureProfile(profile)
    createFailure = null
    createFailureRemaining = 0
    updateFailure = null
    updateFailureRemaining = 0
    trashFailureOnce = false
    // clear() 同时清空对话记忆摘要缓存，保证场景之间不共享上下文
    assistant.getState().clear()
    assistant.setState({
      messages: [],
      input: '',
      sending: false,
      open: false,
      contextEnabled: true,
      webSearch: false,
    })
    entries.setState({
      entries: [],
      trash: [],
      initialized: true,
      loading: false,
      selectedId: null,
      filter: 'all',
      search: '',
      tagFilter: null,
      timeRange: 'all',
    })
    deleteMod.resetDeleteProposals()
    registryMod.resetAlarmSelections()
  }

  async function seed(nextEntries) {
    await repository.importAll(nextEntries)
    entries.setState({ entries: await repository.listAll() })
  }

  function listEntries() {
    return entries.getState().entries
  }

  function selectEntry(id) {
    entries.setState({ selectedId: id })
  }

  async function sendPrompt(text, { timeoutMs = 30000 } = {}) {
    assistant.getState().send(text)
    const startedAt = Date.now()
    while (assistant.getState().sending) {
      if (Date.now() - startedAt > timeoutMs) {
        assistant.getState().stop()
        throw new Error(`请求超时（${timeoutMs}ms）：${text}`)
      }
      await sleep(20)
    }
    const messages = assistant.getState().messages
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant') return messages[index]
    }
    return null
  }

  function lastAssistantMessage() {
    const messages = assistant.getState().messages
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant') return messages[index]
    }
    return null
  }

  async function retryPrompt({ timeoutMs = 30000 } = {}) {
    const startedAt = Date.now()
    const promise = assistant.getState().retry()
    while (assistant.getState().sending) {
      if (Date.now() - startedAt > timeoutMs) {
        assistant.getState().stop()
        throw new Error(`重试超时（${timeoutMs}ms）`)
      }
      await sleep(20)
    }
    await promise
    return lastAssistantMessage()
  }

  /** 模拟用户点击删除 ActionCard：与 AssistantPanel 的确认逻辑共用同一个执行函数 */
  async function confirmDelete(messageId, index) {
    const message = assistant
      .getState()
      .messages.find((item) => item.id === messageId)
    const action = message?.toolActions?.[index]
    if (!action) {
      return { ok: false, reason: 'missing', message: '没有找到删除卡片' }
    }
    const result = await deleteExecMod.confirmDeleteProposal({
      proposalId: action.proposalId,
      targetId: action.targetId,
      expectedKind: action.kind,
      access: {
        findEntry: (id) => entries.getState().entries.find((entry) => entry.id === id),
        moveToTrash: (id) => {
          if (trashFailureOnce) {
            trashFailureOnce = false
            throw new Error('INJECTED_TEST_TRASH_FAILURE')
          }
          return entries.getState().moveToTrash(id)
        },
        stillExists: (id) => entries.getState().entries.some((entry) => entry.id === id),
      },
    })
    await deleteHistoryMod.recordDeleteConfirmed(action, result)
    if (result.ok) assistant.getState().markToolActionDone(messageId, index)
    return result
  }

  /** 模拟用户点击删除 ActionCard 的取消：提议作废，卡片标记已取消 */
  async function cancelDelete(messageId, index) {
    const message = assistant
      .getState()
      .messages.find((item) => item.id === messageId)
    const action = message?.toolActions?.[index]
    if (!action) {
      return { ok: false, reason: 'missing', message: '没有找到删除卡片' }
    }
    deleteExecMod.cancelDeleteProposal(action.proposalId)
    await deleteHistoryMod.recordDeleteCancelled(action)
    assistant.getState().markToolActionCancelled(messageId, index)
    return { ok: true }
  }

  function resetDeleteProposals() {
    deleteMod.resetDeleteProposals()
  }

  function setMessages(messages) {
    assistant.setState({ messages })
  }

  async function close() {
    await vite.close()
  }

  return {
    assistant,
    entries,
    repository,
    reset,
    seed,
    listEntries,
    selectEntry,
    sendPrompt,
    retryPrompt,
    selectAlarm,
    cancelSelection,
    expireSelection,
    getSelection,
    tamperSelection,
    updateEntryDirect,
    lastAssistantMessage,
    findFreeModel: freeModelsMod.findFreeModel,
    freeSourceKey: freeModelsMod.freeSourceKey,
    injectCreateFailure,
    injectCreateFailureOnce,
    clearCreateFailure,
    injectUpdateFailure,
    clearUpdateFailure,
    injectTrashFailureOnce,
    clearTrashFailure,
    resetDeleteProposals,
    confirmDelete,
    cancelDelete,
    setMessages,
    listHistory,
    getHistory,
    getHistorySteps,
    createHistoryRecord,
    upsertHistoryStep,
    deleteHistory,
    clearHistory,
    flushHistory,
    recoverHistory,
    close,
    sleep,
  }
}
