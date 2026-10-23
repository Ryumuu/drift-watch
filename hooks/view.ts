import type { Board, PlanStatus, SignalKind, Step } from '../types'
import { RECHECK, WARN_AT, currentItem } from './analyze'

// 画面只回答一件事：要不要你出手。按苹果 HIG：结论 + 一句人话放最上，颜色只给状态图标，其余折叠。

export type Tone = 'success' | 'warning' | 'error' | undefined
export type Kind = 'ok' | 'warn' | 'pause'
const KIND_TONE: Record<Kind, Tone> = { ok: 'success', warn: 'warning', pause: 'error' }
export const toneOf = (k: Kind) => KIND_TONE[k]
export const ICON: Record<Kind, string> = { ok: '✓', warn: '!', pause: '❚❚' }

const mark: Record<PlanStatus, string> = { completed: '✓', in_progress: '▸', pending: '○' }

// 把规则信号翻成大白话：只说发生了什么，不带工具名和报错原文
export function say(kind: SignalKind | string, hits: number): string {
  switch (kind) {
    case 'same':
      return `同一个操作做了 ${hits} 次，结果都一样`
    case 'err':
      return `同一个错误出现了 ${hits} 次`
    case 'pingpong':
      return `在两个操作之间来回切换了 ${hits} 轮`
    case 'errrate':
      return `最近几次操作里有 ${hits} 次报错`
    case 'stall':
      return `当前这一步做了 ${hits} 次操作还没完成`
    case 'offtopic':
      return '最近的操作和你的任务关系不大'
    default:
      return '最近几步在原地打转'
  }
}
const sayKey = (key: string, text: string) => say(key.split(':')[0] ?? '', Number(/(\d+)/.exec(text)?.[1] ?? 0))

export type View = {
  kind: Kind
  title: string
  reason: string
  step?: { i: number; n: number; done: number; text: string }
  ops: number
  errors: number
}

export function view(b: Board, mode: string): View {
  const cur = currentItem(b.plan)
  const mine = cur ? b.steps.filter(s => s.at === cur.id) : b.steps
  const base = {
    step: cur ? { i: b.plan.indexOf(cur) + 1, n: b.plan.length, done: b.plan.filter(p => p.status === 'completed').length, text: cur.text } : undefined,
    ops: cur ? mine.length : b.stepCount,
    errors: mine.filter(s => s.isError).length,
  }
  if (b.pause) {
    return { ...base, kind: 'pause', title: '跑偏了，已暂停', reason: `提醒过 Claude，但问题还在：${sayKey(b.pause.key, b.pause.text)}。它已经停下，你来选下一步。` }
  }
  if (b.warning) {
    const left = Math.max(1, RECHECK - (b.stepCount - b.warning.step))
    const then = mode === 'pause' ? '暂停等你' : mode === 'block' ? '拦下来让它先解释' : '再提醒它一次'
    return { ...base, kind: 'warn', title: '有点跑偏', reason: `${say(b.warning.kind, b.warning.hits)}。已经提醒 Claude 换个做法；接下来 ${left} 次操作里还这样，就${then}。` }
  }
  const sig = b.signals[0]
  if (b.score >= WARN_AT && sig) return { ...base, kind: 'warn', title: '有点跑偏', reason: `${say(sig.kind, sig.hits)}。` }
  const reason = cur
    ? `Claude 在做第 ${base.step!.i} 步，没有重复或反复报错。`
    : b.stepCount === 0
      ? '已记下你的任务，等 Claude 开始。'
      : `Claude 做了 ${b.stepCount} 次操作，没有重复或反复报错。`
  return { ...base, kind: 'ok', title: '没跑偏', reason }
}

// 偏离度：三格刻度，低 / 中 / 高，和结论词一一对应
export const LEVEL: Record<Kind, { n: number; name: string }> = { ok: { n: 1, name: '低' }, warn: { n: 2, name: '中' }, pause: { n: 3, name: '高' } }
export const meterText = (k: Kind) => `偏离度 ${'■'.repeat(LEVEL[k].n)}${'□'.repeat(3 - LEVEL[k].n)} ${LEVEL[k].name}`

