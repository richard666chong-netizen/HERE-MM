# HTML 风格偏差统计统一面板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 HTML 演示页的偏差统计（4 chips + 直方图 + 偏差-里程图 + Current Deviation 读数，随回放实时切片）移植为工程内 analysis/demo 共用的统一面板。

**Architecture:** 数据层新增一个纯函数 `driftSeries`；新建自绘 SVG 图表组件（样式照抄 HTML）；`StatsPanel` 升级为双态组件（`upToIndex` 缺省=全量 / 给定=实时切片）；App 预计算漂移序列并双模式接线。

**Tech Stack:** React 18 + TypeScript + Vitest + @testing-library/react（无新依赖；recharts 保留给 DeviationReplayChart，本面板不用）。

**Spec:** `docs/superpowers/specs/2026-09-16-deviation-stats-html-style-design.md`（含 2026-09-16 修订：端点免量化）

## Global Constraints

- **禁止 `git commit`**：commit 决策被用户显式留到 Phase 5；工作树含未提交的既有改动（App.tsx/MapView.tsx 等），任务只以测试验证收尾。
- `HERE-POC-MapMatching-CHANG-Zhen.html` 是 **untracked 只读参考**（勿 import 进 src、勿提交）。
- 每任务收尾跑全量 `npx vitest run`；Task 3 结束加 `npm run build`。基线：18 文件 150/150 绿（2026-09-16 验证）。
- `npm run build` = `tsc --noEmit` + vite build，**未用 import/变量直接挂**（TS6133，昨日教训）——删代码必须连引用一起删。
- 样式常量照抄 HTML `renderStatsPanel` L622–679：viewBox 320×100、padL=28 padB=16 padT=4 padR=4、轴线 `#9ca3af` 0.5px、刻度字 8px `#6b7280`、bar `#2563eb` opacity 0.7 宽 0.85×barW、面积 `rgba(37,99,235,0.15)` + `#2563eb` 0.8px。
- 所有命令在 `D:\here\here-poc` 下执行。

---

### Task 1: `driftSeries` 纯函数

**Files:**
- Modify: `src/lib/stats.ts`（文件末尾追加）
- Test: `src/__tests__/stats.test.ts`（追加 describe 块 + 扩 import）

**Interfaces:**
- Consumes: `haversineM`（`./geo`，stats.ts 已 import）、`TrajPoint`（`../types`）。
- Produces: `driftSeries(trace: TrajPoint[], drPositions: [number, number][]): number[]`——逐帧 haversine，长度不齐按 `Math.min` 截断，空输入返回 `[]`。Task 3 的 App 与 app.test 依赖此签名。

- [ ] **Step 1: Write the failing test**

`src/__tests__/stats.test.ts` 第 3 行 import 改为：

```ts
import { deviationHistogram, deviationStats, deviationVsDistance, driftSeries } from '../lib/stats'
```

文件末尾追加（`mkDs` 不适用——driftSeries 输入是 trace，不是 derived）：

```ts
describe('driftSeries', () => {
  const tr = (lats: number[]): TrajPoint[] =>
    lats.map((lat, i) => ({
      lat, lng: 8.4, timestamp: i, timestampUtc: '', headingDeg: 90, speedMps: 1, numsats: 8,
    }))

  it('per-frame haversine between trace and DR positions; 0 where identical', () => {
    // 0.001° lat ≈ 111.19m（R=6371008.8，与 geo.test 同口径）
    const s = driftSeries(tr([49, 49.001, 49.002]), [[49, 8.4], [49, 8.4], [49.002, 8.4]])
    expect(s).toHaveLength(3)
    expect(s[0]).toBeCloseTo(0, 6)
    expect(s[1]).toBeCloseTo(111.19, 1)
    expect(s[2]).toBeCloseTo(0, 6)
  })

  it('length mismatch → truncated to min length (HTML L608 口径)', () => {
    const s = driftSeries(tr([49, 49.001, 49.002]), [[49, 8.4]])
    expect(s).toHaveLength(1)
    expect(s[0]).toBeCloseTo(0, 6)
  })

  it('empty inputs → []', () => {
    expect(driftSeries([], [])).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/stats.test.ts`
Expected: FAIL — `driftSeries` is not exported（import 报错或 undefined）。

