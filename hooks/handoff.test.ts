import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Eng = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]
import type { Board } from '../types'
import { angleText, emptyBoard, estimateText, judgeText, makeStep, redact } from './analyze'
import { CORRECTION_HEAD, PACK_MARK, addFile, buildLog, buildPack, isPack, keepCorrection, logPathFor, packLogPath, parseStarted, parseState, slug, touchedFile } from './handoff'

const NOW = new Date(2026, 9, 18, 22, 30).getTime()

function sample(): Board {
  const b = emptyBoard(1, '搭一个 Action Button 语音记笔记的快捷指令')
  return {
    ...b,
    extras: ['别用 webhook 直连，走备用通道'],
    goals: [{ v: 1, text: '语音记笔记', why: '', step: 0 }, { v: 2, text: '语音记笔记并走备用通道', why: '用户补充了走备用通道', step: 6 }],
    est: { goal: '语音记笔记', stage: '重建快捷指令', total: 40, stagePct: 20, step: 8, key: 'k' },
    plan: [
      { id: 'a', text: '读现有快捷指令', status: 'completed' },
      { id: 'b', text: '用脚本重建快捷指令', status: 'in_progress' },
      { id: 'c', text: '真机验证', status: 'pending' },
    ],
    files: ['/home/me/proj/build_shortcut.py'],
    steps: [
      { n: 5, tool: 'Edit', label: '改 build_shortcut.py', fp: 'x', isError: false, errSig: '', errText: '', resSig: 'O1', tags: ['推进'], file: '/home/me/proj/build_shortcut.py' },
      { n: 6, tool: 'Bash', label: '运行 shortcuts sign', fp: 'y', isError: true, errSig: 'e', errText: 'Error: could not sign', resSig: 'E1', tags: ['报错', '重复'], deg: 52, why: '一直在签名上重试' },
      { n: 7, tool: 'Bash', label: '运行 shortcuts sign', fp: 'y', isError: true, errSig: 'e', errText: 'Error: could not sign', resSig: 'E1', tags: ['报错', '重复'] },
    ],
    stepCount: 7,
    lastProgress: 5,
    signals: [{ key: 'same:y', kind: 'same', points: 40, hits: 3, text: '同一个命令连续 3 次：运行 shortcuts sign' }],
    pause: { key: 'same:y', text: '同一个命令连续 3 次：运行 shortcuts sign', step: 7 },
    drifts: [{ step: 7, level: 'pause', text: '同一个命令连续 3 次', t: NOW, outcome: '' }],
  }
}

test('航行日志：各节齐全，纠偏记录保留，状态块能读回', () => {
  const b = sample()
  const path = logPathFor(b.goal, NOW, '/tmp/航行日志')
  expect(path).toBe('/tmp/航行日志/2026-10-18_搭一个ActionButton语.md')
  const log = buildLog(b, { logPath: path, now: NOW })
  for (const must of ['最初的目标', b.goal, '别用 webhook 直连', 'v2', '重建快捷指令', '用脚本重建快捷指令', '/home/me/proj/build_shortcut.py', '第 5 步', 'Error: could not sign', CORRECTION_HEAD]) expect(log).toContain(must)
  const st = parseState(log)
  expect(st?.goal).toBe(b.goal)
  expect(st?.key).toBe('same:y')
  expect(st?.plan.length).toBe(3)
  // 接手会话追加分析后，插件再刷新也不丢
  const withAnalysis = log.replace(CORRECTION_HEAD, `${CORRECTION_HEAD}\n\n### 分析\n目的：…\n哪里走错了：…`)
  const again = buildLog({ ...b, stepCount: 8 }, { logPath: path, now: NOW, kept: keepCorrection(withAnalysis) })
  expect(again).toContain('哪里走错了：…')
  expect(again.indexOf('哪里走错了')).toBeLessThan(again.indexOf('drift-watch:state'))
  expect(parseState(again)?.stepCount).toBe(8)
})

test('交接包：固定模板，认得出、取得到日志路径', () => {
  const b = sample()
  const pack = buildPack(b, '/tmp/x.md', 'nested')
  expect(isPack(pack)).toBe(true)
  expect(pack.startsWith(PACK_MARK)).toBe(true)
  expect(packLogPath(pack)).toBe('/tmp/x.md')
  for (const must of ['任务目标：搭一个 Action Button', '用脚本重建快捷指令', 'Error: could not sign', '纠偏记录', '不要再开嵌套会话']) expect(pack).toContain(must)
  expect(isPack('修一下登录 bug')).toBe(false)
})