// 输入框上方那一行：结论词 + 偏离度 + 一句依据
export function bandText(b: Board, v: View): { main: string; sub: string } {
  const why = b.pause ? sayKey(b.pause.key, b.pause.text) : b.warning ? say(b.warning.kind, b.warning.hits) : b.signals[0] ? say(b.signals[0].kind, b.signals[0].hits) : ''
  if (v.kind === 'pause') return { main: '跑偏了，已暂停', sub: `${why}，等你决定` }
  if (v.kind === 'warn') return { main: '有点跑偏', sub: b.warning ? `${why}，已提醒 Claude` : why }
  const doing = v.step ? `正在做第 ${v.step.i}/${v.step.n} 步：${v.step.text}` : `围绕你的任务：${b.goal}`
  return { main: '没跑偏', sub: doing }
}

// ---------- 详情里用：每个计划步骤下挂着做它时的每次操作 ----------

export const STRIP_MAX = 40
export const LEGEND: { name: string; color: Tone }[] = [
  { name: '完成', color: 'success' },
  { name: '普通', color: undefined },
  { name: '重复', color: 'warning' },
  { name: '报错', color: 'error' },
]

export function tone(s: Step): Tone {
  if (s.tags.includes('报错') || s.tags.includes('离题')) return 'error'
  if (s.tags.includes('重复') || s.tags.includes('支线')) return 'warning'
  if (s.tags.includes('推进')) return 'success'
  return undefined
}

export function runs(steps: readonly Step[]): { color: Tone; n: number }[] {
  const out: { color: Tone; n: number }[] = []
  for (const s of steps) {
    const c = tone(s)
    const last = out.at(-1)
    if (last && last.color === c) last.n++
    else out.push({ color: c, n: 1 })
  }
  return out
}

export function lanes(b: Board) {
  const cur = currentItem(b.plan)
  const ids = new Set(b.plan.map(p => p.id))
  const loose = b.steps.filter(s => !s.at || !ids.has(s.at))
  const out: { mark: string; text: string; current: boolean; steps: Step[] }[] = []
  if (b.plan.length === 0) return [{ mark: '·', text: 'Claude 没列步骤清单', current: false, steps: loose }]
  if (loose.length) out.push({ mark: '·', text: '列清单之前', current: false, steps: loose })
  for (const p of b.plan) out.push({ mark: mark[p.status], text: p.text, current: p === cur, steps: b.steps.filter(s => s.at === p.id) })
  return out
}

// ---------- 桌面版：自己画，才能用系统字体和字号层级 ----------