- [ ] **Step 3: Write minimal implementation**

`src/lib/stats.ts` 末尾追加：

```ts
/** 逐帧 DR 漂移序列：本地 DR 推算位置 vs OXTS 输出（真值侧）的 haversine。
 *  长度不齐按 Math.min 截断（HTML L608 口径）；切片最大值由调用侧 slice-max（实时切片语义）。 */
export function driftSeries(trace: TrajPoint[], drPositions: [number, number][]): number[] {
  const n = Math.min(trace.length, drPositions.length)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    out.push(haversineM([trace[i].lat, trace[i].lng], drPositions[i]))
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/stats.test.ts`
Expected: PASS（原 3 个 describe + 新 3 用例全绿）。

- [ ] **Step 5: 全量回归**

Run: `npx vitest run`
Expected: 18 文件 153/153 绿。（不 commit——见 Global Constraints）

---

### Task 2: StatsCharts 自绘 SVG 组件

**Files:**
- Create: `src/components/StatsCharts.tsx`
- Test: `src/__tests__/statsCharts.test.tsx`（新建）

**Interfaces:**
- Consumes: 无（纯渲染组件，数据由调用方用 stats.ts 算好）。
- Produces:
  - `HistogramSvg({ bins }: { bins: { fromM: number; toM: number; count: number }[] })` — `bins` 即 `deviationHistogram().bins` 的形状
  - `DistanceDeviationSvg({ points }: { points: { distanceM: number; deviationM: number }[] })` — `points` 即 `deviationVsDistance()` 返回形状
  - Task 3 的 StatsPanel 消费两者。

- [ ] **Step 1: Write the failing test**

新建 `src/__tests__/statsCharts.test.tsx`：

```tsx
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DistanceDeviationSvg, HistogramSvg } from '../components/StatsCharts'

describe('HistogramSvg', () => {
  it('renders 20 bars + y ticks (max/mid/0×2) + x ticks (0/mid/max)', () => {
    // counts 1,2,3 → maxCount=3、mid=round(3/2)=2；末桶 toM=20 → x 轴 '10.0m'/'20.0m'
    const bins = Array.from({ length: 20 }, (_, i) => ({ fromM: i, toM: i + 1, count: i < 3 ? i + 1 : 0 }))
    const { container, getByText, getAllByText } = render(<HistogramSvg bins={bins} />)
    expect(container.querySelectorAll('rect[data-testid="hist-bar"]')).toHaveLength(20)
    expect(getByText('3')).toBeTruthy() // y 最大刻度 = maxCount
    expect(getByText('2')).toBeTruthy() // y 中刻度 = round(maxCount/2)
    expect(getAllByText('0')).toHaveLength(2) // y 原点 + x 原点
    expect(getByText('10.0m')).toBeTruthy()
    expect(getByText('20.0m')).toBeTruthy()
  })
})

describe('DistanceDeviationSvg', () => {
  it('single point: guarded path, no NaN, closed with Z (HTML L652 maxDist≥1)', () => {
    const { container } = render(<DistanceDeviationSvg points={[{ distanceM: 0, deviationM: 0 }]} />)
    const d = container.querySelector('path[data-testid="dist-area"]')!.getAttribute('d')!
    expect(d).not.toContain('NaN')
    expect(d).toContain('Z')
  })
  it('km/m adaptive x labels (≥1000m → km, mid = maxDist/2000 km)', () => {
    const { getByText } = render(
      <DistanceDeviationSvg points={[{ distanceM: 0, deviationM: 1 }, { distanceM: 1000, deviationM: 2 }]} />,
    )
    expect(getByText('1.0km')).toBeTruthy() // x 最大
    expect(getByText('0.5km')).toBeTruthy() // x 中 = 1000/2000 km
    expect(getByText('2.0m')).toBeTruthy() // y 最大 = maxDev
    expect(getByText('1.0m')).toBeTruthy() // y 中 = maxDev/2
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/statsCharts.test.tsx`
Expected: FAIL — Cannot find module `../components/StatsCharts`。

- [ ] **Step 3: Write minimal implementation**

新建 `src/components/StatsCharts.tsx`（完整文件；几何/颜色常量照抄 HTML L622–679）：

