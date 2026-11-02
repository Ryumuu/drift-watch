import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Handoff, PlanItem, PlanStatus } from '../types'
import {
  redact,
  redactBoard,
  PLAN_TOOLS,
  VERDICTS,
  applyPlan,
  brief,
  estimateText,
  tooLong,
  fitEst,
  shortenText,
  parseEstimate,
  shouldEstimate,
  currentItem,
  emptyBoard,
  escalate,
  hash,
  judgeText,
  makeStep,
  recordStep,
  reminder,
  settle,
  shouldJudge,
  withJudge,
  withEst,
  shouldAngle,
  angleText,
  parseAngles,
  withAngles,
  unjudged,
  addDrift,
  closeDrift,
} from './analyze'
import type { Action } from './analyze'
import {
  addFile,
  afterCompactNote,
  backgroundOf,
  buildLog,
  buildPack,
  compactInstructions,
  isPack,
  keepCorrection,
  logPathFor,
  mcpText,
  nameOf,
  packLogPath,
  parseStarted,
  parseState,
  titleOf,
  touchedFile,
} from './handoff'
import type { State } from './handoff'
import { hhmm, svgDegChart, svgHero, svgTrack } from './track'
import { ICON, LEGEND, STRIP_MAX, bandSegs, bandText, pctText, progColor, lanes, meterText, runs, svgBand, chipRow, chipSvg, BAND, toneOf, view } from './view'

const PANE = 'drift-watch'
const TITLE = '偏航观测'
const board = atom({ plugin: 'drift-watch', key: 'board' } as const, emptyBoard())
// 面板下方三个折叠区，同一时间只展开一个：'' | 'deg' | 'drift' | 'ops'
const details = atom({ plugin: 'drift-watch', key: 'open' } as const, '' as boolean | string)
const HUMAN = new Set(['composer', 'bridge', 'sdk'])
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
let busy = false
let afterCompact = 0 // 压缩完要提醒 Claude 先读日志：0 无 / 1 待提醒 / 2 已提醒（下一轮开始时清掉）

// 插件模型通道遇到 429 时改用备用模型，减少限流对后台估计的影响；可用性取决于宿主环境。
// 所以先用设置里的模型，遇到 429 自动改用 4.5 版 Haiku，并记住，之后这个会话直接用它
const FALLBACK = 'claude-haiku-4-5'
let useFallback = false
// 可选：使用者自己的 Anthropic API 密钥（插件设置里填钥匙串条目名，或环境变量 DRIFT_WATCH_API_KEY）。
// 有密钥就直接用它调 5.5 版，不走会被 429 的后台通道；取不到密钥或请求失败，才退回下面的老路
// 5.5 版默认先「想」再答，字数额度会被想的过程吃光、回不出字，所以关掉思考
const API_MODEL: Record<string, string> = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }
let apiKey: string | null | undefined
// 插件设置里的值，register 时填进来
const cfg = { keychainService: '', keychainAccount: '', logDir: '' }
async function getKey($: EngineInterface) {
  if (apiKey !== undefined) return apiKey
  apiKey = null
  if (cfg.keychainService) {
    try {
      const who = cfg.keychainAccount ? ['-a', cfg.keychainAccount] : []
      const r = await $.process.run(['/usr/bin/security', 'find-generic-password', '-s', cfg.keychainService, ...who, '-w'], { timeoutMs: 5000 })
      if (r.exitCode === 0 && r.stdout.trim()) apiKey = r.stdout.trim()
    } catch {
      // 取不到就看环境变量
    }
  }
  if (!apiKey) apiKey = (await $.env.get('DRIFT_WATCH_API_KEY'))?.trim() || null
  return apiKey
}
// 没设就放 ~/.claude/drift-watch/航行日志；读不到 HOME（比如测试环境）就放插件目录里
async function logDirOf($: EngineInterface) {
  if (cfg.logDir) return cfg.logDir
  let home: string | undefined
  try {
    home = await $.env.get('HOME')
  } catch {
    home = undefined
  }
  return home ? `${home}/.claude/drift-watch/航行日志` : `${$.plugin.root}/航行日志`
}
async function viaApi($: EngineInterface, model: string, prompt: string, maxTokens: number, timeoutMs: number): Promise<string | null> {
  const key = await getKey($)
  if (!key) return null
  let status: number | undefined
  let category = 'request-error'
  try {
    const call = $.http.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: API_MODEL[model] ?? model, max_tokens: maxTokens, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] }),
    })
    const res = await Promise.race([call, $.clock.sleep(timeoutMs).then(() => null)])
    if (!res) {
      $.ui.log('API category=timeout', { to: 'debug' })
      return null
    }
    status = res.status
    if (res.status === 401 || res.status === 403) apiKey = null // 密钥失效就别再试，这个会话改走老路
    if (!res.ok) {
      $.ui.log(`API status=${status} category=http-error`, { to: 'debug' })
      return null
    }
    category = 'invalid-response'
    const j = JSON.parse(res.text) as { content?: { type: string; text?: string }[] }
    const text = (j.content ?? []).map(c => (c.type === 'text' ? c.text ?? '' : '')).join('')
    $.ui.log(`API status=${status} category=${text ? 'ok' : 'empty-response'}`, { to: 'debug' })
    return text || null
  } catch {
    $.ui.log(`API status=${status ?? 'unknown'} category=${category}`, { to: 'debug' })
    return null
  }
}
async function ask($: EngineInterface, model: string, req: { prompt: string; maxTokens: number; timeoutMs: number }) {
  req = { ...req, prompt: redact(req.prompt) }
  const text = await viaApi($, model, req.prompt, req.maxTokens, req.timeoutMs)
  if (text) return { isAnswered: true as const, text }
  const go = (m: string) => $.model.complete({ model: m, effort: 'low', ...req })
  if (useFallback || model === FALLBACK) return go(FALLBACK)
  const r = await go(model)
  if (!r.isAnswered && r.reason === 'api-error' && r.status === 429) {
    useFallback = true
    return go(FALLBACK)
  }
  return r
}
let tried = { key: '', step: -99 }
// 后台小模型：先估目标和完成度，再给攒下的步骤判偏离角；同一时间只跑一个
async function background($: EngineInterface, model: string) {
  if (busy) return
  if (!(await read($, board)).goal) await recoverGoal($)
  const b = await read($, board)
  if (shouldEstimate(b)) return estimate($, model, b)
  if (shouldAngle(b)) return angles($, model, b)
}