const FONT = `-apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC','Helvetica Neue',sans-serif`
// 状态色（浅 / 深）：摩卡柔和色板，深色用 Catppuccin Mocha、浅色用同系列的 Latte。
// 使用柔和的状态色减轻视觉干扰：正常为薄荷绿、注意为蜜桃色、偏航或出错为玫红。
const SYS = {
  success: ['#40a02b', '#a6e3a1'],
  warning: ['#fe640b', '#fab387'],
  error: ['#d20f39', '#f38ba8'],
} as const
const MOCHA = { blue: ['#1e66f5', '#89b4fa'], norm: ['#7c7f93', '#9399b2'], onFill: ['#ffffff', '#1e1e2e'] } as const
// 正向进度采用「摩卡日落 · 由暗到亮」，用亮度和暖色表达接近完成。
// 已填部分从暗紫走到当前进度对应的颜色，越接近完成越亮越暖；75% 起加同色光晕，100% 最亮。
// 额度、用量这类越满越危险的条不用它。深色取 Catppuccin Mocha，浅色同色相压深一档，白底上也看得清。
export const PROGRESS = {
  dark: ['#6f5f8a', '#a67fb5', '#e08aa0', '#fab387', '#f9e2af'],
  light: ['#8a7aa8', '#a06cc0', '#d65a7e', '#ef7a35', '#d9901a'],
} as const
const PTRACK = { dark: '#45475a', light: '#ccd0da' }
const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const lerp = (stops: readonly string[], x: number) => {
  const p = Math.max(0, Math.min(1, x)) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(p)), f = p - k
  const a = hex(stops[k]!), b = hex(stops[k + 1]!)
  return '#' + a.map((v, j) => Math.round(v + (b[j]! - v) * f).toString(16).padStart(2, '0')).join('')
}
// 进度 x（0–1）对应的颜色；终端里没法分深浅，默认用深色那套
export const progColor = (x: number, theme: 'dark' | 'light' = 'dark') => lerp(PROGRESS[theme], x)
const CSS = `
  svg{--ink:#1d1d1f;--sub:#6e6e73;--faint:#aeaeb2;--line:#d2d2d7;--norm:${MOCHA.norm[0]};--soft:#e5e5ea;--card:#f5f5f7;--bg:#ffffff;
    --ok:${SYS.success[0]};--warn:${SYS.warning[0]};--err:${SYS.error[0]};--blue:${MOCHA.blue[0]};--ptrack:${PTRACK.light}}
  text{font-family:${FONT}}
  .l1{fill:#1d1d1f}.l2{fill:#6e6e73}.track{fill:#78788033}.bar{fill:#8e8e93}
  .success{fill:${SYS.success[0]}}.warning{fill:${SYS.warning[0]}}.error{fill:${SYS.error[0]}}.glyph{fill:${MOCHA.onFill[0]};stroke:${MOCHA.onFill[0]}}
  @media (prefers-color-scheme: dark){
    svg{--ink:#f5f5f7;--sub:#a1a1a6;--faint:#6e6e73;--line:#48484a;--norm:${MOCHA.norm[1]};--soft:#3a3a3c;--card:#2c2c2e;--bg:#262624;
      --ok:${SYS.success[1]};--warn:${SYS.warning[1]};--err:${SYS.error[1]};--blue:${MOCHA.blue[1]};--ptrack:${PTRACK.dark}}
    .l1{fill:#f5f5f7}.l2{fill:#a1a1a6}.track{fill:#7878805c}.bar{fill:#98989d}
    .success{fill:${SYS.success[1]}}.warning{fill:${SYS.warning[1]}}.error{fill:${SYS.error[1]}}.glyph{fill:${MOCHA.onFill[1]};stroke:${MOCHA.onFill[1]}}
  }`
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const charW = (ch: string, size: number) => (ch.charCodeAt(0) > 0x2e80 ? size : ch === ' ' ? size * 0.3 : ch === '%' ? size * 0.9 : size * 0.6)
// 下方用量条每个胶囊的左右端 [左, 右]：从它画的 SVG 里读，读不到就是空表
export function pillSpans(source: string) {
  const out: Record<string, [number, number]> = {}
  for (const m of source.matchAll(/<rect x="([\d.]+)" y="0" width="([\d.]+)"[^>]*class="pill (\w+)"/g)) out[m[3]!] = [Number(m[1]), Number(m[1]) + Number(m[2])]
  return out
}
export const textW = (s: string, size: number) => [...s].reduce((w, ch) => w + charW(ch, size), 0)

export function wrap(s: string, size: number, maxW: number, maxLines = 4): string[] {
  const lines: string[] = []
  let line = ''
  for (const ch of s) {
    // 逗号句号等不放行首，挂在上一行末尾
    if (textW(line + ch, size) > maxW && !'，。、；：！？）」』'.includes(ch)) {
      lines.push(line)
      line = ch.trimStart()
      if (lines.length === maxLines) break
    } else line += ch
  }
  if (lines.length < maxLines && line) lines.push(line)
  if (lines.length === maxLines && textW(lines.join(''), size) < textW(s, size) - 1) lines[maxLines - 1] = lines[maxLines - 1]!.slice(0, -1) + '…'
  return lines
}

export function icon(kind: Kind, cx: number, cy: number, r: number) {
  const g =
    kind === 'ok'
      ? `<path d="M${cx - r * 0.42} ${cy + r * 0.02}l${r * 0.3} ${r * 0.3} ${r * 0.56}-${r * 0.6}" class="glyph" style="fill:none" stroke-width="${r * 0.17}" stroke-linecap="round" stroke-linejoin="round"/>`
      : kind === 'warn'
        ? `<rect x="${cx - r * 0.09}" y="${cy - r * 0.5}" width="${r * 0.18}" height="${r * 0.6}" rx="${r * 0.09}" class="glyph"/><circle cx="${cx}" cy="${cy + r * 0.42}" r="${r * 0.11}" class="glyph"/>`
        : `<rect x="${cx - r * 0.34}" y="${cy - r * 0.42}" width="${r * 0.22}" height="${r * 0.84}" rx="${r * 0.06}" class="glyph"/><rect x="${cx + r * 0.12}" y="${cy - r * 0.42}" width="${r * 0.22}" height="${r * 0.84}" rx="${r * 0.06}" class="glyph"/>`
  return `<circle cx="${cx}" cy="${cy}" r="${r}" class="${toneOf(kind)}"/>${g}`
}

