import assert from 'node:assert/strict'
import { test } from 'node:test'
import { testModelConnection } from '../server/services/modelClient.js'

const environment = { LLM_BASE_URL: 'https://example.com/v1', LLM_API_KEY: 'test-key', LLM_MODEL: 'test-model' }

test('connection test verifies the OpenAI chat response contract, not only HTTP success', async () => {
  const result = await testModelConnection(environment, async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: '{"ready":true}' } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  assert.deepEqual(result, { ok: true, model: 'test-model' })
})

test('connection test rejects an HTTP-success HTML gateway page with an actionable error', async () => {
  const result = await testModelConnection(environment, async () => new Response('<html>gateway login</html>', {
    status: 200, headers: { 'Content-Type': 'text/html' },
  }))
  assert.deepEqual(result, {
    ok: false,
    status: 502,
    message: '模型服务返回了网页而不是 API 数据，请检查 Base URL 是否指向接口地址。',
  })
})
