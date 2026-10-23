// 纯规则：不碰 $，方便测试。所有函数都返回新的 Board。
import type { Board, Drift, Est, GoalVer, PlanItem, Signal, Step, StepTag, Verdict, Warning } from '../types'

// 在截短和输出前清理常见凭据；不改变用于重复动作判断的原始指纹。
export function redact(text: string): string {
  return text
    .replace(/(["']?\b(?:x-api-key|Authorization|password|token)["']?\s*[:=]\s*)(\[已隐藏\]|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|(?:Bearer[ \t]+)?[^\s,;&<>{}\[\]"'`]+)/gi,
      (_match, field: string, value: string) => field + (value[0] === '"' || value[0] === "'" ? value[0] + '[已隐藏]' + value[0] : '[已隐藏]'))
    .replace(/\bBearer[ \t]+(?:\[已隐藏\]|[^\s"'`,;<>}\]]+)/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk-ant-|sk-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]+/g, '[已隐藏]')
}

// 逐个字符串清理再序列化，既覆盖嵌套状态，也不破坏 JSON 引号和结构。
export const redactBoard = (b: Board): Board => JSON.parse(JSON.stringify(b, (_key, v) => typeof v === 'string' ? redact(v) : v))

const WINDOW = 20 // 只看最近 20 步（OpenHands 同款）
const KEEP = 60 // 面板最多留 60 步
export const RECHECK = 5 // 提醒后观察 5 步，算「再犯」的窗口
export const WARN_AT = 40
export const DRIFT_AT = 70

// 这些工具是「改计划」或纯查工具表，不算实际步骤
export const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ToolSearch'])

export function emptyBoard(task = 0, goal = ''): Board {
  return {
    task,
    goal,
    extras: [],
    plan: [],
    steps: [],
    stepCount: 0,
    lastProgress: 0,
    lastPlanChange: 0,
    taskDone: false,
    score: 0,
    signals: [],
    warning: null,
    pause: null,
    mustExplain: null,
    muted: [],
    judge: null,
    stats: { warned: 0, recovered: 0, repeated: 0, judged: 0, falseAlarm: 0 },
    turnId: null,
    est: null,
    goals: [],
    drifts: [],
  }
}

export function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

const base = (p: unknown) => String(p ?? '').split('/').filter(Boolean).pop() ?? ''
const squash = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function sortedJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? ''
  if (Array.isArray(v)) return '[' + v.map(sortedJson).join(',') + ']'
  const o = v as Record<string, unknown>
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + sortedJson(o[k])).join(',') + '}'
}