// 三格刻度：亮几格看偏离程度，颜色同状态图标
export function meter(kind: Kind, x: number, cy: number, size: number, ty = size * 0.36) {
  const lab = '偏离度'
  let body = `<text x="${x}" y="${cy + ty}" class="l2" style="font-size:${size}px">${lab}</text>`
  let cx = x + textW(lab, size) + 6
  const w = size * 1.1, h = size * 0.5
  for (let i = 0; i < 3; i++) {
    body += `<rect x="${cx}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${h / 2}" class="${i < LEVEL[kind].n ? toneOf(kind) : 'track'}"/>`
    cx += w + 2
  }
  body += `<text x="${cx + 4}" y="${cy + ty}" class="${toneOf(kind)}" style="font-size:${size}px;font-weight:600">${LEVEL[kind].name}</text>`
  return { body, width: cx + 4 + size - x }
}

export const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><style>${CSS}</style>${body}</svg>`

// 正向进度条（摩卡日落）：已填部分自己从暗紫渐变到「当前进度的颜色」，75% 起发光。
// 深浅两套颜色写进这张图自己的小样式表；id 在同一张图里要唯一，百分比文字用 fill:var(--<id>c) 就跟着变色
export function pbar(id: string, x: number, cy: number, w: number, h: number, pct: number) {
  const n = 6, p = Math.max(0, Math.min(100, pct)) / 100
  const rules = (t: 'dark' | 'light') =>
    Array.from({ length: n + 1 }, (_, k) => `#${id} .s${k}{stop-color:${progColor((p * k) / n, t)}}`).join('') + `svg{--${id}c:${progColor(p, t)}}`
  const glow = pct >= 75 ? (pct >= 100 ? 1 : ((pct - 75) / 25) * 0.6 + 0.35) : 0
  const fw = pct > 0 ? Math.max(h, (w * pct) / 100) : 0
  const y = cy - h / 2
  let out = `<style>${rules('light')}@media (prefers-color-scheme: dark){${rules('dark')}}</style>`
  out += `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">${Array.from({ length: n + 1 }, (_, k) => `<stop offset="${k / n}" class="s${k}"/>`).join('')}</linearGradient>`
  out += `<filter id="${id}f" x="-50%" y="-400%" width="200%" height="900%"><feGaussianBlur stdDeviation="3"/></filter></defs>`
  out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" style="fill:var(--ptrack);fill-opacity:.7"/>`
  if (fw) {
    const fill = (extra: string) => `<rect x="${x}" y="${y}" width="${fw}" height="${h}" rx="${h / 2}" fill="url(#${id})"${extra}/>`
    // 光晕：条外面套一圈「当前进度色」的单色光（等同 CSS box-shadow 0 0 6px），不是把渐变模糊一份
    if (glow) out += `<rect x="${x}" y="${y}" width="${fw}" height="${h}" rx="${h / 2}" style="fill:var(--${id}c)" filter="url(#${id}f)" opacity="${glow.toFixed(2)}"/>`
    out += fill('')
  }
  return out
}

// 面板上半：结论（大）+ 一句人话（正文）
export function svgHead(v: View, width: number) {
  const W = Math.max(220, Math.min(560, width))
  const lines = wrap(v.reason, 13, W - 4)
  let body = icon(v.kind, 13, 13, 12)
  body += `<text x="34" y="19" class="l1" style="font-size:17px;font-weight:600">${esc(v.title)}</text>`
  body += meter(v.kind, 34 + textW(v.title, 17) + 14, 13, 12).body
  lines.forEach((l, i) => (body += `<text x="0" y="${48 + i * 19}" class="l1" style="font-size:13px">${esc(l)}</text>`))
  const h = 48 + (lines.length - 1) * 19 + 6
  return { width: W, height: h, alt: `${v.title}，${meterText(v.kind)}。${v.reason}`, source: svg(W, h, body) }
}

