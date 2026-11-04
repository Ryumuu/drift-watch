import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { HttpInit } from 'claude-code'
import type { Board } from '../types'

// 全部 IO 都在宿主测试钩子下模拟；不取本机凭据、不运行 security、不联网。
function apiHarness($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], key = 'test-api-key') {
  const clock = mock.clock(on)
  mock.env(on, key ? { DRIFT_WATCH_API_KEY: key } : {})
  const requests: { url: string; init?: HttpInit }[] = []
  const logs: string[] = []
  const hostCalls: string[] = []
  let last: Board | undefined
  const answer = JSON.stringify({ goal: '接口已解析', stage: '验证请求', total: 20, stagePct: 30 })
  let response = { status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ message: { content: answer } }] }) }
  on('http.fetch', (_$, e) => {
    requests.push(e)
    return { value: response }
  })
  on('ui.log', (_$, e) => { logs.push(e.text); return { value: undefined } })
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => { throw new Error('ENOENT') })
  on('process.run', () => { throw new Error('test must not read keychain') })
  on('command.register', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('model.complete', (_$, e) => {
    hostCalls.push(e.model ?? '')
    return { value: { isAnswered: true, text: answer } } as never
  })
  on('state.set', { plugin: 'drift-watch', key: 'board' }, async (_$, e, next) => {
    const r = await next(e)
    if ('value' in r && r.value.isSet) last = e.value
    return r
  })
  return {
    requests, logs, hostCalls,
    board: () => last,
    reply: (value: typeof response) => { response = value },
    async run() {
      await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
      await $.command.run({ command: 'drift', args: 'new 修复接口 token=private-test-secret', origin: { kind: 'composer' } } as never)
      await clock.advance(4000)
    },
    async again() {
      await $.command.run({ command: 'drift', args: 'new 下一个任务', origin: { kind: 'composer' } } as never)
      await clock.advance(4000)
    },
  }
}

const openai = { apiFormat: 'openai', apiBaseUrl: 'https://api.example.com/v1///', apiModel: 'test-chat' }

test('OpenAI 兼容请求的 URL/头/body 正确，摘要已脱敏，回答用于进度', { options: openai }, async ($, on) => {
  const h = apiHarness($, on)
  await h.run()
  expect(h.requests.length).toBe(1)
  const req = h.requests[0]!
  expect(req.url).toBe('https://api.example.com/v1/chat/completions')
  expect(req.init?.method).toBe('POST')
  expect(req.init?.headers).toEqual({ 'content-type': 'application/json', Authorization: 'Bearer test-api-key' })
  const body = JSON.parse(req.init?.body ?? '{}')
  expect(body).toEqual({ model: 'test-chat', max_tokens: 200, messages: [{ role: 'user', content: expect.any(String) }] })
  expect(body.messages[0].content).toContain('[已隐藏]')
  expect(body.messages[0].content).not.toContain('private-test-secret')
  expect(h.board()?.est?.goal).toBe('接口已解析')
  expect(h.hostCalls.length).toBe(0)
})

for (const host of ['localhost', '127.0.0.1', '[::1]']) {
  test(`本地 HTTP ${host} 可不带密钥`, { options: { ...openai, apiBaseUrl: `http://${host}:11434/v1/` } }, async ($, on) => {
    const h = apiHarness($, on, '')
    await h.run()
    expect(h.requests.length).toBe(1)
    expect(h.requests[0]?.url).toBe(`http://${host}:11434/v1/chat/completions`)
    expect(h.requests[0]?.init?.headers).toEqual({ 'content-type': 'application/json' })
    expect(h.hostCalls.length).toBe(0)
  })
}

for (const missing of ['apiBaseUrl', 'apiModel']) {
  test(`OpenAI 缺 ${missing} 直接退回宿主`, { options: { ...openai, [missing]: '' } }, async ($, on) => {
    const h = apiHarness($, on)
    await h.run()
    expect(h.requests.length).toBe(0)
    expect(h.hostCalls).toEqual(['haiku'])
    expect(h.logs).toContain('API category=invalid-config')
  })
}

for (const apiBaseUrl of ['http://api.example.com/v1', 'http://localhost.example.com/v1', 'not-a-url', 'file:///tmp/api', 'https:api.example.com/v1', 'https://user:pass@api.example.com/v1', 'https://api.example.com/v1?token=private', 'https://api.example.com/v1#']) {
  test(`拒绝不安全或非基础地址 ${apiBaseUrl}`, { options: { ...openai, apiBaseUrl } }, async ($, on) => {
    const h = apiHarness($, on)
    await h.run()
    expect(h.requests.length).toBe(0)
    expect(h.hostCalls).toEqual(['haiku'])
    expect(h.logs).toContain('API category=invalid-url')
    expect(h.logs.join('\n')).not.toContain(apiBaseUrl)
  })
}

