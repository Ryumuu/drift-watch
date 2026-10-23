export type PlanStatus = 'pending' | 'in_progress' | 'completed'
export type PlanItem = { id: string; text: string; status: PlanStatus }

export type StepTag = '推进' | '重复' | '报错' | '支线' | '离题'
export type Step = {
  n: number
  tool: string
  label: string
  fp: string
  isError: boolean
  errSig: string
  errText: string
  resSig: string
  tags: StepTag[]
  at?: string // 这一步发生时正在做的计划步骤
  t?: number // 发生时间（毫秒）
  deg?: number // 小模型判的偏离角：正 = 做多了（右），负 = 做少了（左），0 = 正对目标
  why?: string // 偏了 15° 以上时的一句原因
  file?: string // 改/写文件的那一步：完整路径（航行日志「改过的文件」用）
}

export type Verdict = '贴合' | '支线' | '离题'
export type SignalKind = 'same' | 'err' | 'pingpong' | 'stall' | 'offtopic' | 'errrate'
export type Signal = { key: string; kind: SignalKind; points: number; hits: number; text: string }
export type Warning = { key: string; kind: SignalKind; step: number; hits: number; text: string }
export type Pause = { key: string; text: string; step: number }

export type Stats = {
  warned: number
  recovered: number
  repeated: number
  judged: number
  falseAlarm: number
}

// 小条上的四个数：模型概括的总目标 / 阶段目标，和两者的预估完成度（0–100）
export type Est = { goal: string; stage: string; total: number; stagePct: number; step: number; key: string; change?: string }
// 目标的版本：模型概括的总目标因你的补充变了，就记一版
export type GoalVer = { v: number; text: string; why: string; step: number }
// 跑偏记录：每次提醒 / 暂停，以及你后来怎么处理的
export type Drift = { step: number; level: 'warn' | 'pause'; text: string; t: number; outcome: string }

// 点「让它换个思路」后怎么交接的：nested = 嵌套侧会话已开；card = 已出卡片等你点一下；same = 退回原会话
export type Handoff = { t: number; via: 'nested' | 'card' | 'same'; name: string; sessionId?: string; note: string }

export type Board = {
  task: number
  goal: string
  extras: string[]
  plan: PlanItem[]
  steps: Step[]
  stepCount: number
  lastProgress: number
  lastPlanChange: number
  taskDone: boolean
  score: number
  signals: Signal[]
  warning: Warning | null
  pause: Pause | null
  mustExplain: string | null
  muted: string[]
  judge: { verdict: Verdict; step: number } | null
  stats: Stats
  turnId: string | null
  est: Est | null
  goals: GoalVer[]
  drifts: Drift[]
  files?: string[] // 这个任务里改/写过的文件（完整路径，去重，最多 60 个）
  logPath?: string // 航行日志文件的路径，一个任务一份
  handoff?: Handoff // 最近一次交接结果；小条/面板可据此显示「已交接给 xxx」
  gen?: number // 0 或没有 = 原会话；1 = 交接后接手的会话（不再开第二层）
  handoffKey?: string // 接手会话：交接时卡住的那个信号 key，又在它上面打转就不再交接、只通知你
}

declare module 'claude-code' {
  interface PluginState {
    'drift-watch': { board: Board; open: boolean | string }
  }
}