// 阶段性目标：Claude 自己列的待办清单。太长时只留「刚完成的一步 + 正在做 + 后面几步」，其余折成一句
export type Stage = { state: 'done' | 'now' | 'todo'; text: string } | { state: 'fold'; text: string }
export function stages(b: Board, max = 7): Stage[] {
  const cur = currentItem(b.plan)
  const all: Stage[] = b.plan.map(p => ({ state: p === cur ? 'now' : p.status === 'completed' ? 'done' : 'todo', text: p.text }))
  if (all.length <= max) return all
  const at = Math.max(0, cur ? b.plan.indexOf(cur) : b.plan.findIndex(p => p.status !== 'completed'))
  const from = Math.max(0, at - 1)
  const to = Math.min(all.length, from + max - 2)
  const out: Stage[] = []
  if (from > 0) out.push({ state: 'fold', text: `前面 ${from} 步已完成` })
  out.push(...all.slice(from, to))
  if (to < all.length) out.push({ state: 'fold', text: `后面还有 ${all.length - to} 步` })
  return out
}
export const STAGE_MARK = { done: '✓', now: '▸', todo: '○', fold: '…' } as const
export const nowNote = (v: View) => `正在做 · 这一步 ${v.ops} 次操作`

// 面板中部：最初的目标 + 阶段性目标（逐条列出，标出正在做哪一步）
export function svgTask(b: Board, v: View, width: number) {
  const W = Math.max(220, Math.min(560, width))
  const label = (t: string, y: number, right = '') =>
    `<text x="0" y="${y}" style="font-size:11px;font-weight:600"><tspan class="l2">${t}</tspan>${right ? `<tspan class="l2" style="font-weight:400">　${right}</tspan>` : ''}</text>`
  let y = 12
  let body = label('最初的目标', y)
  for (const l of wrap(b.goal, 14, W, 3)) {
    y += 21
    body += `<text x="0" y="${y}" class="l1" style="font-size:14px;font-weight:600">${esc(l)}</text>`
  }
  if (b.extras.length) {
    y += 18
    body += `<text x="0" y="${y}" class="l2" style="font-size:11px">${esc(wrap(`你后来补充了 ${b.extras.length} 条，最近一条：${b.extras.at(-1)}`, 11, W, 1)[0] ?? '')}</text>`
  }

  y += 30
  const list = stages(b)
  const done = b.plan.filter(p => p.status === 'completed').length
  body += label('阶段性目标', y, list.length ? `已完成 ${done}/${b.plan.length}` : '')
  if (!list.length) {
    y += 19
    body += `<text x="0" y="${y}" class="l2" style="font-size:13px">Claude 这次没列阶段性目标，只能对照最初的目标看</text>`
    y += 17
    body += `<text x="0" y="${y}" style="font-size:11px"><tspan class="l2">一共做了 ${v.ops} 次操作</tspan>${v.errors ? `<tspan class="l2"> · </tspan><tspan class="error">${v.errors} 次报错</tspan>` : ''}</text>`
  }
  for (const st of list) {
    const now = st.state === 'now'
    const lines = wrap(st.text, 13, W - 22, now ? 3 : 1)
    y += now ? 24 : 21
    if (st.state === 'done') body += `<path d="M2 ${y - 4.5}l3 3 5.5-6" style="fill:none;stroke:#8e8e93" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
    else if (now) body += `<circle cx="6" cy="${y - 4.5}" r="4.5" class="${toneOf(v.kind)}"/>`
    else if (st.state === 'todo') body += `<circle cx="6" cy="${y - 4.5}" r="3.8" fill="none" style="stroke:#8e8e93" stroke-width="1.2"/>`
    lines.forEach((l, i) => {
      if (i) y += 18
      const cls = now ? 'l1' : 'l2'
      body += `<text x="20" y="${y}" class="${cls}" style="font-size:13px${now ? ';font-weight:600' : ''}">${esc(l)}</text>`
    })
    if (now) {
      y += 17
      body += `<text x="20" y="${y}" style="font-size:11px"><tspan class="l2">${nowNote(v)}</tspan>${v.errors ? `<tspan class="l2"> · </tspan><tspan class="error">${v.errors} 次报错</tspan>` : ''}</text>`
      y += 4
    }
  }
  const h = y + 6
  const alt = `最初的目标：${b.goal}。阶段性目标：${list.map(x => `${STAGE_MARK[x.state]}${x.text}`).join('；') || '没有'}`
  return { width: W, height: h, alt, source: svg(W, h, body) }
}

// 输入框上方的小条：图标 + 结论词 + 偏离度刻度 | 总目标 + 完成度 | 阶段目标 + 完成度
// 暂停时你要拿主意，总目标那格换成暂停原因
export type Brief = { goal: string; stage: string; total: number | null; stagePct: number | null; byModel: boolean }
export const pctText = (n: number | null) => (n === null ? '' : `${Math.round(n / 5) * 5}%`)
export const barText = (n: number | null) => (n === null ? '' : '▰'.repeat(Math.round(n / 25)) + '▱'.repeat(4 - Math.round(n / 25)))
export type Seg = { label: string; text: string; pct: number | null; tone?: Tone }
// 每块文字的上限（按汉字算，英文数字算半个多）：阶段 10、总目标 12、暂停原因 18
export const CAP = { 阶段: 10, 总目标: 12, 暂停原因: 18 } as Record<string, number>
// 按宽度截：超了留最后一格给「…」
export const fit = (s: string, n: number) => {
  // 地方连一个「…」都放不下就返回空；否则会一直截成「…」再截，死循环把整个插件卡掉
  let o = s
  while (o && textW(o, 1) > n) o = [...o].length <= 1 ? '' : [...o].slice(0, -2).join('') + '…'
  return o
}
// 小条的顺序：结论、偏离度、阶段挨在左边（眼下最要紧的），总目标（暂停时换成暂停原因）整块贴最右
export function bandSegs(kind: Kind, t: { main: string; sub: string }, br: Brief): Seg[] {
  const segs: Seg[] = []
  if (br.stage) segs.push({ label: '阶段', text: fit(br.stage, CAP.阶段!), pct: br.stagePct })
  if (kind === 'pause') segs.push({ label: '暂停原因', text: fit(t.sub, CAP.暂停原因!), pct: null, tone: 'error' })
  else segs.push({ label: '总目标', text: fit(br.goal, CAP.总目标!), pct: br.total })
  return segs
}

// 小条保持固定的区域比例，避免状态变化时布局跳动：
// - 左边状态块：对勾 + 结论一行，偏离度三格在下面一行，和对勾左边对齐；
// - 右边两个格子把剩下的整段撑满，阶段:总目标 = 40:60，总目标格贴最右；
// - 每格上面一行「标签 文字 …… 百分比」，下面进度条撑满整格；文字太长截成「…」；
// - 两个格子一直都在，宽度只跟窗口宽度走：没阶段/没进度就写「/」，暂停也不改宽度（暂停原因放到小条下面一行）；
// - 窗口太窄时先去掉总目标格，再去掉阶段格，保留下来的格子不因文字内容改变宽度。
// 按字形视觉中心对齐：圆心对汉字字面中心（基线 17 上 4.5）、圆左边对下行首笔（+0.5）；
// 第一行所有文字共基线 17；下行胶囊中心 30、字基线 33.9；竖线落整像素
// 细进度条采用 4px 厚度并配合较小字号，减少视觉拥挤；留白 6.5、汉字中心 = 字号×0.36
export const BAND = { h: 35, base: 16.1, icx: 9.2, icy: 11.6, r: 7.7, mcy: 26.5, mty: 3.78, bar: 26.5, sepY: 8, tx: 12, lab: 10.5, st: 12.5, mz: 10.5, pt: 12, bh: 4 }
const GAP = 24, STAGE_SHARE = 0.4, MIN_CELL = { 阶段: 90, 右: 130 }
const statusMain = (kind: Kind, main: string) => (kind === 'pause' ? '已暂停' : main)
const STX = BAND.icx + BAND.r + 6.5
const statusW = Math.max(STX + Math.max(...(['没跑偏', '有点跑偏', '已暂停'] as const).map(m => textW(m, BAND.st))), 1 + meter('ok', 0, 0, BAND.mz).width)
// padTo：整张图画到多宽（进度条右端仍在 maxW-6），右边留透明空位给「查看」，好让它也对齐下面的用量条
export function svgBand(kind: Kind, t: { main: string; sub: string }, br: Brief, maxW: number, padTo = 0, extra = '') {
  const L = BAND, H = L.h
  const main = statusMain(kind, t.main)
  let body = icon(kind, L.icx, L.icy, L.r)
  body += `<text x="${STX}" y="${L.base}" class="l1" style="font-size:${L.st}px;font-weight:600">${esc(main)}</text>`
  body += meter(kind, 1, L.mcy, L.mz, L.mty).body
  // 1px 宽的线以左边为准，中线要减 0.5 再取整，才落在间隔正中且不发虚
  const sep = (x: number) => `<rect x="${Math.round(x - 0.5)}" y="${L.sepY}" width="1" height="${H - L.sepY * 2}" class="track"/>`
  let left: Seg | undefined = { label: '阶段', text: br.stage || '/', pct: br.stage ? br.stagePct : null }
  let right: Seg | undefined = { label: '总目标', text: br.goal || '/', pct: br.total }
  const R = Math.max(maxW, 160) - 6
  const x0 = statusW + GAP
  const split = () => {
    const avail = R - x0 - (left && right ? GAP : 0)
    const lw = left ? (right ? Math.round(avail * STAGE_SHARE) : avail) : 0
    return { lw, rw: right ? avail - lw : 0 }
  }
  let { lw, rw } = split()
  if (right && left && (rw < MIN_CELL.右 || lw < MIN_CELL.阶段)) (right = undefined), ({ lw, rw } = split())
  if (left && lw < MIN_CELL.阶段) (left = undefined), ({ lw, rw } = split())
  // 一个格子：上面「标签 文字 …… 百分比」，下面进度条撑满整格；没有进度时百分比写「/」、条留空槽
  const cell = (sg: Seg, id: string, x: number, w: number) => {
    const lab = `<text x="${x}" y="${L.base}" class="l2" style="font-size:${L.lab}px">${esc(sg.label)}</text>`
    const labW = textW(sg.label, L.lab) + 6
    const weight = sg.label === '阶段' ? 600 : 500
    const none = sg.pct === null
    const pt = none ? '/' : pctText(sg.pct)
    const s = fit(sg.text, (w - labW - textW(pt, L.pt) - 10) / L.tx)
    return (
      lab +
      `<text x="${x + labW}" y="${L.base}" class="${sg.text === '/' ? 'l2' : sg.tone ?? 'l1'}" style="font-size:${L.tx}px;font-weight:${weight}">${esc(s)}</text>` +
      (none
        ? `<text x="${x + w}" y="${L.base}" text-anchor="end" class="l2" style="font-size:${L.pt}px;font-weight:700">/</text>` + pbar(id, x, L.bar, w, L.bh, 0)
        : `<text x="${x + w}" y="${L.base}" text-anchor="end" style="fill:var(--${id}c);font-size:${L.pt}px;font-weight:700;font-variant-numeric:tabular-nums">${pt}</text>` + pbar(id, x, L.bar, w, L.bh, sg.pct ?? 0))
    )
  }
  let end = statusW
  if (left) (body += sep(x0 - GAP / 2) + cell(left, 'bpl', x0, lw)), (end = x0 + lw)
  if (right) {
    const x = R - rw
    body += sep(x - GAP / 2) + cell(right, 'bpr', x, rw)
    end = R
  }
  const width = Math.max(Math.ceil(end + 6), Math.round(padTo))
  const segs = [left, right].filter((x): x is Seg => !!x)
  const est = br.byModel ? '（完成度是小模型估的）' : br.total !== null ? '（完成度按待办清单算）' : ''
  const alt = [main, meterText(kind), ...segs.map(sg => `${sg.label}：${sg.text}${sg.pct === null ? '' : ` ${pctText(sg.pct)}`}`)].join(' · ') + est
  return { width, height: H, alt, source: svg(width, H, body + extra) }
}

// 暂停按钮直接画进小条图里：淡彩底、细边框、8px 圆角，高 24px，与下面的用量条胶囊保持一致。
// 桌面版 Box 边框会占一整格、把按钮撑到 42px 高，所以外观在图里画，点击交给盖在上面的透明按钮
export const CHIP = { h: 24, size: 12, pad: 10, gap: 8 }
export function chipRow<T extends { text: string; color: string }>(right: number, items: T[]) {
  let x = right
  return items
    .slice()
    .reverse()
    .map(it => {
      const w = Math.round(textW(it.text, CHIP.size) + CHIP.pad * 2)
      x -= w
      const at = { ...it, x, w }
      x -= CHIP.gap
      return at
    })
    .reverse()
}
export function chipSvg(row: { text: string; color: string; x: number; w: number }[]) {
  const y = (BAND.h - CHIP.h) / 2
  return row
    .map(
      c =>
        `<rect x="${c.x + 0.5}" y="${y + 0.5}" width="${c.w - 1}" height="${CHIP.h - 1}" rx="8" style="fill:${c.color}24;stroke:${c.color}73;stroke-width:1"/>` +
        `<text x="${c.x + c.w / 2}" y="${y + CHIP.h / 2 + CHIP.size * 0.36}" text-anchor="middle" style="fill:${c.color};font-size:${CHIP.size}px;font-weight:600">${esc(c.text)}</text>`,
    )
    .join('')
}
