import { memo, useMemo } from 'react'
import { Area, AreaChart, Tooltip, XAxis, YAxis } from 'recharts'
import { sliceWindow } from '../lib/playback'
import type { DerivedPoint, TrajPoint } from '../types'

export interface DeviationReplayChartProps {
  trace: TrajPoint[]
  derived: DerivedPoint[]
  index: number
  windowSec?: number
}

// 固定尺寸（jsdom 无 ResizeObserver，沿用 StatsPanel 约定）；isAnimationActive=false 防逐帧动画卡顿
const CHART_W = 340
const CHART_H = 150

interface WindowPoint {
  t: number
  deviationM: number
}

/** memo 子组件：props 均为稳定引用/原始值——父级 50Hz 重渲染下 AreaChart 只随 tQ/win 变化重渲（评审 major 修法） */
const ReplayAreaChart = memo(function ReplayAreaChart({
  data,
  from,
  to,
  ymax,
}: {
  data: WindowPoint[]
  from: number
  to: number
  ymax: number
}) {
  return (
    <AreaChart width={CHART_W} height={CHART_H} data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
      <XAxis dataKey="t" type="number" domain={[from, to]} tickFormatter={(v: number) => `${v.toFixed(0)}s`} />
      <YAxis width={28} domain={[0, ymax]} />
      <Tooltip formatter={(v) => `${Number(v).toFixed(2)} m`} />
      <Area
        dataKey="deviationM"
        name="Lateral Deviation"
        stroke="#2563eb"
        fill="#2563eb"
        fillOpacity={0.2}
        strokeWidth={1.5}
        dot={false}
        isAnimationActive={false}
      />
    </AreaChart>
  )
})

/** 回放联动偏差曲线（spec L48「偏差曲线随时间滚动联动」）：自适应滑窗 + 0.5s 量化 + 当前值读数全速跟随 */
export default function DeviationReplayChart({ trace, derived, index, windowSec = 30 }: DeviationReplayChartProps) {
  const series = useMemo(
    () => trace.map((p, i) => ({ t: p.timestamp, deviationM: derived[i]?.deviationM ?? 0 })),
    [trace, derived],
  )
  // Y 轴钉死全程最大（每序列一次，非逐帧）：滑窗间偏差幅值视觉可比（审查 minor 采纳）
  const yMax = useMemo(() => Math.ceil(Math.max(0, ...series.map((p) => p.deviationM))) || 1, [series])
  const total = trace.length > 0 ? trace[trace.length - 1].timestamp : 0
  // 自适应窗口：短轨迹取半程滑窗（0011 全长 23.2s → ~11.6s），保证「滚动」语义
  const win = Math.min(windowSec, Math.max(5, total / 2))
  const lastIdx = Math.min(trace.length, derived.length) - 1
  const i = lastIdx >= 0 ? Math.min(index, lastIdx) : 0
  const tCur = trace.length > 0 ? trace[Math.min(i, trace.length - 1)].timestamp : 0
  const tQ = Math.floor(tCur * 2) / 2 // 0.5s 档量化：图表重渲 ≤10 次/秒（5x），读数仍全速
  const data = useMemo(() => sliceWindow(series, tQ, win), [series, tQ, win])
  const from = Math.max(0, tQ - win) // 计算一次，XAxis domain 与 data-from 测试钩子共用（不可分叉）

  if (derived.length === 0 || trace.length === 0) {
    return <p style={{ fontSize: 13, color: '#6b7280' }}>No deviation data</p>
  }

  return (
    <aside
      data-length={data.length}
      data-from={from.toFixed(1)}
      data-ymax={String(yMax)}
      style={{ width: '100%', padding: '0.75rem', border: '1px solid #e5e7eb', borderRadius: 8 }}
    >
      <h2 style={{ fontSize: 13, fontWeight: 600, color: '#374151', margin: '0 0 0.25rem' }}>
        Deviation – Time (Replay)
      </h2>
      <div data-testid="replay-deviation" style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
        {derived[i].deviationM.toFixed(1)} m
      </div>
      <ReplayAreaChart data={data} from={from} to={Math.max(tQ, win)} ymax={yMax} />
    </aside>
  )
}