test('零碎：文件提取、会话号解析、文件名', () => {
  expect(touchedFile('Edit', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
  expect(touchedFile('Write', { file_path: '/a/c.ts' })).toBe('/a/c.ts')
  expect(touchedFile('Bash', { command: 'ls' })).toBeUndefined()
  expect(addFile(['/a'], '/a')).toEqual(['/a'])
  expect(addFile(['/a'], '/b')).toEqual(['/a', '/b'])
  expect(parseStarted('Started session "纠偏：x" (session_id: abc-123, name: fix-drift-1)')).toEqual({ sessionId: 'abc-123', name: 'fix-drift-1' })
  expect(slug('a/b:c "d"?')).toBe('abcd')
})

// ---------- 走真入口 ----------
type Ctx = { written: Map<string, string>; calls: { tool: string; args: Record<string, unknown> }[]; submitted: string[]; notified: string[]; compact: string[] }

async function toPause(
  $: Eng,
  on: On,
  goal: string,
  mcp: (tool: string) => { isError: boolean; text: string } | 'throw',
  disk?: Map<string, string>,
): Promise<Ctx> {
  const ctx: Ctx = { written: disk ?? new Map(), calls: [], submitted: [], notified: [], compact: [] }
  let n = 0
  // 第一次改文件成功，后面一直报同一个错
  on('tool.call', () => (n++ === 0 ? { result: 'ok', text: 'ok' } : { result: { stdout: '', stderr: 'boom', interrupted: false }, isError: true, text: 'Error: boom at line 3' }) as never)
  on('session.compact', (_$, e) => {
    ctx.compact.push(e.instructions ?? '')
    return { messages: [{ role: 'user', text: '摘要', toolUses: [], toolResults: [] }] } as never
  })
  on('prompt.submit', ($, e) => {
    ctx.submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.abort', () => ({ value: undefined }) as never)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }) as never)
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('turn.start', () => ({ turnId: 't1' }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.notify', (_$, e) => {
    ctx.notified.push(JSON.stringify(e))
    return { value: { isSent: true } } as never
  })
  on('model.classify', () => ({ value: 'side-quest' }) as never)
  on('fs.write', (_$, e) => {
    ctx.written.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('fs.read', (_$, e) => {
    const t = ctx.written.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t } as never
  })
  on('mcp.call', (_$, e) => {
    ctx.calls.push({ tool: `${e.server}.${e.tool}`, args: e.args })
    const r = mcp(e.tool)
    if (r === 'throw') throw new Error('no such server')
    return { value: { content: [{ type: 'text', text: r.text }], isError: r.isError } } as never
  })
  await $.command.run({ command: 'drift', args: `new ${goal}`, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'x', turnId: 't1' } as never)
  const call = () => $.tool.call({ tool: 'Edit', file_path: '/proj/a.ts', old_string: 'a', new_string: 'b' } as never)
  for (let i = 0; i < 5; i++) await call()
  return ctx
}

const press = async ($: Eng, key: string) => {
  const band = await $.ui.mount({ plugin: 'drift-watch', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100 } as never })
  await band.press({ key } as never)
}

test('点「让它换个思路」：start_session 成功 → 分屏打开，原会话不再发话，日志写好', async ($, on) => {
  const ctx = await toPause($, on, '修好登录流程A', t => (t === 'start_session' ? { isError: false, text: 'Started session "纠偏" (session_id: sid-1, name: fix-1)' } : { isError: false, text: 'ok' }))
  const logPath = [...ctx.written.keys()].find(k => k.includes('航行日志') && k.endsWith('.md'))
  expect(logPath).toBeDefined()
  expect(ctx.written.get(logPath!)).toContain('/proj/a.ts')
  const submittedBefore = ctx.submitted.length
  await press($, 'pull')
  const start = ctx.calls.find(c => c.tool === 'ccd_session.start_session')
  expect(start?.args.context).toBe('fresh')
  expect(String(start?.args.prompt)).toContain(PACK_MARK)
  expect(String(start?.args.prompt)).toContain('修好登录流程A')
  expect(String(start?.args.prompt).length).toBeGreaterThan(0)
  expect(String(start?.args.background).length).toBeGreaterThanOrEqual(80)
  expect(ctx.calls.find(c => c.tool === 'ccd_window.open_session_in')?.args).toEqual({ session_id: 'sid-1', target: 'split' })
  expect(ctx.submitted.length).toBe(submittedBefore) // 原会话没有再发话
  const pane = await $.ui.mount({ plugin: 'drift-watch', surface: 'terminal', component: 'Pane', requestId: 'drift-watch', props: { title: '偏航观测', isFocused: false, bodyColumns: 60 } as never })
  await pane.press({ key: 'drift' } as never)
  expect(await pane.find({ text: /已交接给 fix-1/ })).toBeDefined()
})

test('start_session 开不了 → 退到卡片；卡片也不行 → 退回原会话', async ($, on) => {
  const ctx = await toPause($, on, '修好登录流程B', t => (t === 'start_session' ? { isError: true, text: 'Starting sessions is not enabled here.' } : t === 'spawn_task' ? { isError: false, text: 'queued' } : { isError: false, text: 'ok' }))
  await press($, 'pull')
  expect(ctx.calls.map(c => c.tool)).toEqual(['ccd_session.start_session', 'ccd_session.spawn_task'])
  expect(ctx.submitted.every(t => !t.includes('任务目标'))).toBe(true)
})

test('两条都不行 → 在原会话里换思路，提示里带日志路径', async ($, on) => {
  const ctx = await toPause($, on, '修好登录流程C', () => 'throw')
  await press($, 'pull')
  expect(ctx.calls.map(c => c.tool)).toEqual(['ccd_session.start_session', 'ccd_session.spawn_task'])
  const last = ctx.submitted.at(-1) ?? ''
  expect(last).toContain('任务目标：修好登录流程C')
  expect(last).toContain('航行日志：')
})

test('接手会话：第一句是交接包 → 原目标/日志接上，不把交接包当新目标；又在同一处打转 → 暂停且不再交接', async ($, on) => {
  // 先造一份原会话写出的日志
  const disk = new Map<string, string>()
  const first = await toPause($, on, '修好登录流程D', () => ({ isError: false, text: 'ok' }), disk)
  const logPath = [...first.written.keys()].find(k => k.endsWith('.md'))!
  const pack = buildPack({ ...emptyBoard(1, '修好登录流程D'), files: ['/proj/a.ts'] }, logPath, 'nested')
  // 另一个会话：同样的磁盘，第一句是交接包
  await $.command.run({ command: 'drift', args: 'new', origin: { kind: 'composer' } } as never)
  await $.prompt.submit({ text: pack, origin: { kind: 'sdk' } } as never)
  const composed = (await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] })) as { sections: readonly { id: string; text: string }[] }
  const goal = composed.sections.find(x => x.id === 'drift-watch:goal')?.text ?? ''
  expect(goal).toContain('修好登录流程D')
  expect(goal).not.toContain(PACK_MARK)
  expect(goal).toContain(logPath)
  // 接手会话又在同一处打转：暂停 + 通知，且「换个思路」不再开第三个会话
  const call = () => $.tool.call({ tool: 'Edit', file_path: '/proj/a.ts', old_string: 'a', new_string: 'b' } as never)
  const before = first.calls.length
  for (let i = 0; i < 5; i++) await call()
  expect(first.notified.join('\n')).toContain('接手的新会话也在同一处打转')
  await press($, 'pull')
  expect(first.calls.length).toBe(before)
})

test('压缩：指令里带最初目标和日志路径；压缩后的下一次拼提示带“先读日志”', async ($, on) => {
  const ctx = await toPause($, on, '修好登录流程E', () => ({ isError: false, text: 'ok' }))
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [], toolResults: [] }] } as never)
  const seen = ctx.compact.at(-1) ?? ''
  expect(seen).toContain('修好登录流程E')
  expect(seen).toContain('航行日志')
  const composed = (await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] })) as { sections: readonly { id: string; text: string }[] }
  expect(composed.sections.find(x => x.id === 'drift-watch:compact')?.text ?? '').toContain('先读航行日志')
})