// 指纹 = 工具名 + 规范化后的关键参数；label 是给人看的短描述
export function fingerprint(tool: string, input: Record<string, unknown>): { fp: string; label: string } {
  let key: string
  let label: string
  switch (tool) {
    case 'Bash':
      key = squash(input.command)
      label = squash(input.description) || squash(input.command)
      break
    case 'Read':
      key = `${input.file_path}#${input.offset ?? ''}`
      label = base(input.file_path)
      break
    case 'Edit':
      key = `${input.file_path}#${hash(String(input.old_string) + '→' + String(input.new_string))}`
      label = '改 ' + base(input.file_path)
      break
    case 'Write':
      key = `${input.file_path}#${hash(String(input.content))}`
      label = '写 ' + base(input.file_path)
      break
    case 'Grep':
    case 'Glob':
      key = `${input.pattern}@${input.path ?? ''}`
      label = String(input.pattern)
      break
    case 'WebSearch':
      key = squash(input.query)
      label = key
      break
    case 'WebFetch':
      key = String(input.url)
      label = String(input.url).replace(/^https?:\/\//, '')
      break
    case 'Agent':
    case 'Task':
      key = squash(input.prompt).slice(0, 300)
      label = squash(input.description) || '子任务'
      break
    case 'Skill':
      key = `${input.skill}:${input.args ?? ''}`
      label = String(input.skill)
      break
    default:
      key = sortedJson(input).slice(0, 400)
      label = squash(Object.values(input).find(v => typeof v === 'string') ?? '')
  }
  const short = tool.startsWith('mcp__') ? tool.split('__').slice(1).join('.') : tool
  return { fp: tool + ':' + hash(key), label: cut(redact(`${short} ${label}`.trim()), 70) }
}

// 错误文本去掉数字、路径、id，让「同一个错误」能对上
export function normError(text: string): string {
  return text
    .slice(0, 400)
    .toLowerCase()
    .replace(/\/[^\s'"`:]+/g, p => base(p))
    .replace(/0x[0-9a-f]+|[0-9a-f]{8,}/g, 'H')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

export function makeStep(
  n: number,
  tool: string,
  input: Record<string, unknown>,
  isError: boolean,
  text: string,
): Step {
  const { fp, label } = fingerprint(tool, input)
  const err = isError ? normError(text) : ''
  return {
    n,
    tool,
    label,
    fp,
    isError,
    errSig: isError ? hash(err) : '',
    errText: isError ? cut(squash(redact(text)), 80) : '',
    resSig: isError ? 'E' + hash(err) : 'O' + hash(text.slice(0, 2000)),
    tags: isError ? ['报错'] : [],
  }
}

export function currentItem(plan: readonly PlanItem[]): PlanItem | undefined {
  return plan.find(p => p.status === 'in_progress') ?? plan.find(p => p.status === 'pending')
}

// 最近「推进」或「主动改计划」的那一步，之前的都不算进卡住
const anchor = (b: Board) => Math.max(b.lastProgress, b.lastPlanChange)

export function compute(b: Board): Board {
  const start = Math.max(b.stepCount - WINDOW, b.lastProgress)
  const win = b.steps.filter(s => s.n > start)
  const latest = win.at(-1)
  const found: Signal[] = []

  if (latest) {
    const same = win.filter(s => s.fp === latest.fp && s.resSig === latest.resSig).length
    if (same >= 3) {
      found.push({
        key: 'same:' + latest.fp,
        kind: 'same',
        hits: same,
        points: same >= 6 ? 70 : same === 5 ? 60 : same === 4 ? 45 : 25,
        text: `同一个动作、同一个结果已经 ${same} 次（${latest.label}）`,
      })
    }

    const errs = new Map<string, Step[]>()
    for (const s of win) if (s.isError) errs.set(s.errSig, [...(errs.get(s.errSig) ?? []), s])
    let worst: Step[] = []
    for (const list of errs.values()) if (list.length > worst.length) worst = list
    if (worst.length >= 2) {
      const c = worst.length
      found.push({
        key: 'err:' + worst[0]!.errSig,
        kind: 'err',
        hits: c,
        points: c >= 5 ? 70 : c === 4 ? 60 : c === 3 ? 45 : 20,
        text: `同一个错误出现 ${c} 次：${worst.at(-1)!.errText}`,
      })
    }

    const a = latest.fp
    const bfp = win.at(-2)?.fp
    if (bfp && bfp !== a) {
      let len = 0
      for (let i = win.length - 1; i >= 0; i--) {
        const want = (win.length - 1 - i) % 2 === 0 ? a : bfp
        if (win[i]!.fp !== want) break
        len++
      }
      const rounds = Math.floor(len / 2)
      if (rounds >= 3) {
        const other = win.at(-2)!
        found.push({
          key: 'pp:' + [a, bfp].sort().join('|'),
          kind: 'pingpong',
          hits: rounds,
          points: rounds >= 4 ? 60 : 45,
          text: `两个动作来回切换 ${rounds} 轮（${latest.label} ⇄ ${other.label}）`,
        })
      }
    }

    const last8 = win.slice(-8)
    const failed = last8.filter(s => s.isError).length
    if (last8.length >= 6 && failed >= 5) {
      found.push({ key: 'errrate', kind: 'errrate', hits: failed, points: 25, text: `最近 ${last8.length} 步有 ${failed} 步报错` })
    }
  }

  const cur = currentItem(b.plan)
  const fresh = b.judge !== null && b.judge.step >= b.stepCount - 3
  if (cur && !b.taskDone) {
    const n = b.stepCount - anchor(b)
    if (n >= 6) {
      let points = Math.min(45, 15 + (n - 6) * 5)
      if (fresh && b.judge!.verdict === '贴合') points = Math.round(points / 2)
      found.push({ key: 'stall:' + cur.id, kind: 'stall', hits: n, points, text: `计划「${cut(cur.text, 30)}」已经 ${n} 步没推进` })
    }
  }

  if (b.judge && b.judge.step >= b.stepCount - RECHECK && b.judge.verdict !== '贴合') {
    const isOff = b.judge.verdict === '离题'
    found.push({
      key: 'off',
      kind: 'offtopic',
      hits: b.judge.step,
      points: isOff ? 35 : 10,
      text: isOff ? '最近几步跟目标关系不大（模型判断：离题）' : '最近几步在走支线（模型判断）',
    })
  }

  const signals = found.filter(s => !b.muted.includes(s.key)).sort((x, y) => y.points - x.points)
  const pick = (kinds: string[]) => Math.max(0, ...signals.filter(s => kinds.includes(s.kind)).map(s => s.points))
  const loop = pick(['same', 'err', 'pingpong'])
  const score = Math.min(100, loop + pick(['stall']) + pick(['offtopic']) + (loop === 0 ? pick(['errrate']) : 0))

  return { ...b, signals, score }
}

// 记一步实际动作，并给它打标签
export function recordStep(b: Board, step: Step): Board {
  const prevSame = [...b.steps].reverse().find(s => s.fp === step.fp)
  const isFix = !step.isError && prevSame?.isError === true
  const tags: StepTag[] = [...step.tags]
  if (b.steps.filter(s => s.n > b.lastProgress && s.fp === step.fp).length >= 1 && !isFix) tags.push('重复')
  if (isFix) tags.push('推进')
  const next: Board = {
    ...b,
    stepCount: step.n,
    steps: [...b.steps, { ...step, tags, at: currentItem(b.plan)?.id }].slice(-KEEP),
    lastProgress: isFix ? step.n : b.lastProgress,
  }
  return compute(isFix ? settle(next, 'progress') : next)
}

// 计划更新：区分「推进」（状态往前走）和「改计划」（增删改条目）
export function applyPlan(b: Board, plan: PlanItem[]): Board {
  const before = new Map(b.plan.map(p => [p.id, p]))
  const sameItems = plan.length === b.plan.length && plan.every(p => before.get(p.id)?.text === p.text)
  const progressed = plan.some(p => {
    const old = before.get(p.id)
    return p.status === 'completed' ? old?.status !== 'completed' : p.status === 'in_progress' && old?.status !== 'in_progress'
  })
  const allDone = plan.length > 0 && plan.every(p => p.status === 'completed')
  let next: Board = {
    ...b,
    plan,
    taskDone: allDone,
    lastProgress: progressed ? b.stepCount : b.lastProgress,
    lastPlanChange: sameItems ? b.lastPlanChange : b.stepCount,
  }
  if (progressed || !sameItems) next = settle(next, 'progress')
  if (progressed && next.steps.length > 0) {
    const last = next.steps.at(-1)!
    if (!last.tags.includes('推进')) next = { ...next, steps: [...next.steps.slice(0, -1), { ...last, tags: [...last.tags, '推进'] }] }
  }
  return compute(next)
}

// 结束一次提醒：回到主线（recovered）或被判误报
export function settle(b: Board, why: 'progress' | 'expired' | 'false-alarm'): Board {
  if (!b.warning && !b.pause) return b
  const stats = { ...b.stats }
  if (b.warning && why !== 'false-alarm') stats.recovered++
  if (why === 'false-alarm') stats.falseAlarm++
  const key = b.warning?.key ?? b.pause?.key
  return {
    ...(why === 'progress' ? closeDrift(b, '之后回到正轨') : b),
    stats,
    warning: null,
    pause: null,
    mustExplain: null,
    muted: why === 'false-alarm' && key ? [...b.muted, key] : b.muted,
  }
}

export function withJudge(b: Board, verdict: Verdict): Board {
  const steps = b.steps.map(s =>
    s.n > b.stepCount - RECHECK && verdict !== '贴合' && !s.tags.includes(verdict) ? { ...s, tags: [...s.tags, verdict] } : s,
  )
  return compute({ ...b, steps, judge: { verdict, step: b.stepCount }, stats: { ...b.stats, judged: b.stats.judged + 1 } })
}

export type Action = { type: 'warn'; signal: Signal } | { type: 'repeat'; signal: Signal; warning: Warning } | null

// 两级提醒：第一次提醒；提醒后 5 步内同一个问题又出现 = 再犯
export function escalate(b: Board): { board: Board; action: Action } {
  let board = b
  const w = board.warning
  if (w) {
    const now = board.signals.find(s => s.key === w.key)
    const age = board.stepCount - w.step
    const again =
      now !== undefined &&
      (w.kind === 'stall' ? age >= RECHECK : w.kind === 'offtopic' ? now.hits > w.hits : now.hits > w.hits)
    if (again && age <= RECHECK) {
      board = { ...board, warning: null, stats: { ...board.stats, repeated: board.stats.repeated + 1 } }
      return { board, action: { type: 'repeat', signal: now, warning: w } }
    }
    if (age >= RECHECK) board = settle(board, 'expired')
    else return { board, action: null }
  }
  if (board.pause || board.score < WARN_AT) return { board, action: null }
  const top = board.signals[0]
  if (!top) return { board, action: null }
  const warning: Warning = { key: top.key, kind: top.kind, step: board.stepCount, hits: top.hits, text: top.text }
  return { board: { ...board, warning, stats: { ...board.stats, warned: board.stats.warned + 1 } }, action: { type: 'warn', signal: top } }
}

export function level(score: number): { name: string; color: 'success' | 'warning' | 'error' } {
  if (score >= DRIFT_AT) return { name: '偏航', color: 'error' }
  if (score >= WARN_AT) return { name: '注意', color: 'warning' }
  return { name: '正常', color: 'success' }
}

// 可疑时才问模型：分数到注意线，或者已经 6 步没推进；且距上次判断至少 5 步
export function shouldJudge(b: Board): boolean {
  if (!b.goal || b.steps.length < 3) return false
  if (b.judge && b.stepCount - b.judge.step < RECHECK) return false
  const stalled = currentItem(b.plan) !== undefined && b.stepCount - anchor(b) >= 6
  return b.score >= WARN_AT || stalled
}

export function judgeText(b: Board): string {
  b = redactBoard(b)
  const cur = currentItem(b.plan)
  const recent = b.steps.slice(-6).map(s => `- ${s.label}${s.isError ? `（报错：${s.errText}）` : ''}`)
  return [
    `任务目标：${cut(b.goal, 400)}`,
    b.extras.length ? `后来补充：${b.extras.map(x => cut(x, 120)).join('；')}` : '',
    `当前计划步骤：${cur ? cur.text : '（没有计划）'}`,
    `最近几步实际动作：`,
    ...recent,
    `问题：最近这几步对完成任务目标来说属于哪一类？on-track = 直接推进目标或当前计划步骤；side-quest = 为了目标必须先解决的旁支问题；off-track = 跟目标无关或在原地打转。`,
  ]
    .filter(Boolean)
    .join('\n')
}

export const VERDICTS: Record<string, Verdict> = { 'on-track': '贴合', 'side-quest': '支线', 'off-track': '离题' }

export function reminder(b: Board, text: string, strong: boolean): string {
  b = redactBoard(b)
  text = redact(text)
  const cur = currentItem(b.plan)
  return [
    `【偏航观测${strong ? '·再次提醒' : ''}】第 ${b.stepCount} 步：${text}。偏航指数 ${b.score}。`,
    `任务目标：${cut(b.goal || '（未记录）', 300)}`,
    `当前计划步骤：${cur ? cur.text : '（没有待办清单）'}`,
    strong
      ? '上次提醒后同一个问题又出现了。停止用同样的方法重试：先用一两句话说清卡在哪，换一个思路，或者回到当前计划步骤。'
      : '先停一下对照目标：如果这是必要的支线，就把它写进待办清单；如果在原地打转，换个思路或回到当前计划步骤，不要用同样的方法再试。',
  ].join('\n')
}

// ---------- 小条上的总目标 / 阶段目标 / 预估完成度 ----------
// 目标、补充、待办变了，或又做了 EST_EVERY 步，才让小模型重估一次
export const EST_EVERY = 8
export const estKey = (b: Board) => hash([b.goal, ...b.extras, ...b.plan.map(p => p.status + p.text)].join('\n'))
// 小条两格放得下的字数（暂停时最窄）；模型常常不守字数，超了就让它重写一次
export const GOAL_MAX = 12
export const STAGE_MAX = 10
export const tooLong = (e: { goal: string; stage: string }) => [...e.goal].length > GOAL_MAX || [...e.stage].length > STAGE_MAX
export const fitEst = (e: Est): Est => ({ ...e, goal: cut(e.goal, GOAL_MAX), stage: cut(e.stage, STAGE_MAX) })
export const shortenText = (b: Board, e: Est) =>
  `${estimateText(b)}\n\n你刚才写的太长了：goal「${redact(e.goal)}」${[...e.goal].length} 字，stage「${redact(e.stage)}」${[...e.stage].length} 字。goal 必须 ≤${GOAL_MAX} 字、stage 必须 ≤${STAGE_MAX} 字，只留最核心的意思，重新输出 JSON。`

export function shouldEstimate(b: Board): boolean {
  if (!b.goal) return false
  if (!b.est || tooLong(b.est)) return true
  return b.est.key !== estKey(b) || b.stepCount - b.est.step >= EST_EVERY
}

const PLAN_MARK = { completed: '✓ 已完成', in_progress: '▸ 正在做', pending: '○ 没开始' } as const
export function estimateText(b: Board): string {
  b = redactBoard(b)
  const recent = b.steps.slice(-10).map(s => `- ${s.label}${s.isError ? '（报错）' : ''}`)
  return [
    '你在给一个编程助手的任务进度写简报。根据下面的材料，只输出一行 JSON，不要任何别的文字：',
    '{"goal":"…","stage":"…","total":数字,"stage_pct":数字,"change":"…"}',
    '- 所有文字一律用中文写给不懂技术的人看；英文名词、代码名能换成中文说法就换，不要整句英文。',
    `- goal：用户现在整体要做成什么，只写最核心的那件事，严格不超过 ${GOAL_MAX} 个字（宁短勿长）。不要逗号、不要「并」连两件事、不要「确认…是否」这类套话。例（别的任务的写法，不要照抄）：「整理照片人脸归类」「上线个人网站」。以用户最新的明确要求为准；只是确认、追问、小补充时保留原来的大目标。`,
    `- stage：现在正在做的这一步，严格不超过 ${STAGE_MAX} 个字，同样不要逗号。例：「核对封面字体」「补登录测试」。有待办清单就概括「正在做」那条，没有就从最近动作推断。`,
    '- total：整体目标预估完成了百分之几（0–100 的整数）。stage_pct：当前阶段预估完成了百分之几。拿不准时宁低勿高。',
    '- change：只有用户的补充让总目标真的变了（范围变大、换了要求）才填，用不超过 16 个字说变了什么；否则填空字符串。',
    '',
    `用户最开始的任务：${cut(b.goal, 400)}`,
    b.extras.length ? `后来的补充（按时间）：\n${b.extras.map(x => `- ${cut(x, 160)}`).join('\n')}` : '',
    b.est && [...b.est.goal].length <= GOAL_MAX ? `上次概括的总目标：${b.est.goal}（没有明确换任务就尽量保持一致）` : '',
    b.plan.length ? `待办清单：\n${b.plan.map(p => `${PLAN_MARK[p.status]}：${cut(p.text, 80)}`).join('\n')}` : '待办清单：（没有）',
    recent.length ? `最近的动作：\n${recent.join('\n')}` : '最近的动作：（还没开始）',
  ]
    .filter(Boolean)
    .join('\n')
}

const pct = (x: unknown) => (typeof x === 'number' && isFinite(x) ? Math.max(0, Math.min(100, Math.round(x))) : null)
export function parseEstimate(text: string, b: Board): Est | null {
  try {
    const o = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? '') as Record<string, unknown>
    const goal = String(o.goal ?? '').trim()
    const total = pct(o.total)
    if (!goal || total === null) return null
    const change = cut(String(o.change ?? '').trim(), 20)
    return { goal: cut(goal, 40), stage: cut(String(o.stage ?? '').trim(), 40), total, stagePct: pct(o.stage_pct) ?? 0, step: b.stepCount, key: estKey(b), change }
  } catch {
    return null
  }
}

// 模型没估出来时的退路：总目标用原话，阶段用正在做的待办，总完成度按待办完成比例
export function brief(b: Board): { goal: string; stage: string; total: number | null; stagePct: number | null; byModel: boolean } {
  const cur = currentItem(b.plan)
  if (b.est) {
    // 待办变了但还没重估：阶段文字先跟上清单
    const stale = b.est.key !== estKey(b)
    return { goal: b.est.goal, stage: stale && cur ? cut(cur.text, STAGE_MAX) : b.est.stage, total: b.est.total, stagePct: stale && cur ? null : b.est.stagePct, byModel: true }
  }
  const done = b.plan.filter(p => p.status === 'completed').length
  return { goal: b.goal, stage: cur?.text ?? '', total: b.plan.length ? Math.round((done / b.plan.length) * 100) : null, stagePct: null, byModel: false }
}

// 记下新估计；总目标因你的补充变了，就记成新的一版
export function withEst(b: Board, est: Est): Board {
  const goals: GoalVer[] = b.goals ?? []
  const last = goals.at(-1)
  if (!last) return { ...b, est, goals: [{ v: 1, text: est.goal, why: '', step: est.step }] }
  if (est.change && est.goal !== last.text) return { ...b, est, goals: [...goals, { v: last.v + 1, text: est.goal, why: est.change, step: est.step }].slice(-6) }
  return { ...b, est }
}

// ---------- 航迹图：每一步的偏离角 ----------
// 小模型每攒几步统一判一次；判出来之前先按规则标签临时估，只会往「做多了」那边偏
export const ANG_EVERY = 4
export const NORMAL_DEG = 15
export const SEVERE_DEG = 40
const FLAGGED: StepTag[] = ['重复', '报错', '支线', '离题']
export const unjudged = (b: Board) => b.steps.filter(s => s.deg === undefined)
export function shouldAngle(b: Board): boolean {
  if (!b.goal) return false
  const left = unjudged(b)
  return left.length >= ANG_EVERY || left.some(s => s.tags.some(t => FLAGGED.includes(t)))
}

export function guessDeg(s: Step, steps: readonly Step[]): number {
  if (s.tags.includes('离题')) return 50
  if (s.tags.includes('重复')) {
    // 连着重复几次，角度一次比一次大
    let run = 0
    for (let i = steps.indexOf(s); i >= 0 && steps[i]!.tags.includes('重复'); i--) run++
    return Math.min(70, 18 + 12 * Math.max(0, run - 1))
  }
  if (s.tags.includes('支线')) return 25
  if (s.tags.includes('报错')) return 8
  return 0
}
export const degOf = (s: Step, steps: readonly Step[]) => s.deg ?? guessDeg(s, steps)

export function angleText(b: Board): string {
  b = redactBoard(b)
  const todo = unjudged(b).slice(-12)
  const before = b.steps.filter(s => s.deg !== undefined).slice(-4)
  const line = (s: Step) => `${s.n}. ${s.label}${s.isError ? `（报错：${cut(s.errText, 50)}）` : ''}${s.tags.length ? ` [${s.tags.join('、')}]` : ''}`
  return [
    '你在给编程助手的每一步打「偏离角」：这一步相对用户的目标，方向偏了多少度。只输出一个 JSON 数组，不要任何别的文字：',
    '[{"n":步号,"deg":整数,"why":"…"}]',
    '- deg 在 -80 到 80 之间。0 = 正对目标推进（读相关代码、改该改的、跑测试验证都算 0–10）。',
    '- 正数 = 做多了：去做目标之外的事、范围变大、用同一招反复重试。负数 = 做少了：偷工、跳过该做的验证、降低标准、绕开问题。',
    '- 15 以内算正常；15–40 中度；40 以上严重。拿不准就往 0 靠，别夸大。',
    '- why：|deg| ≥ 15 时用不超过 14 个字的中文说偏在哪，否则填空字符串。',
    '',
    `用户的目标：${cut(b.est?.goal || b.goal, 300)}`,
    b.extras.length ? `用户后来的补充：${b.extras.slice(-3).map(x => cut(x, 100)).join(' / ')}` : '',
    b.plan.length ? `待办清单：\n${b.plan.map(p => `${PLAN_MARK[p.status]}：${cut(p.text, 60)}`).join('\n')}` : '',
    before.length ? `前面几步（已判，供参考）：\n${before.map(s => `${line(s)} → ${s.deg}°`).join('\n')}` : '',
    `要判的步骤：\n${todo.map(line).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n')
}

export function parseAngles(text: string): Map<number, { deg: number; why: string }> {
  const out = new Map<number, { deg: number; why: string }>()
  try {
    const arr = JSON.parse(/\[[\s\S]*\]/.exec(text)?.[0] ?? '') as unknown[]
    for (const x of arr) {
      const o = x as Record<string, unknown>
      const n = Number(o.n), deg = Number(o.deg)
      if (!Number.isInteger(n) || !isFinite(deg)) continue
      const d = Math.max(-80, Math.min(80, Math.round(deg)))
      out.set(n, { deg: d, why: Math.abs(d) >= NORMAL_DEG ? cut(String(o.why ?? '').trim(), 16) : '' })
    }
  } catch {
    // 读不出就当这批没判
  }
  return out
}

// 只填这一批要判的；模型漏掉的步骤按规则补上，免得下一轮一直重判
export function withAngles(b: Board, got: Map<number, { deg: number; why: string }>, asked: readonly number[]): Board {
  const ask = new Set(asked)
  return { ...b, steps: b.steps.map(s => (ask.has(s.n) && s.deg === undefined ? { ...s, ...(got.get(s.n) ?? { deg: guessDeg(s, b.steps), why: '' }) } : s)) }
}

// ---------- 跑偏记录 ----------
export function addDrift(b: Board, d: Omit<Drift, 'outcome'>): Board {
  return { ...b, drifts: [...(b.drifts ?? []), { ...d, outcome: '' }].slice(-20) }
}
// 你处理了暂停 / 提醒：把结果记在最近一条还没结果的记录上
export function closeDrift(b: Board, outcome: string): Board {
  const ds = [...(b.drifts ?? [])]
  for (let i = ds.length - 1; i >= 0; i--) if (!ds[i]!.outcome) return { ...b, drifts: ds.map((d, j) => (j === i ? { ...d, outcome } : d)) }
  return b
}