```tsx
/** HTML 风格自绘统计图：几何与配色照抄 HERE-POC-MapMatching-CHANG-Zhen.html renderStatsPanel（L622–679）。
 *  纯渲染组件——bins/points 由 StatsPanel 用 lib/stats 算好传入。 */
const W = 320
const H = 100
const PAD_L = 28
const PAD_B = 16
const PAD_T = 4
const PAD_R = 4
const PLOT_W = W - PAD_L - PAD_R
const PLOT_H = H - PAD_B - PAD_T
const AXIS_STROKE = '#9ca3af'
const TICK_FILL = '#6b7280'
const SERIES = '#2563eb'

/** 左-下坐标轴 + 6 个刻度字的公共骨架 */
function AxisFrame({ yMaxLabel, yMidLabel, xMidLabel, xMaxLabel }: { yMaxLabel: string; yMidLabel: string; xMidLabel: string; xMaxLabel: string }) {
  return (
    <>
      <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={PAD_T + PLOT_H} stroke={AXIS_STROKE} strokeWidth={0.5} />
      <line x1={PAD_L} y1={PAD_T + PLOT_H} x2={PAD_L + PLOT_W} y2={PAD_T + PLOT_H} stroke={AXIS_STROKE} strokeWidth={0.5} />
      <text x={2} y={PAD_T + 4} fontSize={8} fill={TICK_FILL}>{yMaxLabel}</text>
      <text x={2} y={PAD_T + PLOT_H / 2 + 3} fontSize={8} fill={TICK_FILL}>{yMidLabel}</text>
      <text x={2} y={PAD_T + PLOT_H} fontSize={8} fill={TICK_FILL}>0</text>
      <text x={PAD_L} y={H - 2} fontSize={8} fill={TICK_FILL}>0</text>
      <text x={PAD_L + PLOT_W / 2 - 10} y={H - 2} fontSize={8} fill={TICK_FILL}>{xMidLabel}</text>
      <text x={PAD_L + PLOT_W - 20} y={H - 2} fontSize={8} fill={TICK_FILL}>{xMaxLabel}</text>
    </>
  )
}

export interface HistBin {
  fromM: number
  toM: number
  count: number
}

/** 偏差直方图：等宽桶柱状（x 轴为线性米制，recharts 分类轴表达不了——故自绘） */
export function HistogramSvg({ bins }: { bins: HistBin[] }) {
  const maxCount = Math.max(1, ...bins.map((b) => b.count))
  const barW = PLOT_W / bins.length
  const xMax = bins.length > 0 ? bins[bins.length - 1].toM : 0
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Deviation histogram">
      <AxisFrame
        yMaxLabel={String(maxCount)}
        yMidLabel={String(Math.round(maxCount / 2))}
        xMidLabel={`${(xMax / 2).toFixed(1)}m`}
        xMaxLabel={`${xMax.toFixed(1)}m`}
      />
      {bins.map((b, i) => {
        const bh = (b.count / maxCount) * PLOT_H
        return (
          <rect
            key={i}
            data-testid="hist-bar"
            x={PAD_L + i * barW}
            y={PAD_T + PLOT_H - bh}
            width={barW * 0.85}
            height={bh}
            fill={SERIES}
            opacity={0.7}
          />
        )
      })}
    </svg>
  )
}

export interface DistPoint {
  distanceM: number
  deviationM: number
}

/** 偏差-里程面积图：x=累计里程（km/m 自适应），y=横向偏差 */
export function DistanceDeviationSvg({ points }: { points: DistPoint[] }) {
  // 单点守卫（HTML L652）：distanceM=0 时 0/0=NaN；maxDist≥1、maxDev≥0.1
  const maxDist = points.length > 0 ? Math.max(points[points.length - 1].distanceM, 1) : 1
  const maxDev = Math.max(0.1, ...points.map((p) => p.deviationM))
  let d = `M ${PAD_L} ${PAD_T + PLOT_H}`
  for (const p of points) {
    const x = PAD_L + (p.distanceM / maxDist) * PLOT_W
    const y = PAD_T + PLOT_H - (p.deviationM / maxDev) * PLOT_H
    d += ` L ${(Math.round(x * 100) / 100).toFixed(2)} ${(Math.round(y * 100) / 100).toFixed(2)}`
  }
  if (points.length > 0) d += ` L ${PAD_L + PLOT_W} ${PAD_T + PLOT_H} Z`
  const km = maxDist >= 1000
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Deviation vs distance">
      <AxisFrame
        yMaxLabel={`${maxDev.toFixed(1)}m`}
        yMidLabel={`${(maxDev / 2).toFixed(1)}m`}
        xMidLabel={km ? `${(maxDist / 2000).toFixed(1)}km` : `${(maxDist / 2).toFixed(0)}m`}
        xMaxLabel={km ? `${(maxDist / 1000).toFixed(1)}km` : `${maxDist.toFixed(0)}m`}
      />
      <path data-testid="dist-area" d={d} fill="rgba(37,99,235,0.15)" stroke={SERIES} strokeWidth={0.8} />
    </svg>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/statsCharts.test.tsx`