async function angles($: EngineInterface, model: string, b: Board) {
  const asked = unjudged(b).slice(-12).map(s => s.n)
  busy = true
  let got = new Map<number, { deg: number; why: string }>()
  try {
    const r = await ask($, model, { prompt: angleText(b), maxTokens: 600, timeoutMs: 25000 })
    if (r.isAnswered) got = parseAngles(r.text)
  } catch {
    // 判不出来就按规则估，不反复重试同一批
  } finally {
    await update($, board, x => (x.task === b.task ? withAngles(x, got, asked) : x))
    busy = false
  }
}

// 目标平时在你发第一句时记下。但有几种情况会漏：会话是别的会话替你开的（第一句不是你亲手打的），
// 或者桌面版把闲着的会话后台重启过（插件记的东西在内存里，重启就没了）。所以没目标时，
// 就翻一遍这个会话的聊天记录，找出最早那句真正交代任务的话。只在你又发了话之后才重翻，不反复读。
// 反例：一个由别的会话替你开出来的会话，第一句不是你打的，小条和面板一直不出现。
const NOT_TASK = /^(This session is being continued|Another Claude session sent|<cross-session-message|<task-notification|<scheduled-task|<local-command|Caveat:|\[Request interrupted)/
let scannedAt = -1
async function recoverGoal($: EngineInterface) {
  try {
    const turns = await $.session.turns()
    if (turns === scannedAt) return
    const ms = await $.session.messages()
    let goal = ''
    let pack: State | null = null
    for (const m of ms) {
      if (m.role !== 'user' || m.toolResults?.length) continue
      const t = stripNotes(m.text).replace(/^Background \(from the session that started this one\):\s*/, '').trim()
      if (!t || t.startsWith('/')) continue
      if (isPack(t)) {
        // 别的会话交接过来的：目标要从交接包/日志里接，不能把交接包当新目标去概括
        pack = await loadPack($, t)
        if (pack) break
      }
      if (NOT_TASK.test(t)) continue
      goal = cut(t.replace(/\s+/g, ' '), 300)
      break
    }
    if (ms.length) scannedAt = turns // 记录还是空的（刚开会话）就下一拍再看
    if (pack) {
      const st = pack
      await update($, board, b => (b.goal ? b : packBoard(b.task + 1, st)))
    } else if (goal) await update($, board, b => (b.goal ? b : { ...emptyBoard(b.task + 1, goal), stats: b.stats, muted: [] }))
  } catch {
    // 读不到记录就算了，等你下一句
  }
}

// ---------- 航行日志 / 交接 ----------
// 日志由插件拼字写出，一个任务一份；关键节点（目标/补充/计划/阶段/文件/提醒/暂停/按钮）变了才重写。
// 接手会话（gen>=1）不重写：它自己的记录是空的，会把原会话的打转记录冲掉，它只往「纠偏记录」节里追加。
let logSig = ''
const logSigOf = (b: Board) =>
  hash(
    [
      b.task,
      b.goal,
      b.extras.length,
      (b.goals ?? []).length,
      b.est?.goal,
      b.est?.stage,
      b.est?.total,
      b.est?.stagePct,
      b.plan.map(p => p.status + p.text).join('|'),
      (b.files ?? []).length,
      (b.drifts ?? []).map(d => d.step + d.level + d.outcome).join('|'),
      b.signals.map(x => x.key + x.hits).join('|'),
      b.pause?.key,
      b.lastProgress,
      b.handoff?.t,
    ].join('\n'),
  )

async function writeLog($: EngineInterface, force = false): Promise<string | undefined> {
  try {
    const b = await read($, board)
    if (!b.goal) return undefined
    if ((b.gen ?? 0) >= 1) return b.logPath
    const now = await clockNow($)
    const path = b.logPath ?? logPathFor(b.goal, b.steps[0]?.t ?? now, await logDirOf($))
    const sig = logSigOf(b)
    if (!force && b.logPath && sig === logSig) return path
    let old: string | null = null
    try {
      old = (await $.fs.read(path)) as string
    } catch {
      old = null // 还没有这份日志
    }
    await $.fs.write(path, buildLog(b, { logPath: path, now, kept: keepCorrection(old) }))
    logSig = sig
    if (!b.logPath) await update($, board, x => (x.task === b.task && !x.logPath ? { ...x, logPath: path } : x))
    return path
  } catch (err) {
    $.ui.log(`航行日志写不了：${String(err).slice(0, 200)}`, { to: 'debug' })
    return undefined
  }
}

// 交接包 → 原会话的状态：优先读日志里的状态块（最全），读不到就退回交接包里的「任务目标」一行
async function loadPack($: EngineInterface, text: string): Promise<State | null> {
  const lp = packLogPath(text)
  if (lp) {
    try {
      const st = parseState(String(await $.fs.read(lp)))
      if (st) return st
    } catch {
      // 日志读不到，走下面
    }
  }
  const goal = text.match(/任务目标：(.+)/)?.[1]?.trim()
  if (!goal) return null
  return { v: 1, goal, extras: [], goals: [], est: null, plan: [], files: [], stats: emptyBoard().stats, drifts: [], key: '', gen: 0, logPath: lp ?? '', stepCount: 0 }
}
function packBoard(task: number, st: State): Board {
  return {
    ...emptyBoard(task, st.goal),
    extras: st.extras,
    goals: st.goals,
    est: st.est ? { ...st.est, step: 0 } : null,
    plan: st.plan,
    files: st.files,
    stats: st.stats,
    drifts: st.drifts,
    logPath: st.logPath || undefined,
    gen: st.gen + 1,
    handoffKey: st.key,
    muted: [],
  }
}

// 开侧会话：start_session（干净上下文，挂在原会话下面）→ 能分屏就分屏 → 不行出 spawn_task 卡片 → 再不行返回 null，由调用方退回原会话
async function handToFresh($: EngineInterface, b: Board, logPath: string, now: number): Promise<{ h: Handoff | null; why: string }> {
  b = redactBoard(b)
  const pack = buildPack(b, logPath, 'nested')
  const title = titleOf(b)
  const name = nameOf(b)
  const why: string[] = []
  try {
    const r = await $.mcp.call('ccd_session', 'start_session', { initiation: 'user_asked', context: 'fresh', title, prompt: pack, background: backgroundOf(b, logPath), use_worktree: false, name })
    const text = mcpText(r)
    const got = parseStarted(text)
    if (!r.isError && got.sessionId) {
      let opened = false
      try {
        const w = await $.mcp.call('ccd_window', 'open_session_in', { session_id: got.sessionId, target: 'split' })
        opened = !w.isError
      } catch {
        opened = false // 分屏做不到不强求，侧边栏里点开
      }
      return { h: { t: now, via: 'nested', name: got.name ?? name, sessionId: got.sessionId, note: opened ? '已分屏打开' : '在侧边栏里点开' }, why: '' }
    }
    why.push(`start_session：${cut(text.replace(/\s+/g, ' ') || '没有返回', 80)}`)
  } catch (err) {
    why.push(`start_session 调不通：${cut(String(err), 80)}`)
  }
  try {
    const r = await $.mcp.call('ccd_session', 'spawn_task', { title, prompt: pack, tldr: `偏航观测发现上一个会话在「${cut(b.pause?.text ?? b.signals[0]?.text ?? '同一处', 40)}」打转。点一下就开一个干净的新会话，读航行日志后接着把活干完。` })
    if (!r.isError) return { h: { t: now, via: 'card', name: title, note: '卡片已出，点一下就开新会话' }, why: why.join('；') }
    why.push(`spawn_task：${cut(mcpText(r), 80)}`)
  } catch (err) {
    why.push(`spawn_task 调不通：${cut(String(err), 80)}`)
  }
  return { h: null, why: why.join('；') }
}

// 小条上的总目标 / 阶段 / 完成度：让小模型概括一次，结果存在 board.est 里
async function estimate($: EngineInterface, model: string, b: Board) {
  const key = `${b.task}:${b.est?.key ?? ''}:${b.goal}:${b.extras.length}:${b.plan.length}`
  if (tried.key === key && b.stepCount - tried.step < 3) return // 刚失败过，隔几步再试
  busy = true
  tried = { key, step: b.stepCount }
  try {
    const r = await ask($, model, { prompt: estimateText(b), maxTokens: 200, timeoutMs: 20000 })
    let est = r.isAnswered ? parseEstimate(r.text, b) : null
    if (est && tooLong(est)) {
      // 超字数：带上原文让它压短重写一次，还超就硬截
      const r2 = await ask($, model, { prompt: shortenText(b, est), maxTokens: 200, timeoutMs: 20000 })
      const est2 = r2.isAnswered ? parseEstimate(r2.text, b) : null
      est = fitEst(est2 && !tooLong(est2) ? est2 : est2 ?? est)
    }
    if (est) await update($, board, x => (x.task === b.task && x.goal === b.goal ? withEst(x, est) : x))
  } catch {
    // 估不出来就用待办清单兜底
  } finally {
    busy = false
  }
}

// 终端里的正向进度：4 格，亮的那几格按摩卡日落从暗紫走到暖黄，百分比用当前进度的颜色
const pctBar = (Text: any, key: string, pct: number) => {
  const n = Math.round(pct / 25)
  return (
    <Text>
      {Array.from({ length: 4 }, (_, k) => <Text key={`${key}-${k}`} color={k < n ? progColor(k / 3) : undefined} dimColor={k >= n}>{k < n ? '▰' : '▱'}</Text>)}
      <Text bold color={progColor(pct / 100)}> {pctText(pct)}</Text>
    </Text>
  )
}

export const register: Register = (on, options) => {
  const mode = String(options.escalation ?? 'pause')
  const judgeModel = String(options.judgeModel ?? 'haiku')
  cfg.keychainService = String(options.apiKeychainService ?? '').trim()
  cfg.keychainAccount = String(options.apiKeychainAccount ?? '').trim()
  cfg.logDir = String(options.logDir ?? '').trim()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'drift', description: '偏航观测：打开面板；/drift new [目标] 开新任务；/drift goal <目标> 改目标' })
    // 小条上的总目标 / 阶段 / 完成度：后台定时看一眼，需要时才让小模型重估，不拖慢 Claude 的每一步
    $.clock.every(4000, () => {
      if (judgeModel !== 'off') void background($, judgeModel)
      void writeLog($) // 只在关键节点变了才真写
    })
    return next(e)
  })

  // 目标 = 你亲手发的第一句；任务做完后再发的话算新任务，没做完算补充
  on('prompt.submit', async ($, e, next) => {
    // 桌面版会在你的话前面塞 <system-reminder> 之类的系统附注，先去掉，只留你亲手打的字
    const said = stripNotes(e.text)
    if (isPack(said)) {
      // 交接包不是新目标：把原会话的目标、版本、阶段、待办接过来
      const st = await loadPack($, said)
      if (st) {
        await update($, board, b => packBoard(b.task + 1, st))
        return next(e)
      }
    }
    if (HUMAN.has(e.origin.kind) && said && !said.startsWith('/')) {
      const text = cut(said.replace(/\s+/g, ' '), 300)
      await update($, board, b => {
        const cleared = b.pause ? { ...b, pause: null } : b
        if (!b.goal || b.taskDone) return { ...emptyBoard(b.task + 1, text), stats: b.stats, muted: [] }
        return { ...cleared, extras: [...b.extras, text].slice(-5) }
      })
      await writeLog($)
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // 观测板出错也不能挡住你的输入

  on('turn.start', async ($, e, next) => {
    if (afterCompact === 2) afterCompact = 0 // 压缩后的那一轮已经提醒过了
    await update($, board, b => ({ ...b, turnId: e.turnId }))
    return next(e)
  })

  // 对话压缩：让摘要原样留住最初的目标和日志路径；压缩完的下一轮再提醒 Claude 先读日志
  on('session.compact', async ($, e, next) => {
    const b = await read($, board)
    if (!b.goal || e.agentId) return next(e)
    const path = (await writeLog($, true)) ?? b.logPath
    const ins = compactInstructions(b, path)
    const r = await next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${ins}` : ins })
    if (!r.skip && e.trigger !== 'precompute') afterCompact = 1
    return r
  }).catch(($, e, next) => next(e))

  // 目标常驻：每次给 Claude 拼系统提示时，都在末尾放上你最初的目标和后来的补充，对话再长、压缩过也不会丢。
  // 只放目标和补充，不放「当前第几步」：这段内容只在你改任务时才变，不会每一步都打掉提示缓存。
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.traits.includes('analysis') || e.traits.includes('bare')) return r
    const b = await read($, board)
    if (!b.goal) return r
    const sections = [...r.sections, { id: 'drift-watch:goal', text: goalSection(b.goal, b.extras, b.logPath), scope: 'session' as const }]
    if (afterCompact >= 1 && b.logPath) {
      afterCompact = 2
      sections.push({ id: 'drift-watch:compact', text: afterCompactNote(b.logPath), scope: 'session' as const })
    }
    return { sections }
  }).catch(($, e, next) => next(e)) // 出错就当没有这段，不能挡住请求

  on('command.run', { command: 'drift' }, async ($, e) => {
    const args = String((e as { args?: unknown }).args ?? '').trim()
    const [sub, ...rest] = args.split(/\s+/)
    const text = rest.join(' ').trim()
    if (sub === 'new') {
      await update($, board, b => ({ ...emptyBoard(b.task + 1, cut(text, 300)), stats: b.stats }))
      void openPane($)
      return { text: text ? `偏航观测：新任务，目标「${cut(text, 60)}」` : '偏航观测：已清空，下一句话当作新目标' }
    }
    if (sub === 'goal' && text) {
      await update($, board, b => ({ ...b, goal: cut(text, 300) }))
      return { text: `偏航观测：目标改为「${cut(text, 60)}」` }
    }
    if (sub === 'probe') return { text: await probe($) }
    if (sub === 'preview') {
      preview = true
      await update($, board, b => ({ ...b })) // 写一下好让小条重画
      $.clock.after(600_000, async () => {
        preview = false
        await update($, board, b => ({ ...b }))
      })
      return { text: '偏航观测：小条显示暂停样子 10 分钟（按钮不生效），可以截图看对齐' }
    }
    await openPane($)
    return { text: '偏航观测面板已打开' }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e) // 子任务内部的步骤不算主线
    const input = e as unknown as Record<string, unknown>
    const tool = e.tool

    if (PLAN_TOOLS.has(tool)) {
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError) return ran
      await update($, board, b => {
        const plan = nextPlan(b.plan, tool, input, ran.result)
        return plan ? applyPlan(b, plan) : b
      })
      await writeLog($)
      return ran
    }

    // 「拦下一步」模式：再犯后的下一个动作先拦住，让 Claude 对照目标说明
    const before = await read($, board)
    if (before.mustExplain) {
      const why = before.mustExplain
      await update($, board, b => ({ ...b, mustExplain: null }))
      return { deny: why }
    }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    let action: Action = null
    const t = await clockNow($)
    const meta = stripMeta(input)
    const file = ran.isError ? undefined : touchedFile(tool, meta)
    await update($, board, b => {
      const step = { ...makeStep(b.stepCount + 1, tool, meta, ran.isError === true, ran.text ?? ''), t, ...(file ? { file } : {}) }
      const out = escalate(recordStep(b, step))
      action = out.action
      return file ? { ...out.board, files: addFile(out.board.files, file) } : out.board
    })

    let b = await read($, board)
    if (judgeModel !== 'off' && shouldJudge(b)) {
      try {
        // classify 失败只回 undefined、看不到 429，所以没结果就用 4.5 版 Haiku 再判一次
        const judge = (m: string) => $.model.classify(judgeText(b), Object.keys(VERDICTS), { model: m })
        const labels = Object.keys(VERDICTS)
        const byApi = await viaApi($, judgeModel, `${judgeText(b)}\n\n只回下面其中一个标签，不要别的字：${labels.join(' / ')}`, 20, 15000)
        let label = byApi ? labels.find(l => byApi.includes(l)) : undefined
        if (label === undefined && !useFallback) label = await judge(judgeModel)
        if (label === undefined && judgeModel !== FALLBACK) {
          label = await judge(FALLBACK)
          if (label !== undefined) useFallback = true
        }
        const verdict = VERDICTS[String(label)]
        if (verdict) {
          await update($, board, x => {
            const out = escalate(withJudge(x, verdict))
            action = action ?? out.action
            return out.board
          })
          b = await read($, board)
        }
      } catch {
        // 模型调用失败就只靠规则
      }
    }

    const act = action as Action
    if (!act) return ran
    const context = [...(ran.context ?? [])]

    await update($, board, x => addDrift(x, { step: x.stepCount, level: act.type === 'warn' || mode !== 'pause' ? 'warn' : 'pause', text: act.signal.text, t }))
    await writeLog($, true) // 提醒 / 暂停是关键节点：日志里要有这一次的打转记录
    if (act.type === 'warn') {
      context.push(reminder(b, act.signal.text, false))
      $.ui.toast(`偏航观测：已提醒 Claude（${cut(act.signal.text, 40)}）`, { timeoutMs: 6000 })
      return { ...ran, context }
    }

    // 再犯
    context.push(reminder(b, act.signal.text, true))
    // 接手会话又在同一处打转：不再开第三个会话，直接暂停，请你亲自来看
    const again = (b.gen ?? 0) >= 1 && (!b.handoffKey || b.handoffKey === act.signal.key)
    if (mode === 'pause' || again) {
      await update($, board, x => ({ ...x, pause: { key: act.signal.key, text: act.signal.text, step: x.stepCount } }))
      void openPane($)
      void $.ui.notify(
        again
          ? `接手的新会话也在同一处打转：${cut(act.signal.text, 60)}。不会再开第三个会话，已暂停，请你亲自来看`
          : `提醒过还在重复：${cut(act.signal.text, 60)}。跑偏了，已暂停，等你选「让它换个思路」或「继续」`,
        { title: TITLE },
      )
      const turnId = (await read($, board)).turnId
      if (turnId) void $.turn.abort({ turnId }).catch(() => undefined)
    } else if (mode === 'block') {
      await update($, board, x => ({
        ...x,
        mustExplain: `偏航观测拦下了这一步：提醒过之后「${act.signal.text}」又出现了。先用两三句话对照任务目标说明现在卡在哪、为什么要做这一步、接下来换什么做法，然后再继续。`,
      }))
      $.ui.toast('偏航观测：再犯了，下一步会先让 Claude 解释', { timeoutMs: 6000 })
    } else {
      $.ui.toast(`偏航观测：再次提醒（${cut(act.signal.text, 40)}）`, { timeoutMs: 6000 })
    }
    return { ...ran, context }
  }).catch(($, e, next) => next(e)) // 观测板出错也不能挡住工具调用

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const Svg = e.surface === 'desktop' ? $.ui.resolve(e).Svg : undefined
    const b = await read($, board)
    const open = await read($, details)
    const cols = e.props.bodyColumns ?? 60

    if (!b.goal) {
      return (
        <Box flexDirection="column">
          <Text bold>还没有任务</Text>
          <Text dimColor wrap="wrap">
            你发出的第一句话会被当作任务。之后它会盯着 Claude：如果在原地打转或反复报错，先提醒 Claude，再犯就停下来等你。
          </Text>
        </Box>
      )
    }

    const v = view(b, mode)
    const br = brief(b)
    const px = Math.round(cols * 7.6) // 面板宽度（像素）：字符格 × 等宽字宽
    const now = await clockNow($)
    const sec = open === true ? 'ops' : String(open || '')
    const drifts = b.drifts ?? []
    const last = b.steps.at(-1)

    // 1. 结论 + 总目标 / 阶段两行进度（唯一焦点）
    let head
    if (Svg) {
      const g = svgHero(b, v, br, px, hhmm(last?.t ?? now))
      head = <Svg source={g.source} alt={g.alt} width={g.width} height={g.height} />
    } else {
      head = (
        <Box flexDirection="column">
          <Box gap={2}>
            <Text bold color={toneOf(v.kind)}>
              {ICON[v.kind]} {v.title}
            </Text>
            <Text color={toneOf(v.kind)}>{meterText(v.kind)}</Text>
          </Box>
          <Text wrap="wrap">{v.reason}</Text>
          {[
            { label: '总目标', text: br.goal, pct: br.total },
            { label: '阶段目标', text: br.stage, pct: br.stagePct },
          ]
            .filter(sg => sg.text)
            .map(sg => (
              <Text key={sg.label} wrap="truncate">
                <Text dimColor>{sg.label} </Text>
                <Text bold>{sg.text}</Text>
                {sg.pct !== null && <Text> {pctBar(Text, sg.label, sg.pct)}</Text>}
              </Text>
            ))}
        </Box>
      )
    }

    // 2. 需要你出手时才有按钮
    const actions =
      v.kind === 'pause' ? (
        <Box gap={1}>
          <Button key="pull" label="让它换个思路" variant="primary" onPress={() => pullBack($)} />
          <Button key="go" label="没问题，继续" onPress={() => resume($)} />
          <Button key="no" label="这是误报" plain onPress={() => notDrift($)} />
        </Box>
      ) : v.kind === 'warn' && b.warning ? (
        <Box gap={1}>
          <Button key="false" label="这是误报" plain onPress={() => notDrift($)} />
        </Box>
      ) : null

    // 3. 航迹图：灰线安静，只有偏了的步骤带颜色和文字
    let track
    if (Svg && b.steps.length) {
      const g = svgTrack(b, px, now, v.kind)
      track = <Svg source={g.source} alt={g.alt} width={g.width} height={g.height} />
    } else if (b.steps.length) {
      const g = svgTrack(b, px, now, v.kind)
      track = <Text dimColor wrap="wrap">{g.alt}</Text>
    } else {
      track = <Text dimColor>航迹：Claude 还没开始操作</Text>
    }

    // 4. 细节收进三个按钮，同一时间只展开一个
    const toggle = (k: string) => update($, details, x => (x === k || (k === 'ops' && x === true) ? '' : k))
    const arrow = (k: string) => (sec === k ? ' ⌃' : ' ›')
    const tabs = (
      <Box gap={1}>
        <Button key="deg" label={`每一步的偏离角${arrow('deg')}`} onPress={() => toggle('deg')} />
        <Button key="drift" label={`跑偏记录 ${drifts.length} 次${arrow('drift')}`} onPress={() => toggle('drift')} />
        <Button key="ops" label={`操作记录${arrow('ops')}`} onPress={() => toggle('ops')} />
      </Box>
    )

    let detail = null
    if (sec === 'deg') {
      if (Svg && b.steps.length) {
        const g = svgDegChart(b, px)
        detail = <Svg source={g.source} alt={g.alt} width={g.width} height={g.height} />
      } else detail = <Text dimColor wrap="wrap">{b.steps.length ? svgDegChart(b, px).alt : '还没有操作'}</Text>
    } else if (sec === 'drift') {
      detail = (
        <Box flexDirection="column">
          {drifts.length === 0 && <Text dimColor>这个任务还没跑偏过</Text>}
          {[...drifts].reverse().map(d => (
            <Text key={`${d.step}-${d.t}`} wrap="wrap">
              <Text dimColor>
                第 {d.step} 步 · {hhmm(d.t)} ·{' '}
              </Text>
              <Text color={d.level === 'pause' ? 'error' : 'warning'}>{d.level === 'pause' ? '暂停' : '提醒'}</Text>
              <Text> {d.text}</Text>
              {d.outcome ? <Text dimColor> → {d.outcome}</Text> : null}
            </Text>
          ))}
          <Text dimColor wrap="wrap">
            一共提醒过 {b.stats.warned} 次 · 误报 {b.stats.falseAlarm} 次 · 提醒后回到正轨 {b.stats.recovered} 次
          </Text>
        </Box>
      )
    } else if (sec === 'ops') {
      detail = (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            {lanes(b).map(l => (
              <Box flexDirection="column">
                <Text bold={l.current} dimColor={!l.current} wrap="truncate">
                  {l.mark} {cut(l.text, Math.max(10, cols - 4))}
                </Text>
                {l.steps.length > 0 && (
                  <Box paddingLeft={2}>
                    {runs(l.steps.slice(-STRIP_MAX)).map(r => (
                      <Text color={r.color} dimColor={!r.color}>
                        {'■'.repeat(r.n)}
                      </Text>
                    ))}
                  </Box>
                )}
              </Box>
            ))}
            <Box paddingLeft={2} gap={1}>
              {LEGEND.map(x => (
                <Text color={x.color} dimColor={!x.color}>
                  ■<Text dimColor>{x.name}</Text>
                </Text>
              ))}
            </Box>
          </Box>
          {b.extras.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>你后来补充的</Text>
              {b.extras.map(x => (
                <Text dimColor wrap="wrap">
                  + {x}
                </Text>
              ))}
            </Box>
          )}
          <Box flexDirection="column">
            <Text dimColor>最近的操作</Text>
            {b.steps.slice(-8).map(s => (
              <Text dimColor wrap="truncate">
                {s.n}. {s.label}
                {s.isError ? '  报错' : ''}
              </Text>
            ))}
          </Box>
          <Text dimColor wrap="wrap">
            跑偏分 {b.score}/100（40 提醒 Claude，提醒后再犯就{mode === 'pause' ? '暂停' : mode === 'block' ? '拦下' : '再提醒'}）
          </Text>
          <Button key="new" label="清空，开始新任务" plain onPress={() => update($, board, x => ({ ...emptyBoard(x.task + 1), stats: x.stats }))} />
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" gap={1}>
          {head}
          {actions}
        </Box>
        {track}
        {tabs}
        {detail}
      </Box>
    )
  })

  // 输入框上方只有一栏：先画自己这一行，再把下面插件（比如用量条）的画面接在后面，谁先谁后都不会互相挤掉
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const below = await next(e)
    const b = await read($, board)
    if (!b.goal) return below // 还没任务就不占地方
    // /drift preview：不真暂停，只把小条画成暂停样子检查位置，按钮不生效
    const v = preview && !b.pause ? { ...view(b, mode), kind: 'pause' as const } : view(b, mode)
    const t = preview && !b.pause ? { main: '跑偏了，已暂停', sub: '预览暂停样子，按钮不生效' } : bandText(b, v)
    const br = brief(b)
    const cols = e.props.bodyColumns ?? 80
    const { Box, Text, Button } = $.ui.resolve(e)
    const btns =
      e.surface === 'desktop'
        ? [
            <Button key="open" label="查看 ›" plain dimColor onPress={() => openPane($)} />,
          ].filter(x => x !== null)
        : [
            v.kind === 'pause' ? <Button key="pull" label="↻ 换个思路" variant="primary" onPress={() => pullBack($)} /> : null,
            v.kind === 'pause' ? <Button key="go" label="▶ 继续" onPress={() => resume($)} /> : null,
            <Button key="open" label="查看" plain onPress={() => openPane($)} />,
          ].filter(x => x !== null)
    let mine
    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      // 小条宽度只跟窗口走，暂停也不变；右边常留按钮位，暂停时两个按钮接在小条右边，整体一行横排
      // 正常时进度条右端对齐下面用量条蓝色胶囊的右端，「查看」固定在最后一个胶囊（黄色）正上方居中
      // 使用固定参考坐标近似对齐用量条，不实时读取其布局，避免额外的测量开销。
      // 桌面版会把小条图拉满整行，因此图宽使用整行参考宽度，让图内坐标与屏幕位置对应。
      // 「查看」也画进图里，点击交给盖在上面的透明按钮，不再放真按钮（真按钮被拉满的图挤出了可见区）
      const pos = await bandPos($)
      const right = pos.blueR
      const chips = v.kind === 'pause' || pos.preview
        ? chipRow(right, [
            { key: 'pull', text: '↻ 换个思路', color: '#f38ba8', go: () => void pullBack($) },
            { key: 'go', text: '▶ 继续', color: '#a6e3a1', go: () => void resume($) },
          ])
        : []
      const look = `<text x="${pos.lookC}" y="${BAND.h / 2 + 4.5}" text-anchor="middle" class="l2" style="font-size:13px">查看 ›</text>`
      const g = svgBand(chips.length ? 'pause' : v.kind, t, br, chips.length ? chips[0]!.x - 4 : right + 6, pos.slot, chipSvg(chips) + look)
      if (pos.debug) void $.fs.write('/tmp/drift-band-diag.json', JSON.stringify({ at: Date.now(), pos, width: g.width, cols })).catch(() => {}) // debug 时记下位置，方便对照截图
      const dbg = pos.debug ? { backgroundColor: '#ff00ff' } : {}
      // 点击：每个按钮上盖一个只有空格的按钮（不写 label，写了桌面版会把字画出来盖住图里的按钮），位置按格子算（桌面一格按约 9.4px 估算），差几像素不影响点
      const hit = (key: string, l: number, w: number, go: () => void) => (
        <Box key={`${key}-hit`} position="absolute" top={0} bottom={0} left={Math.round(l / pos.cell)} width={Math.max(1, Math.round(w / pos.cell))} justifyContent="center" alignItems="center" {...dbg}>
          <Button key={key} plain onPress={go}>
            <Text>{'\u3000'.repeat(Math.max(1, Math.floor(w / 13) - 1))}</Text>
          </Button>
        </Box>
      )
      const hits = [
        ...chips.map(c => hit(c.key, c.x, c.w, () => { if (preview || pos.preview) $.ui.toast(`预览：点到了「${c.text}」`); else c.go() })),
        hit('open', pos.lookC - 24, 48, () => void openPane($)),
      ]
      mine = (
        <Box>
          <Svg source={g.source} alt={g.alt} width={g.width} height={g.height} />
          {hits}
        </Box>
      )
    } else {
      mine = (
        <Box gap={1}>
          <Text bold color={toneOf(v.kind)}>
            {ICON[v.kind]} {t.main}
          </Text>
          <Text color={toneOf(v.kind)}>{meterText(v.kind)}</Text>
          {bandSegs(v.kind, t, br).map(sg => (
            <Text key={sg.label} wrap="truncate">
              <Text dimColor>│ {sg.label} </Text>
              <Text color={sg.tone}>{sg.text}</Text>
              {sg.pct !== null && <Text> {pctBar(Text, sg.label, sg.pct)}</Text>}
            </Text>
          ))}
          {btns}
        </Box>
      )
    }
    return below ? (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    ) : (
      mine
    )
  })
}

// 桌面小条的固定参考坐标（单位 px，从小条左边算）：整行图宽、蓝色胶囊右端、最后一个黄色胶囊中线、字符格宽度。
// 可在插件根目录的 band-pos.json 里微调，不用改代码
const POS = { slot: 883, blueR: 786, lookC: 839, cell: 9.4, debug: false, preview: false }
async function bandPos($: EngineInterface) {
  try {
    return { ...POS, ...(JSON.parse(String(await $.fs.read(`${$.plugin.root}/band-pos.json`))) as Partial<typeof POS>) }
  } catch {
    return POS
  }
}
let preview = false
const stripNotes = (s: string) => s.replace(/<(system-reminder|ide_[a-z_]+|command-[a-z-]+)>[\s\S]*?<\/\1>/g, '').trim()

function goalSection(goal: string, extras: readonly string[], logPath?: string) {
  goal = redact(goal)
  extras = extras.map(redact)
  return redact([
    '# 本次任务的原始目标（偏航观测）',
    `用户最开始交代的任务：${goal}`,
    extras.length ? `用户后来的补充（按时间顺序）：\n${extras.map(x => `- ${cut(x, 160)}`).join('\n')}` : '',
    logPath ? `这个任务的航行日志（目标、阶段、待办、改过的文件、卡点都在里面，忘了或压缩后先读它）：${logPath}` : '',
    '每做一步都对照这个目标：这一步是不是在推进它？如果偏到了别的事、或在同一个问题上反复打转，先停下回到目标，或把必要的旁支写进待办清单。目标被用户明确改了才算改，不要自己悄悄换方向。',
  ]
    .filter(Boolean)
    .join('\n'))
}

// 拿不到宿主时钟（比如测试环境）就退回本地时间，不能因为记时间挡住工具调用
async function clockNow($: EngineInterface) {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE })
}

async function resume($: EngineInterface) {
  const b = redactBoard(await read($, board))
  await update($, board, x => settle(closeDrift(x, '你说没问题，继续'), 'false-alarm'))
  await writeLog($, true)
  await $.prompt.submit({ text: `继续。刚才偏航观测暂停的地方（${b.pause?.text ?? ''}）是必要的，不算偏航，按原思路往下做。` })
}

// 「让它换个思路」：全自动，不调模型。刷新日志 → 按固定模板写交接包 → 开一个干净的侧会话把包交过去 → 原会话停下。
// 开不了侧会话时依次退到：出卡片（你点一下）→ 在原会话里换思路（老做法）。
async function pullBack($: EngineInterface) {
  const b = redactBoard(await read($, board))
  const reason = b.pause?.text ?? b.signals[0]?.text ?? '最近几步在打转'
  const logPath = await writeLog($, true) // 先写，这时 pause 还在，状态块里记得住卡在哪个信号
  const now = await clockNow($)
  let out: { h: Handoff | null; why: string } = { h: null, why: (b.gen ?? 0) >= 1 ? '已经是接手会话，不再往下嵌套' : logPath ? '' : '航行日志没写成' }
  if ((b.gen ?? 0) === 0 && logPath) out = await handToFresh($, b, logPath, now)
  const h = out.h
  const outcome = !h ? '你选了换思路' : h.via === 'nested' ? `已交接给 ${h.name}` : '已出交接卡片，等你点一下'
  const handoff: Handoff = h ?? { t: now, via: 'same', name: '本会话', note: out.why || '在本会话里换思路' }
  await update($, board, x => ({ ...closeDrift(x, outcome), pause: null, warning: null, handoff }))
  if (h) {
    $.ui.toast(h.via === 'nested' ? `偏航观测：已交接给 ${h.name}（${h.note}）` : `偏航观测：交接卡片已出，点一下就开新会话`, { timeoutMs: 8000 })
    await writeLog($, true)
    return
  }
  $.ui.toast(`偏航观测：开不了侧会话，改在本会话里换思路${out.why ? `（${cut(out.why, 60)}）` : ''}`, { timeoutMs: 8000 })
  await writeLog($, true)
  const cur = currentItem(b.plan)
  await $.prompt.submit({
    text: redact([
      `偏航观测提醒：${reason}。`,
      `任务目标：${b.goal}`,
      `当前计划步骤：${cur?.text ?? '（没有待办清单）'}`,
      logPath ? `航行日志：${logPath}（先读它，再把“纠偏记录”写进去）` : '',
      '先用一两句话说清刚才偏到哪了、为什么，然后回到当前计划步骤继续；不要再用同样的方法重试。',
    ]
      .filter(Boolean)
      .join('\n')),
  })
}

// /drift probe：不开任何会话，只看这个插件够不够得着桌面版的会话/窗口工具（排查用）
async function probe($: EngineInterface) {
  const lines: string[] = []
  for (const [server, tool] of [['ccd_window', 'get_window_layout'], ['ccd_session', 'list_start_targets']] as const) {
    try {
      const r = await $.mcp.call(server, tool, {})
      lines.push(`${server}.${tool}：${r.isError ? '报错' : '通'} ${cut(mcpText(r).replace(/\s+/g, ' '), 120)}`)
    } catch (err) {
      lines.push(`${server}.${tool}：调不通 ${cut(String(err), 120)}`)
    }
  }
  return lines.join('\n')
}

async function notDrift($: EngineInterface) {
  await update($, board, x => settle(closeDrift(x, '你标了误报'), 'false-alarm'))
  await writeLog($, true)
}

// 工具调用参数里混着 tool / tool_use_id / agentId 等信封字段，指纹只看真正的参数
function stripMeta(input: Record<string, unknown>): Record<string, unknown> {
  const { tool: _t, tool_use_id: _id, agentId: _a, ...rest } = input
  void _t
  void _id
  void _a
  return rest
}

function nextPlan(plan: readonly PlanItem[], tool: string, input: Record<string, unknown>, result: unknown): PlanItem[] | null {
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    return (input.todos as { content?: string; status?: PlanStatus }[]).map(t => ({
      id: hash(String(t.content ?? '')),
      text: String(t.content ?? ''),
      status: t.status ?? 'pending',
    }))
  }
  if (tool === 'TaskCreate') {
    const task = (result as { task?: { id?: string; subject?: string } } | undefined)?.task
    const id = String(task?.id ?? hash(String(input.subject)))
    return [...plan, { id, text: String(task?.subject ?? input.subject ?? ''), status: 'pending' }]
  }
  if (tool === 'TaskUpdate') {
    const id = String(input.taskId ?? '')
    if (!plan.some(p => p.id === id)) return null
    if (input.status === 'deleted') return plan.filter(p => p.id !== id)
    return plan.map(p =>
      p.id === id
        ? {
            ...p,
            text: typeof input.subject === 'string' ? input.subject : p.text,
            status: (['pending', 'in_progress', 'completed'] as const).includes(input.status as PlanStatus) ? (input.status as PlanStatus) : p.status,
          }
        : p,
    )
  }
  return null
}

export type { Board }
