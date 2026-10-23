import { expect, test } from 'claude-code/testing'

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