Expected: PASS（3 用例）。

- [ ] **Step 5: 全量回归**

Run: `npx vitest run`
Expected: 19 文件 156/156 绿。（不 commit）

---

### Task 3: StatsPanel 统一化 + App 接线

**Files:**
- Modify: `src/components/StatsPanel.tsx`（重写主体：去 recharts、双态切片、新 props）
- Modify: `src/App.tsx`（imports / DriveData / load / drMaxDriftM memo 删除 / 侧栏）
- Test: `src/__tests__/statsPanel.test.tsx`（新建）
- Test: `src/__tests__/app.test.tsx`（3 处更新）

**Interfaces:**
- Consumes: Task 1 `driftSeries`（App 预计算）、Task 2 `HistogramSvg`/`DistanceDeviationSvg`、既有 `deviationStats/deviationHistogram/deviationVsDistance`。
- Produces: `StatsPanelProps { trace: TrajPoint[]; derived: DerivedPoint[]; driftM: number[]; upToIndex?: number }`；`data-testid="current-deviation"`（仅切片态渲染）。

- [ ] **Step 1: Write the failing test**

新建 `src/__tests__/statsPanel.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import StatsPanel from '../components/StatsPanel'
import { deviationStats } from '../lib/stats'
import type { DerivedPoint, TrajPoint } from '../types'

// 10Hz、100 帧；deviationM = (i%10)+1 周期模式（切片间均值必不同）；driftM = i/10（前缀最大可预测）
const N = 100
const trace: TrajPoint[] = Array.from({ length: N }, (_, i) => ({
  lat: 49, lng: 8.4 + i * 0.00001, timestamp: i / 10, timestampUtc: '', headingDeg: 90, speedMps: 1, numsats: 8,
}))
const derived: DerivedPoint[] = Array.from({ length: N }, (_, i) => ({
  i, matchedLatLng: [49, 8.4] as [number, number], deviationM: (i % 10) + 1, headingDeg: 90, speedMps: 1, linkId: `s${i}`,
}))
const driftM = Array.from({ length: N }, (_, i) => i / 10)

function expectChip(label: string, v: number): void {
  const chip = screen.getByText(label).closest('[data-testid="stat-chip"]')!
  expect(chip.textContent).toContain(`${v.toFixed(2)} m`)
}

describe('StatsPanel 双态（HTML renderStatsPanel 移植）', () => {
  it('全量态（无 upToIndex）：无红字读数，chips=全量统计，DR Max Drift 始终渲染', () => {
    render(<StatsPanel trace={trace} derived={derived} driftM={driftM} />)
    expect(screen.queryByTestId('current-deviation')).toBeNull()
    const stats = deviationStats(derived)
    expectChip('Mean Deviation', stats.meanM)
    expectChip('P95 Deviation', stats.p95M)
    expectChip('Max Deviation', stats.maxM)
    expectChip('DR Max Drift', 9.9) // max(driftM) = 99/10
    expect(screen.getAllByTestId('hist-bar')).toHaveLength(20)
  })

  it('切片态（upToIndex=54）：红字读数在，chips=0.5s 量化帧的切片统计（非第 54 帧）', () => {
    render(<StatsPanel trace={trace} derived={derived} driftM={driftM} upToIndex={54} />)
    expect(screen.getByTestId('current-deviation').textContent).toContain('5.00 m') // (54%10)+1，读数全速
    // t=5.4 → tQ=5.0 → eff=50：slice(0,51)，若错用 55 帧则 mean 5.41≠5.27、drift 5.4≠5.0
    const q = deviationStats(derived.slice(0, 51))
    expectChip('Mean Deviation', q.meanM)
    expectChip('DR Max Drift', 5.0) // max(driftM[0..50])
  })

  it('端点免量化（upToIndex=99）：chips 精确等于全量统计', () => {
    render(<StatsPanel trace={trace} derived={derived} driftM={driftM} upToIndex={99} />)
    const stats = deviationStats(derived)
    expectChip('Mean Deviation', stats.meanM)
    expectChip('Max Deviation', stats.maxM)
    expectChip('DR Max Drift', 9.9)
  })

  it('空数据：No deviation data 占位', () => {
    render(<StatsPanel trace={[]} derived={[]} driftM={[]} />)
    expect(screen.getByText('No deviation data')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/statsPanel.test.tsx`