test('默认有密钥仍直连 Anthropic，原模型映射/头/thinking 保持', async ($, on) => {
  const h = apiHarness($, on)
  h.reply({ status: 200, ok: true, headers: {}, text: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ goal: '原通道', stage: '检查', total: 10, stagePct: 20 }) }] }) })
  await h.run()
  expect(h.requests[0]?.url).toBe('https://api.anthropic.com/v1/messages')
  expect(h.requests[0]?.init?.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': 'test-api-key', 'anthropic-version': '2023-06-01' })
  const body = JSON.parse(h.requests[0]?.init?.body ?? '{}')
  expect(body.model).toBe('claude-haiku-5-5')
  expect(body.thinking).toEqual({ type: 'disabled' })
  expect(h.board()?.est?.goal).toBe('原通道')
  expect(h.hostCalls.length).toBe(0)
})

test('默认无密钥仍只走宿主', async ($, on) => {
  const h = apiHarness($, on, '')
  await h.run()
  expect(h.requests.length).toBe(0)
  expect(h.hostCalls).toEqual(['haiku'])
})

test('Anthropic 兼容地址和模型覆盖生效', { options: { apiBaseUrl: 'https://api.example.com/v1/', apiModel: 'custom-claude' } }, async ($, on) => {
  const h = apiHarness($, on)
  await h.run()
  expect(h.requests[0]?.url).toBe('https://api.example.com/v1/messages')
  expect(JSON.parse(h.requests[0]?.init?.body ?? '{}').model).toBe('custom-claude')
})

for (const status of [401, 403]) {
  test(`${status} 后本会话不再直连（含无密钥 OpenAI）`, { options: openai }, async ($, on) => {
    const h = apiHarness($, on, '')
    h.reply({ status, ok: false, headers: {}, text: 'private-response-secret' })
    await h.run()
    await h.again()
    expect(h.requests.length).toBe(1)
    expect(h.hostCalls).toEqual(['haiku', 'haiku'])
    expect(h.logs.join('\n')).not.toContain('private-response-secret')
  })
}

test('OpenAI 失败/空回答退回宿主，debug 不含原文', { options: openai }, async ($, on) => {
  const h = apiHarness($, on)
  h.reply({ status: 503, ok: false, headers: {}, text: 'private-response-secret' })
  await h.run()
  h.reply({ status: 200, ok: true, headers: {}, text: '{private-invalid-json' })
  await h.again()
  h.reply({ status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ message: { content: null } }] }) })
  await h.again()
  expect(h.hostCalls).toEqual(['haiku', 'haiku', 'haiku'])
  expect(h.logs).toContain('API status=503 category=http-error')
  expect(h.logs).toContain('API status=200 category=invalid-response')
  expect(h.logs).toContain('API status=200 category=empty-response')
  expect(h.logs.join('\n')).not.toContain('private-')
})

test('off 即使填了自定义接口也不发模型请求', { options: { ...openai, judgeModel: 'off' } }, async ($, on) => {
  const h = apiHarness($, on)
  let classified = 0
  on('model.classify', () => { classified++; return { value: 'off-track' } })
  on('tool.call', () => ({ result: {}, isError: true, text: 'Error: boom' }) as never)
  on('ui.notify', () => ({ value: { isSent: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.abort', () => ({ value: undefined }))
  await h.run()
  for (let i = 0; i < 4; i++) await $.tool.call({ tool: 'Bash', command: 'test-command' } as never)
  expect(h.requests.length).toBe(0)
  expect(h.hostCalls.length).toBe(0)
  expect(classified).toBe(0)
})

test('偏航分类也走 OpenAI 兼容接口并脱敏，不走宿主 classify', { options: openai }, async ($, on) => {
  const h = apiHarness($, on)
  h.reply({ status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ message: { content: 'on-track' } }] }) })
  let classified = 0
  on('model.classify', () => { classified++; return { value: 'off-track' } })
  on('tool.call', () => ({ result: {}, isError: true, text: 'Error: token=private-error-secret' }) as never)
  on('ui.notify', () => ({ value: { isSent: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.abort', () => ({ value: undefined }))
  // 不启动后台计时器，单独触发分类请求。
  await $.command.run({ command: 'drift', args: 'new 修好接口 token=private-goal-secret', origin: { kind: 'composer' } } as never)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'test-command' } as never)
  expect(h.requests.length).toBeGreaterThan(0)
  const body = JSON.parse(h.requests[0]?.init?.body ?? '{}')
  expect(body.max_tokens).toBe(20)
  expect(body.messages[0].content).not.toContain('private-goal-secret')
  expect(body.messages[0].content).not.toContain('private-error-secret')
  expect(body.messages[0].content).toContain('[已隐藏]')
  expect(h.board()?.judge?.verdict).toBe('贴合')
  expect(classified).toBe(0)
})