test('redact：常见凭据在标签、模型提示、日志正文/状态块和交接包中统一隐藏', () => {
  const secrets = ['sk-ant-demo123', 'sk-demo456', 'ghp_demo789', 'gho_demo012', 'github_pat_demo345', 'bearerSecret', 'headerSecret', 'authSecret', 'pass Secret', 'tokenSecret']
  const text = `${secrets.slice(0, 5).join(' ')} Bearer ${secrets[5]} x-api-key: ${secrets[6]} Authorization="${secrets[7]}" password='${secrets[8]}' token=${secrets[9]}`
  const cleaned = redact(text)
  expect(cleaned).toContain('[已隐藏]')
  expect(redact(cleaned)).toBe(cleaned)
  expect(redact('npm test 普通任务')).toBe('npm test 普通任务')
  const step = makeStep(1, 'Bash', { command: text }, true, text)
  const b = { ...emptyBoard(1, text), extras: [text], plan: [{ id: 'a', text, status: 'in_progress' as const }], steps: [step], stepCount: 1 }
  const before = JSON.stringify(b)
  const log = buildLog(b, { logPath: '/tmp/example.md', now: NOW, kept: text })
  for (const output of [cleaned, step.label, step.errText, judgeText(b), estimateText(b), angleText(b), log, buildPack(b, '/tmp/example.md', 'nested')]) {
    for (const secret of secrets) expect(output).not.toContain(secret)
  }
  expect(parseState(log)?.goal).toBe(cleaned)
  expect(parseState(log)?.extras).toEqual([cleaned])
  expect(parseState(log)?.plan[0]?.text).toBe(cleaned)
  expect(JSON.stringify(b)).toBe(before)
})