Expected: FAIL — 现 StatsPanel 无 `driftM`/`upToIndex` props、chip label 是 'Mean' 等、无 `current-deviation`。

- [ ] **Step 3: Rewrite StatsPanel.tsx**

完整替换文件内容（保留原 InfoChip/样式块，去 recharts）：

```tsx
import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { DerivedPoint, TrajPoint } from '../types'
import { deviationHistogram, deviationStats, deviationVsDistance } from '../lib/stats'
import { DistanceDeviationSvg, HistogramSvg } from './StatsCharts'

export interface StatsPanelProps {
  /** liveTrace（与 derived 同长，偏差-里程的里程基准） */
  trace: TrajPoint[]
  derived: DerivedPoint[]
  /** 逐帧 DR 漂移（本地 DR vs OXTS，App load 时一次算好）：全量态=整列最大，切片态=前缀最大。
   *  口径与前三个 chip 不同：那三个是「本地 DR → HERE MM」（纠偏量），这个是「本地 DR → OXTS」（算法精度差距）。 */
  driftM: number[]
  /** 给定 = 回放切片态（chips/图表随进度 ~2Hz + Current Deviation 红字读数全速）；缺省 = 全量态 */
  upToIndex?: number
}

const panelStyle: CSSProperties = {
  width: '100%',
  padding: '0.75rem',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
}
const chipStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2,
  padding: '0.5rem 0.6rem',
  border: '1px solid #dbeafe',
  borderRadius: 8,
  background: '#eff6ff',
  flex: 1,
}
const chartTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#374151',
  marginTop: '0.75rem',
  marginBottom: '0.25rem',
}

interface ChipDef {
  label: string
  value: number
  tooltip: string
}

const INFO_ICON_STYLE: CSSProperties = {
  position: 'absolute',
  top: 4,
  right: 6,
  width: 16,
  height: 16,
  borderRadius: '50%',
  border: '1px solid #9ca3af',
  background: '#fff',
  color: '#6b7280',
  fontSize: 11,
  fontWeight: 700,
  lineHeight: '14px',
  textAlign: 'center',
  cursor: 'help',
  userSelect: 'none',
}

const POPOVER_STYLE: CSSProperties = {
  position: 'absolute',
  top: 22,
  right: 0,
  zIndex: 20,
  width: 260,
  padding: '10px 12px',
  background: 'rgba(255,255,255,0.98)',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
  fontSize: 12,
  lineHeight: '18px',
  color: '#374151',
}

function InfoChip({ chip }: { chip: ChipDef }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      data-testid="stat-chip"
      style={chipStyle}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span
        style={INFO_ICON_STYLE}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
      >i</span>
      <span style={{ fontSize: 11, color: '#6b7280' }}>{chip.label}</span>
      <strong style={{ fontSize: 20, color: '#1e40af' }}>{chip.value.toFixed(2)} m</strong>
      {open && (
        <div style={POPOVER_STYLE}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{chip.label}</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{chip.tooltip}</div>
        </div>
      )}
    </div>
  )
}

/** 偏差统计统一面板（HTML renderStatsPanel 双态移植）：
 *  upToIndex 缺省 = 全量统计（analysis）；给定 = 随回放实时切片（demo）+ Current Deviation 读数。 */
export default function StatsPanel({ trace, derived, driftM, upToIndex }: StatsPanelProps) {
  // 切片右端（量化后）：chips/两图 ~2Hz 重算（DeviationReplayChart 同约定）；端点免量化（终点=全量精确）
  const eff = useMemo(() => {
    const last = derived.length - 1
    if (last < 0) return -1
    if (upToIndex === undefined || upToIndex >= last) return last
    const i = Math.max(0, upToIndex)
    const tQ = Math.floor(trace[i].timestamp * 2) / 2
    let e = i
    while (e > 0 && trace[e].timestamp > tQ) e--
    return e
  }, [trace, derived, upToIndex])

  const slice = useMemo(() => (eff >= 0 ? derived.slice(0, eff + 1) : []), [derived, eff])
  // deviationStats 空输入抛 Error('empty')——空态走占位分支前 hooks 必须无条件执行，故在此守卫
  const stats = useMemo(
    () => (slice.length > 0 ? deviationStats(slice) : { meanM: 0, p95M: 0, maxM: 0 }),
    [slice],
  )
  const bins = useMemo(() => deviationHistogram(slice).bins, [slice])
  const dist = useMemo(() => deviationVsDistance(slice, trace), [slice, trace])
  const driftMax = useMemo(() => Math.max(0, ...driftM.slice(0, eff + 1)), [driftM, eff])
  // 读数全速（不量化）：切片态取当前帧
  const rawI = upToIndex === undefined ? -1 : Math.max(0, Math.min(upToIndex, derived.length - 1))

  if (derived.length === 0) {
    return (
      <aside style={panelStyle}>
        <h2 style={chartTitleStyle}>Deviation Stats</h2>
        <p style={{ fontSize: 13, color: '#6b7280' }}>No deviation data</p>
      </aside>
    )
  }

  const chips: ChipDef[] = [
    {
      label: 'Mean Deviation',
      value: stats.meanM,
      tooltip: 'Arithmetic mean of lateral deviation across all trajectory points.\n\nA: Local DR estimated position (heading + speed simplified integration, 1Hz GNSS correction)\nB: Nearest projection point on HERE MM matched polyline\n\nCalculation: sum(deviationM[]) / n\nSemantics: Average correction by MM on DR',
    },
    {
      label: 'P95 Deviation',
      value: stats.p95M,
      tooltip: '95% of points have deviation below this value.\n\nA: Local DR estimated position\nB: HERE MM matched polyline projection\n\nCalculation: Nearest rank method: sorted[ceil(0.95 * n) - 1]\nSemantics: Deviation upper bound excluding worst 5%, common OEM acceptance metric',
    },
    {
      label: 'Max Deviation',
      value: stats.maxM,
      tooltip: 'Maximum single-point deviation across the trajectory.\n\nA: Local DR estimated position\nB: HERE MM matched polyline projection\n\nCalculation: sorted[n - 1]\nSemantics: Worst-case DR deviation from road network',
    },
    {
      label: 'DR Max Drift',
      value: driftMax,
      tooltip: 'Maximum deviation between local DR and OXTS output.\n\nA: Local DR estimated position (heading + speed simplified integration)\nB: KITTI oxts output (OXTS RT3000 GNSS+INS fused solution, INS bridged during signal loss)\n\nCalculation: max(haversineM(DR[i], OXTS[i]))\nSemantics: Precision gap between two DR algorithms\n\nNote: OXTS output is not an independent ground truth, but a more sophisticated INS fusion from the same sensor suite',
    },
  ]

  return (
    <aside style={panelStyle}>
      <h2 style={{ ...chartTitleStyle, marginTop: 0 }}>Deviation Stats</h2>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
        {chips.map((chip) => (
          <InfoChip key={chip.label} chip={chip} />
        ))}
      </div>

      <h2 style={chartTitleStyle}>Deviation Histogram</h2>
      <HistogramSvg bins={bins} />

      <h2 style={chartTitleStyle}>Deviation vs. Distance</h2>
      <DistanceDeviationSvg points={dist} />

      {rawI >= 0 && (
        <div data-testid="current-deviation" style={{ fontSize: 15, padding: '8px 0' }}>
          Current Deviation:{' '}
          <strong style={{ fontSize: 20, color: '#dc2626' }}>
            {derived[rawI].deviationM.toFixed(2)} m
          </strong>
        </div>
      )}
    </aside>
  )
}
```

