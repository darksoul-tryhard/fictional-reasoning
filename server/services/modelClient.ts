import { requestChatJson } from './chatClient.js'
import { ModelError } from './modelError.js'

export type ModelConnectionResult = { ok: true; model: string } | { ok: false; status: number; message: string }

function getBaseUrl(environment: NodeJS.ProcessEnv) {
  const key = environment.LLM_API_KEY?.trim()
  const base = environment.LLM_BASE_URL?.trim()
  if (!key || !base) return null
  try {
    const url = new URL(base)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    return { key, url }
  } catch { return null }
}

export async function listModels(environment: NodeJS.ProcessEnv, transport: typeof fetch = fetch) {
  const config = getBaseUrl(environment)
  if (!config) return { ok: false as const, status: 400, message: 'API Key 或 Base URL 无效。' }
  const url = new URL(config.url)
  url.pathname = `${url.pathname.replace(/\/$/, '')}/models`
  try {
    const response = await transport(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${config.key}` } })
    const body = await response.json() as { data?: Array<{ id?: unknown }> }
    if (!response.ok) return { ok: false as const, status: response.status, message: response.status === 401 || response.status === 403 ? 'API Key 无效或无权访问。' : `模型服务返回 HTTP ${response.status}。` }
    return { ok: true as const, models: (body.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string' && id.length > 0) }
  } catch { return { ok: false as const, status: 502, message: '无法读取模型列表，请检查网络和 Base URL。' } }
}

export async function testModelConnection(environment: NodeJS.ProcessEnv = process.env, transport: typeof fetch = fetch): Promise<ModelConnectionResult> {
  const config = getBaseUrl(environment)
  if (!config) return { ok: false, status: 400, message: 'API Key 或 Base URL 无效。' }
  const model = environment.LLM_MODEL?.trim()
  if (!model) {
    // 未填写模型名时只验证服务可访问，并回传服务端给出的第一个模型名供前端自动选中。
    const result = await listModels(environment, transport)
    return result.ok ? { ok: true, model: result.models[0] ?? '' } : result
  }
  try {
    const payload = await requestChatJson({
      baseUrl: config.url.toString(), apiKey: config.key, model,
      system: '只输出一个 JSON 对象：{"ready":true}。不要输出其他内容。',
      user: '验证接口响应格式。', timeoutMs: 15_000, maxTokens: 32,
    }, transport)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (payload as { ready?: unknown }).ready !== true) {
      return { ok: false, status: 502, message: '模型服务未返回预期的 JSON 验证结果，请检查模型或接口兼容性。' }
    }
    return { ok: true, model }
  } catch (error) {
    if (error instanceof ModelError) return { ok: false, status: error.status, message: error.message }
    return { ok: false, status: 502, message: '无法连接模型服务，请检查网络和 Base URL。' }
  }
}
