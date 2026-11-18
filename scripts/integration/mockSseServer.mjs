import { createServer } from 'node:http'

/**
 * 本地 OpenAI 兼容 SSE mock：只实现 /chat/completions 流式响应，
 * 用于在无真实密钥的情况下驱动完整 agent loop。
 *
 * 脚本每一步可以是：
 * - { calls: [{ id, name, arguments }] }：返回 tool_calls；
 * - { content: string }：返回普通文本；
 * - (requestBody) => step：根据历史消息动态构造（用于跨轮次依赖真实 id）；
 * - { delayMs, content }：延迟响应（用于测试停止）。
 */

function frame(delta, finishReason = null) {
  return { choices: [{ index: 0, delta, finish_reason: finishReason }] }
}

function write(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function finish(res) {
  res.write('data: [DONE]\n\n')
  res.end()
}

function streamText(res, text) {
  const pieces = text.match(/[\s\S]{1,12}/g) ?? ['']
  for (const piece of pieces) write(res, frame({ content: piece }))
  write(res, frame({}, 'stop'))
  finish(res)
}

function streamToolCalls(res, calls) {
  calls.forEach((call, index) => {
    write(
      res,
      frame({
        tool_calls: [
          {
            index,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: '' },
          },
        ],
      }),
    )
    // 参数分两段下发，覆盖增量拼接逻辑
    const raw = JSON.stringify(call.arguments ?? {})
    const middle = Math.floor(raw.length / 2)
    for (const part of [raw.slice(0, middle), raw.slice(middle)]) {
      if (!part) continue
      write(
        res,
        frame({
          tool_calls: [{ index, function: { arguments: part } }],
        }),
      )
    }
  })
  write(res, frame({}, 'tool_calls'))
  finish(res)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function startMockSseServer(script) {
  const requests = []
  let cursor = 0

  const server = createServer((req, res) => {
    // 浏览器直连需要预检；集成测试走 Node fetch 不会触发
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, authorization',
        'Access-Control-Max-Age': '600',
      })
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch {
        // 忽略无法解析的请求体
      }
      requests.push(parsed)
      void (async () => {
        let step = script[cursor]
        cursor += 1
        if (typeof step === 'function') step = await step(parsed)
        if (!step) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          })
          streamText(res, '（mock 脚本已用尽）')
          return
        }
        // 模拟网关错误：用于验证失败重试时的重复写入保护
        if (step.status && step.status >= 400) {
          res.writeHead(step.status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          })
          res.end(JSON.stringify({ error: { message: step.error ?? 'mock error' } }))
          return
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        })
        if (step.delayMs) await sleep(step.delayMs)
        // 先输出一段内容再中断连接：用于验证「已有输出后失败」不会被误判为不支持工具
        if (step.streamErrorAfter) {
          write(res, frame({ content: step.streamErrorAfter }))
          setImmediate(() => res.socket?.destroy())
          return
        }
        if (step.calls) streamToolCalls(res, step.calls)
        else streamText(res, step.content ?? '')
      })().catch(() => {
        try {
          res.end()
        } catch {
          // 连接已被客户端中断
        }
      })
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/** 从请求体的最后一条 tool 消息里提取真实 id（模拟模型跨轮次使用工具结果） */
export function lastToolResult(body) {
  const messages = body?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'tool') return String(message.content ?? '')
  }
  return ''
}

export function extractId(text) {
  const match = /id: ([A-Za-z0-9-]+)/.exec(text)
  return match ? match[1] : null
}