- [ ] **Step 4: Run panel test**

Run: `npx vitest run src/__tests__/statsPanel.test.tsx`
Expected: PASS（4 用例）。（App 仍传旧 props → 全量/构建此时必挂，下一Step 修。）

- [ ] **Step 5: Wire App.tsx（5 处编辑）**

1. imports：删除 `import { haversineM } from './lib/geo'`（仅 drMaxDriftM memo 在用）；新增 `import { driftSeries } from './lib/stats'`（与既有 import 并列，字母序插在 `loadHereMaps` 行前后皆可，按现有风格放在 `derive` 之后）。
2. `DriveData` 接口：在 `derived: DerivedPoint[]` 后插入：

```ts
  /** 逐帧 DR 漂移（本地 DR vs OXTS trace）：StatsPanel 的 DR Max Drift 数据源（全量/切片共用） */
  driftM: number[]
```

3. 删除 `drMaxDriftM` memo 整块（`const drMaxDriftM = useMemo(...)` 及其上方 3 行注释）。
4. load() 内，`const liveTrace = ...` 行之后、`const entry = await matchService(...)` 之前插入：

```ts
        // DR 漂移序列（StatsPanel 数据源）：drPositions 此处已算好，顺带一次 O(n)
        const driftM = driftSeries(trace, drPositions)
```

