import { expect, mock, test } from 'claude-code/testing'
import type { Board } from '../types'

test('清空 → 后台恢复 → 新消息成为目标而非补充；启动丢目标仍可恢复', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, {}) // 不读取本机凭据或写真实日志
  on('fs.write', () => ({ value: undefined }) as never)
  on('fs.read', () => { throw new Error('ENOENT') })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'api-error', status: 503 } }) as never)
  let turns = 3
  let scans = 0
  on('session.turns', () => ({ value: turns }))
  on('session.messages', () => {
    scans++
    return { value: [{ role: 'user', text: '旧任务', toolUses: [], toolResults: [] }] } as never
  })
  let last: Board | undefined
  on('state.set', { plugin: 'drift-watch', key: 'board' }, async (_$, e, next) => {
    const r = await next(e)
    if ('value' in r && r.value.isSet) last = e.value
    return r
  })
  await $.session.start({ cwd: '/proj', surface: null, isInteractive: false })
  await clock.advance(4000) // 启动时丢目标仍可从旧消息恢复
  expect(last?.goal).toBe('旧任务')
  expect(scans).toBe(1)
  turns++ // 避免模块级扫描缓存刚好掩盖清空问题
  await $.command.run({ command: 'drift', args: 'new', origin: { kind: 'composer' } } as never)
  await clock.advance(4000) // 真正触发 session.start 注册的后台定时器
  expect(last?.goal).toBe('')
  turns++ // 回合数变化也不能把主动清空误当成丢目标
  await clock.advance(4000)
  expect(last?.goal).toBe('')
  expect(scans).toBe(1)
  await $.prompt.submit({ text: '新任务', origin: { kind: 'composer' } } as never)
  expect(last?.goal).toBe('新任务')
  expect(last?.extras).toEqual([])

  // 面板上的同义清空也应等待下一句
  const pane = await $.ui.mount({ plugin: 'drift-watch', surface: 'terminal', component: 'Pane', requestId: 'drift-watch', props: { title: '偏航观测', isFocused: false, bodyColumns: 60 } as never })
  await pane.press({ key: 'ops' } as never)
  await pane.press({ key: 'new' } as never)
  turns++
  await clock.advance(4000)
  expect(last?.goal).toBe('')
  expect(scans).toBe(1)
  await $.prompt.submit({ text: '面板清空后的任务', origin: { kind: 'composer' } } as never)
  expect(last?.goal).toBe('面板清空后的任务')
  expect(last?.extras).toEqual([])
})

// 走真入口：工具调用穿过插件，第 3 次同样失败时 Claude 收到提醒，第 4 次暂停，横条和面板能画出来
test('重复失败 → 提醒 Claude → 再犯暂停 → 横条和面板显示', async ($, on) => {
  const submitted: string[] = []
  let aborted = 0
  on('tool.call', () => ({ result: { stdout: '', stderr: 'boom', interrupted: false }, isError: true, text: 'Error: boom at line 3' }) as never)
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.abort', () => {
    aborted++
    return { value: undefined } as never
  })

  on('fs.write', () => ({ value: undefined }) as never) // 航行日志不要真写到桌面
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }) as never)
  let judged = 0
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never) // 下面没有别的插件画这一栏：引擎给一个空框
  on('turn.start', () => ({ turnId: 't1' }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.notify', () => ({ value: { isSent: true } }) as never)
  on('model.classify', () => {
    judged++
    return { value: 'side-quest' } as never
  })

  await $.command.run({ command: 'drift', args: 'new 修好登录 bug', origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'x', turnId: 't1' } as never)

  const call = () => $.tool.call({ tool: 'Bash', command: 'npm test', description: '跑测试' } as never)
  await call()
  await call()
  const third = (await call()) as { context?: readonly string[] }
  expect(third.context?.join('\n') ?? '').toContain('【偏航观测】')
  const fourth = (await call()) as { context?: readonly string[] }
  expect(fourth.context?.join('\n') ?? '').toContain('再次提醒')
  expect(aborted).toBe(1)
  expect(judged).toBeGreaterThan(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({
      plugin: 'drift-watch',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100 } as never,
    })
    if (surface === 'terminal') expect(await band.find({ text: /已暂停/ })).toBeDefined()
    // 桌面版暂停时两个彩色按钮画在小条图里，上面各盖一个可点的按钮，整棵树要能通过桌面版校验
    else {
      expect(await band.find({ type: 'Button', key: 'pull' })).toBeDefined()
      expect(await band.find({ type: 'Button', key: 'go' })).toBeDefined()
    }
    const pane = await $.ui.mount({
      plugin: 'drift-watch',
      surface,
      component: 'Pane',
      requestId: 'drift-watch',
      props: { title: '偏航观测', isFocused: false, bodyColumns: 60 } as never,
    })
    expect(await pane.find({ text: /让它换个思路/ })).toBeDefined()
    if (surface === 'terminal') {
      expect(await pane.find({ text: /已暂停/ })).toBeDefined()
      expect(await pane.find({ text: /修好登录 bug/ })).toBeDefined()
      expect(await pane.find({ text: /跑偏记录 2 次/ })).toBeDefined()
    }
    // 三个折叠区都能展开画出来
    for (const k of ['deg', 'drift', 'ops']) await pane.press({ key: k } as never)
    await pane.press({ key: 'drift' } as never)
    expect(await pane.find({ text: /你选了换思路|暂停/ })).toBeDefined()
  }

  const band = await $.ui.mount({
    plugin: 'drift-watch',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100 } as never,
  })
  await band.press({ key: 'pull' } as never)

  // 目标常驻：系统提示末尾带着最初的目标
  const composed = (await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] })) as { sections: readonly { id: string; text: string }[] }
  const goal = composed.sections.find(x => x.id === 'drift-watch:goal')
  expect(goal?.text ?? '').toContain('修好登录 bug')
  expect(submitted.at(-1) ?? '').toContain('任务目标：修好登录 bug')
})
