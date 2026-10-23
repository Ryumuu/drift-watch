// 航行日志 + 交接包：全部是拼字，不调任何模型。
// 日志由插件按固定模板写；交接包也是固定模板，不让卡住的 Claude 自己组织语言。
import type { Board, PlanItem, Step } from '../types'
import { brief, currentItem, redact, redactBoard } from './analyze'

export const PACK_MARK = '【偏航观测·交接包】'
export const CORRECTION_HEAD = '## 纠偏记录（接手会话在这里追加）'
const STATE_OPEN = '<!-- drift-watch:state '
const STATE_CLOSE = ' -->'

const squash = (s: unknown) => redact(String(s ?? '')).replace(/\s+/g, ' ').trim()
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
const pad = (n: number) => String(n).padStart(2, '0')

export const dateStr = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
export const clockStr = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 文件名里不能有的字符、空白都去掉，只留目标前若干字
export function slug(goal: string, n = 16) {
  const s = squash(goal).replace(/[\\/:*?"<>|#%&{}$!'`@+=~^;,.()[\]\s]/g, '')
  return cut(s, n + 1).replace(/…$/, '') || '任务'
}
export const logPathFor = (goal: string, ms: number, dir: string) => `${dir.replace(/\/$/, '')}/${dateStr(ms)}_${slug(goal)}.md`

// 这一步改/写了哪个文件（只认完整路径）
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
export function touchedFile(tool: string, input: Record<string, unknown>): string | undefined {
  if (!FILE_TOOLS.has(tool)) return undefined
  const p = input.file_path ?? input.notebook_path
  return typeof p === 'string' && p ? p : undefined
}
export function addFile(files: readonly string[] | undefined, file: string | undefined): string[] {
  const cur = files ?? []
  if (!file || cur.includes(file)) return [...cur]
  return [...cur, file].slice(-60)
}

const STATUS = { completed: '[x] 已完成', in_progress: '[~] 正在做', pending: '[ ] 没开始' } as const
const planLine = (p: PlanItem) => `- ${STATUS[p.status]} ${cut(squash(p.text), 160)}`

const stepLine = (s: Step) => {
  const tags = s.tags.length ? `【${s.tags.join('、')}】` : ''
  const deg = s.deg !== undefined && Math.abs(s.deg) >= 15 ? ` 偏离角 ${s.deg > 0 ? '+' : ''}${s.deg}°${s.why ? `（${cut(squash(s.why), 80)}）` : ''}` : ''
  const err = s.isError && s.errText ? `\n    报错原文：${s.errText}` : ''
  return `- 第 ${s.n} 步 ${tags}${cut(s.label, 80)}${deg}${err}`
}

// 最后一次真正有进展的步：lastProgress 那一步（可能已不在最近 60 步里）
function progressInfo(b: Board) {
  const s = b.steps.find(x => x.n === b.lastProgress)
  const f = [...b.steps].reverse().find(x => x.file)
  const lastFile = f ? `最近一次改文件：第 ${f.n} 步 ${f.file}` : b.files?.length ? `最近改过的文件：${b.files.at(-1)}` : ''
  const head =
    b.lastProgress <= 0
      ? '还没有记到有进展的步骤（任务刚开始，或一直没推进）'
      : s
        ? `第 ${s.n} 步：${cut(s.label, 100)}`
        : `第 ${b.lastProgress} 步（早于最近 ${b.steps.length} 步的记录，细节已滚出）`
  return lastFile ? `${head}\n${lastFile}` : head
}

// 从哪一步开始打转：最后有进展之后的步骤；有信号就列信号
function stuckSteps(b: Board) {
  const after = b.steps.filter(s => s.n > b.lastProgress)
  const flagged = after.filter(s => s.tags.length > 0 || (s.deg !== undefined && Math.abs(s.deg) >= 15))
  return (flagged.length ? flagged : after).slice(-12)
}

// ---------- 机器可读的状态块：接手会话靠它把原目标接上，不靠概括 ----------
export type State = {
  v: 1
  goal: string
  extras: string[]
  goals: Board['goals']
  est: Board['est']
  plan: PlanItem[]
  files: string[]
  stats: Board['stats']
  drifts: Board['drifts']
  key: string // 交接时卡住的信号 key
  gen: number
  logPath: string
  stepCount: number
}

export function stateOf(b: Board, logPath: string): State {
  return {
    v: 1,
    goal: b.goal,
    extras: [...b.extras],
    goals: [...(b.goals ?? [])],
    est: b.est,
    plan: [...b.plan],
    files: [...(b.files ?? [])],
    stats: b.stats,
    drifts: [...(b.drifts ?? [])],
    key: b.pause?.key ?? b.warning?.key ?? b.signals[0]?.key ?? '',
    gen: b.gen ?? 0,
    logPath,
    stepCount: b.stepCount,
  }
}
// JSON 里的 < > 换成转义，保证包在 HTML 注释里不会被 --> 截断
const packJson = (v: unknown) => JSON.stringify(v, (_key, value) => typeof value === 'string' ? redact(value) : value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')

export function parseState(text: string): State | null {
  const i = text.indexOf(STATE_OPEN)
  if (i < 0) return null
  const j = text.indexOf(STATE_CLOSE, i + STATE_OPEN.length)
  if (j < 0) return null
  try {
    const v = JSON.parse(text.slice(i + STATE_OPEN.length, j)) as State
    return v && v.v === 1 && typeof v.goal === 'string' && v.goal ? v : null
  } catch {
    return null
  }
}

// 日志里「纠偏记录」那一节归接手会话写，插件每次刷新都原样保留
export function keepCorrection(old: string | null | undefined): string {
  if (!old) return ''
  const i = old.indexOf(CORRECTION_HEAD)
  if (i < 0) return ''
  let rest = old.slice(i + CORRECTION_HEAD.length)
  const k = rest.indexOf(STATE_OPEN) // 状态块永远由插件重写，不算纠偏记录
  if (k >= 0) rest = rest.slice(0, k)
  return rest.replace(/^\n/, '').trimEnd()
}

export function buildLog(b: Board, o: { logPath: string; now: number; kept?: string }): string {
  b = redactBoard(b)
  o = { ...o, logPath: redact(o.logPath), kept: o.kept ? redact(o.kept) : '' }
  const br = brief(b)
  const cur = currentItem(b.plan)
  const pct = (n: number | null) => (n === null ? '未估' : `${n}%`)
  const L: string[] = []
  L.push(`# 航行日志：${cut(squash(b.goal), 60)}`)
  L.push('')
  L.push(`> 偏航观测插件自动写的，只拼字、不调模型。更新于 ${dateStr(o.now)} ${clockStr(o.now)}，已记 ${b.stepCount} 步。`)
  L.push(`> 路径：${o.logPath}`)
  L.push('')
  L.push('## 一、最初的目标（用户原话）')
  L.push('')
  L.push(squash(b.goal))
  L.push('')
  if ((b.goals ?? []).length) {
    L.push('### 目标的各个版本（模型概括，因用户补充而变）')
    L.push('')
    for (const g of b.goals) L.push(`- v${g.v}（第 ${g.step} 步）${cut(squash(g.text), 160)}${g.why ? `　因为：${cut(squash(g.why), 100)}` : ''}`)
    L.push('')
  }
  if (b.extras.length) {
    L.push('### 用户后来补充的话（按时间顺序，原话）')
    L.push('')
    for (const x of b.extras) L.push(`- ${cut(squash(x), 300)}`)
    L.push('')
  }
  L.push('## 二、现在的阶段与完成度')
  L.push('')
  L.push(`- 总目标：${cut(squash(br.goal), 160) || '（未概括）'}　完成度 ${pct(br.total)}`)
  L.push(`- 阶段目标：${cut(squash(br.stage), 160) || '（未概括）'}　完成度 ${pct(br.stagePct)}`)
  L.push(`- 计划里正在做的一项：${cur ? cut(squash(cur.text), 160) : '（没有待办清单）'}`)
  L.push('')
  L.push('## 三、待办清单')
  L.push('')
  if (b.plan.length) for (const p of b.plan) L.push(planLine(p))
  else L.push('（没有待办清单）')
  L.push('')
  L.push('## 四、已改过的文件')
  L.push('')
  if ((b.files ?? []).length) for (const f of b.files!) L.push(`- ${f}`)
  else L.push('（还没有改过文件）')
  L.push('')
  L.push('## 五、最后一次真正有进展')
  L.push('')
  L.push(progressInfo(b))
  L.push('')
  L.push('## 六、从哪里开始打转')
  L.push('')
  if (b.signals.length) {
    L.push('偏航信号：')
    for (const s of b.signals) L.push(`- ${s.text}（${s.hits} 次）`)
    L.push('')
  } else L.push('（现在没有触发偏航信号）\n')
  const stuck = stuckSteps(b)
  if (stuck.length) {
    L.push(`有进展之后的步骤（共 ${b.steps.filter(s => s.n > b.lastProgress).length} 步，列出有标记的最近 ${stuck.length} 步）：`)
    for (const s of stuck) L.push(stepLine(s))
    L.push('')
  }
  L.push('## 七、历次跑偏记录')
  L.push('')
  if ((b.drifts ?? []).length) for (const d of b.drifts) L.push(`- 第 ${d.step} 步 ${clockStr(d.t)} ${d.level === 'pause' ? '暂停' : '提醒'}：${cut(squash(d.text), 120)}${d.outcome ? ` → ${d.outcome}` : ''}`)
  else L.push('（这个任务还没跑偏过）')
  L.push('')
  L.push(`${CORRECTION_HEAD}`)
  L.push(o.kept ? o.kept : '')
  L.push('')
  L.push(`${STATE_OPEN}${packJson(stateOf(b, o.logPath))}${STATE_CLOSE}`)
  L.push('')
  // 纠偏记录节在状态块前面；状态块永远在文件最后一行，接手会话别碰它
  return L.join('\n').replace(/\n{3,}/g, '\n\n')
}

// ---------- 交接包 ----------
export function buildPack(b: Board, logPath: string, mode: 'nested' | 'same'): string {
  b = redactBoard(b)
  const br = brief(b)
  const cur = currentItem(b.plan)
  const stuck = stuckSteps(b)
  const errs = stuck.filter(s => s.isError && s.errText).slice(-4)
  const L: string[] = []
  L.push(`${PACK_MARK}${mode === 'nested' ? '你是接手会话：上一个会话在同一处卡住了，用户点了「让它换个思路」，由你从干净的上下文接着做。' : '你就是接手者：用户点了「让它换个思路」。先把下面的事按顺序做完，再接着干活。'}`)
  L.push(`航行日志：${logPath}`)
  L.push('')
  L.push(`任务目标：${cut(squash(b.goal) || '（未记录）', 300)}`)
  if (b.extras.length) L.push(`用户后来的补充：\n${b.extras.map(x => `- ${cut(squash(x), 200)}`).join('\n')}`)
  L.push(`当前阶段：${cut(squash(br.stage) || '（未概括）', 160)}（阶段完成度 ${br.stagePct === null ? '未估' : br.stagePct + '%'}；总完成度 ${br.total === null ? '未估' : br.total + '%'}）`)
  L.push(`当前计划步骤：${cur ? cut(squash(cur.text), 160) : '（没有待办清单）'}`)
  if (b.plan.length) L.push(`待办清单：\n${b.plan.map(planLine).join('\n')}`)
  L.push(`已改过的文件：${(b.files ?? []).length ? '\n' + b.files!.slice(-20).map(f => `- ${f}`).join('\n') : '（还没有）'}`)
  L.push(`最后一次有进展：${progressInfo(b)}`)
  L.push(`卡住的地方：${b.pause?.text ?? b.signals[0]?.text ?? '最近几步在打转'}`)
  if (errs.length) L.push(`报错原文：\n${errs.map(s => `- 第 ${s.n} 步 ${cut(s.label, 60)}：${s.errText}`).join('\n')}`)
  L.push('')
  L.push('要求（按顺序）：')
  L.push(`1. 先完整读航行日志（${logPath}），它记了目标、阶段、待办、改过的文件、哪一步开始打转和报错原文。`)
  L.push(`2. 在日志里「${CORRECTION_HEAD.replace(/^## /, '')}」这一节下面追加一段分析，别动其他节和最后那行状态注释，分五点写：目的（总目标＋阶段目标）／哪里走错了、走到哪了／为什么错／怎么纠正／哪些做法不许再用。`)
  L.push('3. 写完马上接着把活干完：已经做完的不重做，不要从头开始；沿着“怎么纠正”那条走。')
  L.push('4. 同一个做法失败两次就换思路；换了还卡，就停下来用三句话告诉用户卡在哪、试过什么。')
  L.push(mode === 'nested' ? '5. 你是第二层，不要再开嵌套会话或子会话来交接；需要帮手就在本会话里自己做。' : '5. 不要再另开会话来交接，就在这个会话里做。')
  return redact(L.join('\n'))
}

// 交接包里的日志路径；认不出就没有
export function packLogPath(text: string): string | null {
  const m = text.match(/航行日志：(\S+\.md)/)
  return m ? m[1]! : null
}
export const isPack = (text: string) => text.includes(PACK_MARK)

// start_session 要求 background 至少 80 个字符
export function backgroundOf(b: Board, logPath: string) {
  const s = `这是偏航观测插件发起的交接：上一个会话的任务是「${cut(squash(b.goal), 200)}」，在同一处打转卡住了。完整经过在航行日志 ${logPath} 里。你从干净的上下文接手，先读日志、写纠偏分析，再把活干完。`
  return redact(s.length >= 100 ? s : s + ' '.repeat(Math.max(0, 100 - s.length)).replace(/ /g, '。'))
}

export const titleOf = (b: Board) => cut(`纠偏：${squash(b.goal)}`, 58)
export const nameOf = (b: Board) => `fix-${slug(b.goal, 6) === '任务' ? 'task' : 'drift'}-${(b.task ?? 0).toString(36)}${Math.abs(b.stepCount) % 100}`.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24)

// 从 start_session 的返回文字里取会话号和名字
export function parseStarted(text: string): { sessionId?: string; name?: string } {
  const id = text.match(/session_id:\s*([A-Za-z0-9_\-]+)/)
  const name = text.match(/name:\s*([a-z0-9\-]+)/)
  return { sessionId: id?.[1], name: name?.[1] }
}

export function mcpText(r: { content?: readonly { type?: string; text?: string }[] } | undefined): string {
  return (r?.content ?? []).map(c => (c.type === 'text' ? (c.text ?? '') : '')).join('\n').trim()
}

// ---------- 压缩 ----------
export function compactInstructions(b: Board, logPath: string | undefined): string {
  return redact([
    '偏航观测要求：摘要必须原样保留下面两项，不要改写、不要省略。',
    `最初目标（用户原话）：${cut(squash(b.goal), 300)}`,
    b.extras.length ? `用户后来的补充：${b.extras.map(x => cut(squash(x), 160)).join('；')}` : '',
    logPath ? `航行日志路径：${logPath}（压缩后先读它再继续）` : '',
  ]
    .filter(Boolean)
    .join('\n'))
}

export function afterCompactNote(logPath: string): string {
  return redact(`刚做过对话压缩。继续之前先读航行日志 ${logPath}：它是这个任务的原始目标、阶段、待办、改过的文件和卡点的完整记录，摘要里漏掉的以它为准。`)
}