`setData({...})` 调用改为：

```ts
        setData({ trace, gnssFeed, liveTrace, derived, driftM, entry: { ...entry, derived } })
```

5. 侧栏 `<aside style={{ width: 380, flexShrink: 0 }}>` 整块替换为：

```tsx
        <aside style={{ width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {mode === 'demo' && data ? (
            <>
              <StatsPanel
                trace={data.liveTrace}
                derived={data.derived}
                driftM={data.driftM}
                upToIndex={pb.index}
              />
              <DeviationReplayChart trace={data.liveTrace} derived={data.derived} index={pb.index} />
            </>
          ) : (
            <StatsPanel
              trace={data?.liveTrace ?? []}
              derived={data?.derived ?? []}
              driftM={data?.driftM ?? []}
            />
          )}
        </aside>
```

- [ ] **Step 6: Update app.test.tsx（3 处）**

1. L10 import 扩展：

```ts
import { deviationStats, driftSeries } from '../lib/stats'
```

2. 「loads mock match end-to-end」用例的 chips 块（L89–93）替换为：

```ts
    const driftMax = Math.max(0, ...driftSeries(trace, drPos))
    const chips: ReadonlyArray<readonly [string, number]> = [
      ['Mean Deviation', stats.meanM],
      ['P95 Deviation', stats.p95M],
      ['Max Deviation', stats.maxM],
      ['DR Max Drift', driftMax],
    ]
```

3. 「demo tab」用例 L131 `expect(screen.queryByText('Deviation Histogram')).toBeNull() // 侧栏换成回放曲线` 替换为：

```tsx
    expect(screen.getByText('Deviation Histogram')).toBeTruthy() // 统一面板：demo 同样显示
    expect(screen.getByTestId('current-deviation')).toBeTruthy() // 切片态红字读数在
```

4. 「统计面板 DR 漂移读数」用例 L467 `screen.getByText('DR Drift')` 改为 `screen.getByText('DR Max Drift')`（chip label 换 HTML 全称，断言值 66.86 m 不变）。

- [ ] **Step 7: Run app tests + 全量 + build**

Run: `npx vitest run src/__tests__/app.test.tsx`
Expected: PASS。
Run: `npx vitest run`
Expected: 20 文件全绿（150 基线 + 3 driftSeries + 3 statsCharts + 4 statsPanel = 160，app.test 用例数不变）。
Run: `npm run build`
Expected: tsc --noEmit + vite build 通过（重点盯 TS6133：`haversineM` import 已删干净）。（不 commit）

---

## 验收（实施后，人工）

1. `npm run dev`（端口 5173）→ 有头 Edge 打开。
2. analysis 模式：4 chips + HTML 风格两图；数值与改造前一致（同数据同函数）。
3. demo 模式：播放中 chips/两图 ~2Hz 更新、红字读数即时；上方统一面板 + 下方时间窗回放图。
4. 拖到终点：chips 收敛为全量统计精确值。
5. 0042 + Tunnel 60s：DR Max Drift 逐帧爬升到 ~66.86m；0093 隧道 Off：DR Max Drift chip 仍在。
