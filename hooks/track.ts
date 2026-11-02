import type { Board, Step } from '../types'
import { NORMAL_DEG, SEVERE_DEG, currentItem, degOf } from './analyze'
import type { Brief, Kind, View } from './view'
import { esc, icon, meter, pbar, pctText, svg, tag, textW, wrap } from './view'

// 面板 v2：一个焦点（结论 + 现在在哪），颜色只给异常，文字只标偏了的步骤，次要数字压成一行，细节收进按钮。

const KIND_VAR: Record<Kind, string> = { ok: 'var(--ok)', warn: 'var(--warn)', pause: 'var(--err)' }
const sevVar = (d: number) => (Math.abs(d) < NORMAL_DEG ? 'var(--norm)' : Math.abs(d) < SEVERE_DEG ? 'var(--warn)' : 'var(--err)')
const sevWidth = (d: number) => (Math.abs(d) >= SEVERE_DEG ? 4.2 : Math.abs(d) >= NORMAL_DEG ? 3.4 : 2.4)
const side = (d: number) => (d > 0 ? '右' : '左')
const f1 = (n: number) => n.toFixed(1)

type TextOpt = { size?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; weight?: number }
function tx(x: number, y: number, s: string, o: TextOpt = {}) {
  const a = o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : ''
  return `<text x="${f1(x)}" y="${f1(y)}"${a} style="font-size:${o.size ?? 12}px;fill:${o.fill ?? 'var(--ink)'}${o.weight ? `;font-weight:${o.weight}` : ''}">${esc(s)}</text>`
}
function ln(x1: number, y1: number, x2: number, y2: number, stroke: string, w = 1.4, dash = '') {
  return `<path d="M${f1(x1)} ${f1(y1)}L${f1(x2)} ${f1(y2)}" style="stroke:${stroke};fill:none" stroke-width="${w}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
}
// 按宽度截断，末尾加省略号
function fit(s: string, size: number, maxW: number) {
  if (textW(s, size) <= maxW) return s
  let out = [...s]
  while (out.length && textW(out.join('') + '…', size) > maxW) out = out.slice(0, -1)
  return out.length ? out.join('') + '…' : ''
}

const pad = (n: number) => String(n).padStart(2, '0')
export function hhmm(t: number | undefined, withDay = false) {
  if (!t) return ''
  const d = new Date(t)
  return `${withDay ? `${d.getMonth() + 1}月${d.getDate()}日 ` : ''}${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

// ---------- 1. 结论区：唯一焦点 ----------

// 一句人话：正在做什么 + 最近一步偏了多少
export function heroReason(b: Board, v: View, br: Brief) {
  if (v.kind !== 'ok') return v.reason
  const last = b.steps.at(-1)
  const doing = br.stage ? `正在${br.stage.replace(/^正在/, '')}。` : v.reason
  if (!last) return doing
  const d = degOf(last, b.steps)
  if (Math.abs(d) < 3) return `${doing}最近一步方向正对目标。`
  if (Math.abs(d) < NORMAL_DEG) return `${doing}最近一步往${side(d)}偏了 ${Math.abs(d)}°，还在正常范围。`
  return `${doing}最近一步往${side(d)}偏了 ${Math.abs(d)}°${last.why ? `：${last.why}` : ''}。`
}

export function svgHero(b: Board, v: View, br: Brief, width: number, updated: string) {
  const W = Math.max(300, Math.min(640, width))
  let body = icon(v.kind, 14, 16, 14)
  body += tx(38, 23.5, v.title, { size: 20, weight: 700 })
  body += meter(v.kind, 38 + textW(v.title, 20) + 14, 16, 12).body
  if (updated) body += tx(W - 2, 21, `${updated} 更新`, { size: 11, fill: 'var(--faint)', anchor: 'end' })
  const reason = heroReason(b, v, br)
  const lines = wrap(reason, 13.5, W - 4, 3)
  let y = 54
  lines.forEach((l, i) => (body += tx(0, y + i * 20, l, { size: 13.5 })))
  y += (lines.length - 1) * 20 + 34

  // 两行进度：和小条同一种写法（标签 · 内容 · 蓝绿进度条 · 百分比）
  const ver = (b.goals ?? []).at(-1)
  const cur = currentItem(b.plan)
  const rows: { label: string; text: string; pct: number | null; chip?: string; tail?: string }[] = [
    { label: '总目标', text: br.goal, pct: br.total, chip: ver && ver.v >= 2 ? `第 ${ver.v} 版` : undefined },
  ]
  if (br.stage) rows.push({ label: '阶段目标', text: br.stage, pct: br.stagePct, tail: cur && b.plan.length > 1 ? `（第 ${b.plan.indexOf(cur) + 1} 段，共 ${b.plan.length} 段）` : '' })
  const BAR = 80
  rows.forEach((r, i) => {
    // 阶段目标属于总目标：往里缩一格，用一条细线从总目标挂下来
    let x = i > 0 ? 16 : 0
    if (i > 0) body += `<path d="M6 ${y - 22}V${y}H${x - 3}" fill="none" style="stroke:var(--faint)" stroke-width="1.2"/>`
    const tg = tag(x, y + 5, r.label, 12)
    body += tg.body
    x += tg.w + 10
    if (r.chip) {
      const cw = textW(r.chip, 10) + 14
      body += `<rect x="${x}" y="${y - 8}" width="${cw}" height="16" rx="8" style="fill:none;stroke:var(--blue)" stroke-width="1"/>`
      body += tx(x + cw / 2, y + 3.8, r.chip, { size: 10, fill: 'var(--blue)', anchor: 'middle', weight: 600 })
      x += cw + 8
    }
    const right = r.pct === null ? 0 : BAR + 52
    const room = W - right - x - 10
    const main = fit(r.text, 14, room)
    body += tx(x, y + 5, main, { size: 14, weight: 600 })
    if (r.tail && textW(main, 14) + textW(r.tail, 12) < room) body += tx(x + textW(main, 14) + 2, y + 5, r.tail, { size: 12, fill: 'var(--sub)' })
    if (r.pct !== null) {
      body += pbar(`hp${i}`, W - BAR - 46, y, BAR, 8, r.pct)
      body += tx(W - 2, y + 5.5, pctText(r.pct), { size: 15, weight: 700, anchor: 'end', fill: `var(--hp${i}c)` })
    }
    y += 32
  })
  const h = y - 10
  const alt = [`${v.title}。${reason}`, ...rows.map(r => `${r.label}：${r.text}${r.pct === null ? '' : ` ${pctText(r.pct)}`}`)].join(' ')
  return { width: W, height: h, alt, source: svg(W, h, body) }
}

// ---------- 2. 航迹图：安静的灰线，只有偏了的步骤带颜色和文字 ----------

type Pt = { x: number; y: number }
export type TrackStats = { cur: number; curSide: string; max: number; maxSide: string; detour: number; flagged: number }

// 偏了 15° 以上、方向相同的连续几步合成一段，只标一次
function runsOf(steps: readonly Step[], degs: number[]) {
  const out: { from: number; to: number }[] = []
  degs.forEach((d, i) => {
    if (Math.abs(d) < NORMAL_DEG) return
    const last = out.at(-1)
    if (last && last.to === i - 1 && Math.sign(degs[last.to]!) === Math.sign(d)) last.to = i
    else out.push({ from: i, to: i })
  })
  return out
}

function runText(b: Board, steps: readonly Step[], degs: number[], r: { from: number; to: number }) {
  const a = degs[r.from]!, z = degs[r.to]!
  const ang = r.to > r.from && a !== z ? `${side(z)} ${Math.abs(a)}°→${Math.abs(z)}°` : `${side(z)} ${Math.abs(z)}°`
  const ns = new Set(steps.slice(r.from, r.to + 1).map(s => s.n))
  const drift = [...(b.drifts ?? [])].reverse().find(d => ns.has(d.step) || (d.step > steps[r.from]!.n - 1 && d.step <= steps[r.to]!.n + 1))
  const last = steps[r.to]!
  const tagWhy = last.tags.includes('重复') ? `同一个操作重复了 ${r.to - r.from + 1} 次` : last.tags.includes('离题') ? '和任务关系不大' : last.tags.includes('支线') ? '做了支线的事' : ''
  const why = drift ? drift.text : last.why || tagWhy // 暂停/提醒后的结果由 outcome 那行说
  return { ang, why, outcome: drift?.outcome ?? '' }
}

export function svgTrack(b: Board, width: number, now: number, kind: Kind) {
  const W = Math.max(300, Math.min(640, width))
  const steps = b.steps
  const degs = steps.map(s => degOf(s, steps))
  const LW = W >= 420 ? 132 : 92 // 左边一栏放时间和阶段
  const CX = LW + (W - LW) / 2
  let body = tx(0, 14, '航迹', { size: 13, weight: 700 })
  body += tx(36, 14, fit('每段线的方向 = 那一步朝哪走；偏得越歪，离目标越绕', 11, W - 40), { size: 11, fill: 'var(--faint)' })
  body += tx(CX - 18, 44, '← 做少了', { size: 11, fill: 'var(--sub)', anchor: 'end' })
  body += tx(CX + 18, 44, '做多了 →', { size: 11, fill: 'var(--sub)' })

  const O: Pt = { x: CX, y: 76 }
  const N = steps.length
  const U = Math.max(8, Math.min(44, 480 / Math.max(1, N)))
  const FAR: Pt = { x: CX, y: O.y + Math.max(6, N) * U * 1.55 }
  const minX = LW + 16, maxX = W - 16
  const pts: Pt[] = [O]
  for (let i = 0; i < N; i++) {
    const P = pts[i]!
    const base = Math.atan2(FAR.x - P.x, FAR.y - P.y)
    const a = base + (degs[i]! * Math.PI) / 180
    pts.push({ x: Math.max(minX, Math.min(maxX, P.x + U * Math.sin(a))), y: P.y + U * Math.cos(a) })
  }
  const P = pts.at(-1)!
  const bottom = Math.max(...pts.map(p => p.y))
  const BRK = bottom + 34
  const goals = b.goals ?? []
  const prev = goals.length >= 2 ? goals.at(-2)! : null
  const G1 = BRK + 38
  const G2 = prev ? BRK + 76 : BRK + 44

  // 最优路线（灰虚线）+ 截断号 + 目标
  let under = ln(CX, O.y, CX, BRK - 8, 'var(--line)', 1.2, '5 5')
  under += `<path d="M${f1(CX - 12)} ${f1(BRK - 2)}l24 -6M${f1(CX - 12)} ${f1(BRK + 6)}l24 -6" style="stroke:var(--faint);fill:none" stroke-width="1.2"/>`
  under += ln(CX, BRK + 8, CX, G2 - 12, 'var(--line)', 1.2, '5 5')
  if (prev) {
    under += `<circle cx="${f1(CX)}" cy="${f1(G1)}" r="4.5" style="fill:var(--bg);stroke:var(--faint)" stroke-width="1.4"/>`
    const last = goals.at(-1)!
    under += tx(CX + 12, G1 + 4, fit(`第 ${prev.v} 版目标${last.why ? ` · ${last.why}` : ''}`, 10.5, W - CX - 14), { size: 10.5, fill: 'var(--faint)' })
  }
  under += `<circle cx="${f1(CX)}" cy="${f1(G2)}" r="11" style="fill:var(--blue)" opacity=".18"/><circle cx="${f1(CX)}" cy="${f1(G2)}" r="5.5" style="fill:var(--blue)"/>`
  under += tx(CX + 18, G2 + 5, '目标', { size: 12.5, fill: 'var(--blue)', weight: 700 })
  under += `<circle cx="${f1(CX)}" cy="${f1(O.y)}" r="4.5" style="fill:var(--ink)"/>`
  under += tx(CX + 10, O.y - 6, '起点', { size: 11, fill: 'var(--sub)' })
  // 现在 → 目标 的点线
  under += ln(P.x, P.y + 16, CX, BRK - 12, 'var(--line)', 1.2, '1 4')

  // 左栏：阶段从哪一步开始；和「现在」挨太近的让给「现在」
  const labels: { y: number; time: string; name: string; now?: boolean }[] = []
  const first = steps[0]
  const day = (t?: number) => (t && !sameDay(t, now) ? hhmm(t, true) : hhmm(t))
  labels.push({ y: O.y, time: day(first?.t), name: (first?.at && b.plan.find(p => p.id === first.at)?.text) || (b.stepCount > N ? `更早的 ${b.stepCount - N} 步没画` : '开始') })
  const nowY = P.y
  steps.forEach((s, i) => {
    if (i === 0 || !s.at || s.at === steps[i - 1]!.at) return
    const item = b.plan.find(p => p.id === s.at)
    if (item) labels.push({ y: pts[i]!.y, time: hhmm(s.t), name: item.text })
  })
  const kept: typeof labels = []
  for (const l of labels) if ((!kept.length || l.y - kept.at(-1)!.y >= 32) && Math.abs(nowY - l.y) >= 32) kept.push(l)
  kept.push({ y: nowY, time: hhmm(now), name: '现在', now: true })
  let marks = ''
  for (const l of kept) {
    if (l.time) marks += tx(0, l.y - 3, l.time, { size: 10.5, fill: l.now ? 'var(--ink)' : 'var(--faint)', weight: l.now ? 700 : undefined })
    marks += tx(0, l.y + (l.time ? 12 : 4), fit(l.name, l.now ? 11.5 : 11, LW - 14), { size: l.now ? 11.5 : 11, fill: l.now ? 'var(--ink)' : 'var(--sub)', weight: l.now ? 700 : undefined })
    if (!l.now) {
      const i = pts.findIndex(p => p.y === l.y)
      const px = i >= 0 ? pts[i]!.x : CX
      marks += ln(LW + 10, l.y, px - 8, l.y, 'var(--soft)', 1, '1 3')
      if (i > 0) marks += `<circle cx="${f1(px)}" cy="${f1(l.y)}" r="4" style="fill:var(--bg);stroke:var(--sub)" stroke-width="1.6"/>`
    } else marks += ln(LW + 10, l.y, P.x - 18, l.y, 'var(--soft)', 1, '1 3')
  }

  // 每一步一段线：正常灰细，中度橙，重度红粗；偏了的画参考虚线和角度弧
  let path = ''
  for (let i = 0; i < N; i++) {
    const A = pts[i]!, B = pts[i + 1]!, d = degs[i]!
    if (Math.abs(d) >= NORMAL_DEG) {
      const base = Math.atan2(FAR.x - A.x, FAR.y - A.y)
      const a = base + (d * Math.PI) / 180
      path += ln(A.x, A.y, A.x + U * Math.sin(base), A.y + U * Math.cos(base), 'var(--faint)', 1, '2 3')
      const r = Math.min(16, U * 0.45)
      path += `<path d="M${f1(A.x + r * Math.sin(base))} ${f1(A.y + r * Math.cos(base))}A${f1(r)} ${f1(r)} 0 0 ${d > 0 ? 0 : 1} ${f1(A.x + r * Math.sin(a))} ${f1(A.y + r * Math.cos(a))}" style="stroke:${sevVar(d)};fill:none" stroke-width="1.3"/>`
    }
    path += ln(A.x, A.y, B.x, B.y, sevVar(d), sevWidth(d))
  }

  // 偏了的那几段：角度 + 原因，标在段尾；同一侧挨太近就往下错开
  let notes = ''
  const lastY = { 1: -99, [-1]: -99 } as Record<number, number>
  let nowSide = 0 // 段尾说明正好落在「现在」这个点上时，记下它在哪一侧，「现在在这」就让开
  for (const r of runsOf(steps, degs)) {
    const E = pts[r.to + 1]!
    const d = degs[r.to]!
    const sd = d > 0 ? 1 : -1
    const { ang, why, outcome } = runText(b, steps, degs, r)
    const y = Math.max(E.y, lastY[sd]! + 32)
    lastY[sd] = y
    if (E === P && Math.abs(y - P.y) < 24) nowSide = sd
    const x = E.x + sd * 14
    const room = sd > 0 ? W - x - 2 : x - 2
    const anchor = sd > 0 ? 'start' : 'end'
    notes += tx(x, y - 3, ang, { size: 12, fill: sevVar(d), anchor, weight: 700 })
    if (why) notes += tx(x, y + 12, fit(why, 11, room), { size: 11, anchor })
    if (outcome) notes += tx(E.x - 14, E.y + 22, fit(outcome, 10.5, E.x - 14 - LW), { size: 10.5, fill: 'var(--sub)', anchor: 'end' })
  }

  // 现在：唯一高亮点
  const kc = KIND_VAR[kind]
  let nowMark = `<circle cx="${f1(P.x)}" cy="${f1(P.y)}" r="15" style="fill:${kc}" opacity=".14"/><circle cx="${f1(P.x)}" cy="${f1(P.y)}" r="9" style="fill:${kc}" opacity=".28"/>`
  nowMark += `<circle cx="${f1(P.x)}" cy="${f1(P.y)}" r="5.5" style="fill:var(--bg);stroke:${kc}" stroke-width="3"/>`
  const nowW = textW('现在在这', 12)
  if (nowSide <= 0 && P.x + 22 + nowW < W) nowMark += tx(P.x + 22, P.y + 5, '现在在这', { size: 12, fill: kc, weight: 700 })
  else if (nowSide > 0 && P.x - 22 - nowW > LW + 10) nowMark += tx(P.x - 22, P.y + 14, '现在在这', { size: 12, fill: kc, weight: 700, anchor: 'end' })

  // 整体三个数（次要，压成一行）
  const st = trackStats(pts, CX, O, FAR, degs)
  let y = G2 + 32
  let card = `<rect x="0" y="${f1(y)}" width="${W}" height="40" rx="10" style="fill:var(--card)"/>`
  const sevPct = (p: number) => (p >= 10 ? 'var(--err)' : p >= 5 ? 'var(--warn)' : 'var(--ink)')
  const items: [string, string, string][] = [
    ['现在离最优路线', st.cur < 1 ? '在线上' : `偏${st.curSide} ${Math.round(st.cur)}%`, 'var(--ink)'],
    ['最远偏到', st.max < 1 ? '没偏过' : `偏${st.maxSide} ${Math.round(st.max)}%`, sevPct(st.max)],
    ['多绕了', `${Math.round(st.detour)}% 的路`, 'var(--ink)'],
  ]
  let cx = 14
  for (const [k, val, c] of items) {
    if (cx + textW(k, 11.5) + textW(val, 13) + 8 > W - 8) break
    card += tx(cx, y + 25, k, { size: 11.5, fill: 'var(--sub)' })
    cx += textW(k, 11.5) + 6
    card += tx(cx, y + 25, val, { size: 13, fill: c, weight: 700 })
    cx += textW(val, 13) + 26
  }
  y += 66
  const legend: [string, string][] = [['var(--norm)', `正常 0–${NORMAL_DEG}°`], ['var(--warn)', `中度 ${NORMAL_DEG}–${SEVERE_DEG}°`], ['var(--err)', `重度 ${SEVERE_DEG}° 以上`]]
  legend.forEach(([c, s], i) => {
    const lx = i * 120
    card += `<rect x="${lx}" y="${y - 5}" width="16" height="4" rx="2" style="fill:${c}"/>`
    card += tx(lx + 22, y, s, { size: 10.5, fill: 'var(--sub)' })
  })
  const h = y + 8
  const alt = `航迹：共 ${N} 步，${st.flagged} 步偏了 ${NORMAL_DEG}° 以上；现在离最优路线${items[0]![1]}，最远${items[1]![1]}，多绕了 ${items[2]![1]}。`
  return { width: W, height: h, alt, source: svg(W, h, body + under + marks + path + notes + nowMark + card), stats: st }
}

function trackStats(pts: Pt[], CX: number, O: Pt, FAR: Pt, degs: number[]): TrackStats {
  const total = FAR.y - O.y
  const P = pts.at(-1)!
  let walked = 0
  for (let i = 1; i < pts.length; i++) walked += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
  let far = pts[0]!
  for (const p of pts) if (Math.abs(p.x - CX) > Math.abs(far.x - CX)) far = p
  const straight = Math.hypot(P.x - O.x, P.y - O.y)
  return {
    cur: (Math.abs(P.x - CX) / total) * 100,
    curSide: P.x >= CX ? '右' : '左',
    max: (Math.abs(far.x - CX) / total) * 100,
    maxSide: far.x >= CX ? '右' : '左',
    detour: walked > 0 ? (1 - straight / walked) * 100 : 0,
    flagged: degs.filter(d => Math.abs(d) >= NORMAL_DEG).length,
  }
}

// ---------- 3. 折叠区：每一步的偏离角（柱状图） ----------

export function svgDegChart(b: Board, width: number) {
  const W = Math.max(300, Math.min(640, width))
  const steps = b.steps
  const degs = steps.map(s => degOf(s, steps))
  const L = 44, top = 16, mid = 76, H = 50
  const bw = Math.max(3, Math.min(16, (W - L - 8) / Math.max(1, steps.length) - 3))
  const gap = (W - L - 8) / Math.max(1, steps.length)
  let body = tx(0, top, '做多了 ↑', { size: 10.5, fill: 'var(--sub)' })
  body += tx(0, mid + H + 2, '做少了 ↓', { size: 10.5, fill: 'var(--sub)' })
  body += ln(L, mid, W - 4, mid, 'var(--line)', 1)
  body += ln(L, mid - (NORMAL_DEG / 80) * H, W - 4, mid - (NORMAL_DEG / 80) * H, 'var(--soft)', 1, '3 3')
  body += ln(L, mid + (NORMAL_DEG / 80) * H, W - 4, mid + (NORMAL_DEG / 80) * H, 'var(--soft)', 1, '3 3')
  const every = Math.ceil(steps.length / 12)
  steps.forEach((s, i) => {
    const d = degs[i]!
    const x = L + 4 + i * gap
    const h = Math.max(2, (Math.abs(d) / 80) * H)
    body += `<rect x="${f1(x)}" y="${f1(d >= 0 ? mid - h : mid)}" width="${f1(bw)}" height="${f1(h)}" rx="1.5" style="fill:${sevVar(d)}"/>`
    if (i % every === 0 || i === steps.length - 1) body += tx(x + bw / 2, mid + H + 16, String(s.n), { size: 9.5, fill: 'var(--faint)', anchor: 'middle' })
  })
  const h = mid + H + 22
  const alt = `每一步的偏离角：${steps.map((s, i) => `${s.n}:${degs[i]}°`).join('，')}`
  return { width: W, height: h, alt, source: svg(W, h, body) }
}
