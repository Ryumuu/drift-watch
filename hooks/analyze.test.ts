import { expect, test } from 'claude-code/testing'

import { applyPlan, brief, emptyBoard, escalate, makeStep, parseEstimate, recordStep } from './analyze'
import type { Board } from '../types'

const fail = (b: Board, cmd: string) =>
  escalate(recordStep(b, makeStep(b.stepCount + 1, 'Bash', { command: cmd }, true, `Error: ENOENT /tmp/a${b.stepCount}.txt line 42`)))

test('同一命令同一报错：第 3 次提醒，提醒后再出现算再犯', () => {
  let b = applyPlan(emptyBoard(1, '修好登录 bug'), [{ id: 'a', text: '复现问题', status: 'in_progress' }])
  let out = fail(b, 'npm test')
  out = fail(out.board, 'npm test')
  expect(out.action).toBe(null)
  out = fail(out.board, 'npm test')
  expect(out.action?.type).toBe('warn')
  expect(out.board.score).toBeGreaterThanOrEqual(40)
  out = fail(out.board, 'npm test')
  expect(out.action?.type).toBe('repeat')
  expect(out.board.stats.repeated).toBe(1)
})

test('提醒后改了计划就算回到主线，不再算再犯', () => {
  let out = fail(emptyBoard(1, '修好登录 bug'), 'npm test')
  out = fail(out.board, 'npm test')
  out = fail(out.board, 'npm test')
  expect(out.action?.type).toBe('warn')
  const b = applyPlan(out.board, [{ id: 'x', text: '换个思路：先读日志', status: 'in_progress' }])
  expect(b.warning).toBe(null)
  expect(b.stats.recovered).toBe(1)
  expect(b.score).toBeLessThan(40)
})

test('步骤不同、都成功：指数保持正常', () => {
  let b = applyPlan(emptyBoard(1, '写个脚本'), [{ id: 'a', text: '读代码', status: 'in_progress' }])
  for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) b = recordStep(b, makeStep(b.stepCount + 1, 'Read', { file_path: '/x/' + f }, false, f))
  expect(b.score).toBe(0)
})

test('计划当前步骤很久没推进：出现卡住信号', () => {
  let b = applyPlan(emptyBoard(1, '写个脚本'), [{ id: 'a', text: '读代码', status: 'in_progress' }])
  for (let i = 0; i < 9; i++) b = recordStep(b, makeStep(b.stepCount + 1, 'Grep', { pattern: 'p' + i }, false, 'r' + i))
  expect(b.signals.some(s => s.kind === 'stall')).toBe(true)
})

test('小条四个数：模型结果能读出来，读不出时按待办清单兜底', () => {
  const b = { ...emptyBoard(1, '修好登录页点了没反应的 bug'), plan: [
    { id: 'a', text: '找到点击处理函数', status: 'completed' as const },
    { id: 'b', text: '本地复现', status: 'in_progress' as const },
    { id: 'c', text: '修复并验证', status: 'pending' as const },
    { id: 'd', text: '手机端回归', status: 'pending' as const },
  ] }
  expect(brief(b)).toEqual({ goal: '修好登录页点了没反应的 bug', stage: '本地复现', total: 25, stagePct: null, byModel: false })
  const est = parseEstimate('好的 {"goal":"修好登录页无响应","stage":"本地复现问题","total":38.4,"stage_pct":120}', b)
  expect(est?.total).toBe(38)
  expect(est?.stagePct).toBe(100)
  expect(brief({ ...b, est }).goal).toBe('修好登录页无响应')
  expect(parseEstimate('不知道', b)).toBeNull()
})
