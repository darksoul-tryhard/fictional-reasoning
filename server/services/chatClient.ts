import { ModelError } from './modelError.js'

/*
 * OpenAI 兼容 chat/completions 的统一调用入口，案件解析与审讯共用同一套加固措施：
 *   - 只接受 http(s) 且不含用户名、密码、查询参数、片段的 Base URL；
 *   - 禁止重定向，避免密钥被带到其他主机；
 *   - 请求超时、响应体积上限、非流式；
 *   - 兼容常见 OpenAI 兼容服务的 finish_reason 与 Markdown JSON 包装；
 *     最终字段仍由具体业务 validate 严格校验；错误一律转成脱敏的 ModelError。
 */

export interface ChatJsonRequest {
  baseUrl: string
  apiKey: string
  model: string
  system: string
  user: string
  /** 超时毫秒数；省略或传 Infinity 表示不设客户端超时。 */
  timeoutMs?: number
  /** 响应字节上限，默认 1 MiB。 */
  maxBytes?: number
  /** 限制模型生成长度；避免一句证词意外生成成长篇内容。 */
  maxTokens?: number
  /** 上层任务的取消信号；用于停止仍在等待中的超长案件解析。 */
  signal?: AbortSignal
}

function resolveEndpoint(baseUrl: string, apiKey: string, model: string): URL {
  try {
    if (!apiKey || !model) throw new Error('incomplete configuration')
    const url = new URL(baseUrl)
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('unsupported protocol')
    if (url.username || url.password || url.search || url.hash) throw new Error('unexpected url parts')
    url.pathname = `${url.pathname.replace(/\/$/, '')}/chat/completions`
    return url
  } catch {
    throw new ModelError('LLM_NOT_CONFIGURED', '请在后端配置 LLM_API_KEY、LLM_BASE_URL 和 LLM_MODEL。', 503)
  }
}

type ChatChoice = { finish_reason?: unknown; message?: { content?: unknown }; delta?: { content?: unknown } }
type ChatEnvelope = { choices?: ChatChoice[] }

/**
 * 少数“OpenAI 兼容”网关会忽略 stream:false，仍以 SSE 返回完整内容。
 * 仅在响应体确实是 SSE 时收集 choices[0].delta.content；普通 JSON 仍走原路径。
 */
function parseSseEnvelope(body: string): ChatEnvelope | null {
  if (!/^\s*data:/mu.test(body)) return null
  const contents: string[] = []
  let last: ChatEnvelope | null = null
  for (const line of body.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const event = JSON.parse(data) as ChatEnvelope
      last = event
      const content = event.choices?.[0]?.delta?.content
      if (typeof content === 'string') contents.push(content)
    } catch {
      // 单条 SSE 损坏时不把内容回显；最终统一报告为接口响应格式问题。
      return null
    }
  }
  if (contents.length > 0) {
    return { choices: [{ finish_reason: last?.choices?.[0]?.finish_reason ?? 'stop', message: { content: contents.join('') } }] }
  }
  return last
}

function parseProviderEnvelope(bytes: Uint8Array[], contentType: string | null): ChatEnvelope {
  const body = Buffer.concat(bytes).toString('utf8').trim()
  if (!body) throw new ModelError('INVALID_MODEL_OUTPUT', '模型服务返回为空。')
  try { return JSON.parse(body) as ChatEnvelope }
  catch {
    const sse = parseSseEnvelope(body)
    if (sse) return sse
    // 这里特意不包含原始响应正文：其中可能有网关诊断、账号信息或其他敏感内容。
    const isHtml = /text\/html/i.test(contentType ?? '') || /^\s*<!doctype html|^\s*<html[\s>]/i.test(body)
    throw new ModelError(
      'MODEL_RESPONSE_NOT_JSON',
      isHtml
        ? '模型服务返回了网页而不是 API 数据，请检查 Base URL 是否指向接口地址。'
        : '模型服务返回的数据格式无效，请检查模型服务是否兼容 OpenAI chat/completions 接口。',
    )
  }
}

export async function requestChatJson(request: ChatJsonRequest, transport: typeof fetch = fetch): Promise<unknown> {
  const url = resolveEndpoint(request.baseUrl, request.apiKey, request.model)
  // 案件解析可传 Infinity：由上层负责生命周期控制，本客户端不因文本较长而主动超时。
  const timeoutSignal = request.timeoutMs === Infinity ? undefined : AbortSignal.timeout(request.timeoutMs ?? 60_000)
  const signal = request.signal && timeoutSignal
    ? AbortSignal.any([request.signal, timeoutSignal])
    : request.signal ?? timeoutSignal ?? new AbortController().signal
  const maxBytes = request.maxBytes ?? 1_048_576

  try {
    const response = await transport(url, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model, stream: false,
        ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
        messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
      }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401 || response.status === 403) {
        throw new ModelError('LLM_AUTH_FAILED', 'API Key 无效或无权访问该模型。', response.status)
      }
      if (response.status === 400 || response.status === 413 || response.status === 422) {
        throw new ModelError('LLM_CONTEXT_REJECTED', '模型服务拒绝了本次材料请求，将尝试使用更小的文本片段。', response.status)
      }
      throw new ModelError(
        response.status === 429 ? 'LLM_RATE_LIMITED' : 'LLM_REQUEST_FAILED',
        '模型服务拒绝请求，请检查配置或稍后重试。',
      )
    }
    if (!response.body) throw new ModelError('INVALID_MODEL_OUTPUT', '模型返回为空。')

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) {
          await reader.cancel()
          throw new ModelError('INVALID_MODEL_OUTPUT', '模型返回内容过大。')
        }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }

    const payload = parseProviderEnvelope(chunks, response.headers.get('content-type'))

    const result = payload
    const choice = result?.choices?.[0]
    const finishReason = choice?.finish_reason
    // OpenAI 兼容服务的 finish_reason 不完全一致：stop、null/缺失都可能表示正常完成；
    // 只有明确的 length 才能确定是输出被截断，不能把其他正常响应一律判为失败。
    if (finishReason === 'length') {
      throw new ModelError('LLM_OUTPUT_TRUNCATED', '模型输出被截断，请缩短案件文本或稍后重试。')
    }
    if (typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) {
      throw new ModelError('INVALID_MODEL_OUTPUT', '模型未返回有效内容。')
    }

    /*
     * 模型即使收到「只输出 JSON」也可能包一层 Markdown 代码围栏，或在 JSON 前后加一句说明。
     * 先提取围栏内容，再提取最外层对象；不做宽松的字段修复，最终仍由 caseParser.validate
     * 严格校验字段和类型，避免把幻觉内容悄悄当成合法案件。
     */
    const content = choice.message.content.trim()
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim()
    const candidate = fenced ?? content
    try { return JSON.parse(candidate) }
    catch {
      const start = candidate.indexOf('{')
      const end = candidate.lastIndexOf('}')
      if (start >= 0 && end > start) {
        try { return JSON.parse(candidate.slice(start, end + 1)) }
        catch { /* fall through to the safe user-facing error */ }
      }
      throw new ModelError('INVALID_MODEL_OUTPUT', '模型返回的内容不是有效 JSON，请重试。')
    }
  } catch (error) {
    if (error instanceof ModelError) throw error
    if (signal.aborted && request.signal?.aborted) throw new ModelError('LLM_CANCELLED', '案件解析已取消。', 409)
    if (signal.aborted) throw new ModelError('LLM_TIMEOUT', '模型调用超时，请稍后重试。', 504)
    throw new ModelError('LLM_REQUEST_FAILED', '模型调用失败或返回格式无效。')
  }
}
