import type { CSSProperties } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts'
import type { DerivedPoint, TrajPoint } from '../types'
import { deviationHistogram, deviationStats, deviationVsDistance } from '../lib/stats'

export interface StatsPanelProps {
  trace: TrajPoint[]
  derived: DerivedPoint[]
  /** 失锁/隧道期 DR 推算位置与真值的最大偏差（米）。缺省（无 DR 层）不渲染该 chip。
   *  与上面三个 chip 的口径不同：那三个是「真值→匹配路线」（MM 绑路精度），
   *  这一个是「DR→真值」（DR 自由递推的漂移量）——演示口径即「DR 漂了 67m，MM 绑路后 X m」。 */
  drMaxDriftM?: number
}

// 固定尺寸而非 ResponsiveContainer：jsdom 无 ResizeObserver，显式宽高保证可测且侧栏宽度恒定
const CHART_W = 340
const CHART_H = 180

const panelStyle: CSSProperties = {
  width: '100%',
  padding: '0.75rem',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
}
const chipStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2,
  padding: '0.5rem 0.25rem',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  background: '#f9fafb',
  flex: 1,
}
const chartTitleStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#374151',
  marginTop: '0.75rem',
  marginBottom: '0.25rem',
}

/** 偏差统计侧栏：汇总 chips（均值/95分位/最大）+ 直方图 + 偏差-里程曲线（视图零实时计算的落点） */
export default function StatsPanel({ trace, derived, drMaxDriftM }: StatsPanelProps) {
  if (derived.length === 0) {
    return (
      <aside style={panelStyle}>
        <h2 style={chartTitleStyle}>偏差统计</h2>
        <p style={{ fontSize: 13, color: '#6b7280' }}>暂无偏差数据</p>
      </aside>
    )
  }

  const stats = deviationStats(derived)
  const { bins } = deviationHistogram(derived)
  const histData = bins.map((b) => ({
    range: `${b.fromM.toFixed(1)}–${b.toM.toFixed(1)}`,
    count: b.count,
  }))
  const distData = deviationVsDistance(derived, trace).map((p) => ({
    distanceKm: p.distanceM / 1000,
    deviationM: p.deviationM,
  }))
  const chips: Array<[string, number]> = [
    ['均值', stats.meanM],
    ['95分位', stats.p95M],
    ['最大', stats.maxM],
  ]
  if (drMaxDriftM !== undefined) chips.push(['DR 漂移', drMaxDriftM])

  return (
    <aside style={panelStyle}>
      <h2 style={{ ...chartTitleStyle, marginTop: 0 }}>偏差统计</h2>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {chips.map(([label, v]) => (
          <div key={label} data-testid="stat-chip" style={chipStyle}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>{label}</span>
            <strong style={{ fontSize: 15 }}>{v.toFixed(2)} m</strong>
          </div>
        ))}
      </div>

      <h2 style={chartTitleStyle}>偏差分布直方图</h2>
      <BarChart width={CHART_W} height={CHART_H} data={histData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="range" tick={false} label={{ value: '横向偏差 (m)', position: 'insideBottom', offset: -2, fontSize: 11 }} />
        <YAxis allowDecimals={false} width={28} />
        <Tooltip />
        <Bar dataKey="count" name="点数" fill="#2563eb" />
      </BarChart>

      <h2 style={chartTitleStyle}>偏差 – 里程曲线</h2>
      <AreaChart width={CHART_W} height={CHART_H} data={distData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis
          dataKey="distanceKm"
          type="number"
          domain={['auto', 'auto']}
          tickFormatter={(v: number) => v.toFixed(1)}
          label={{ value: '沿轨迹里程 (km)', position: 'insideBottom', offset: -2, fontSize: 11 }}
        />
        <YAxis width={28} />
        <Tooltip formatter={(v) => `${Number(v).toFixed(2)} m`} />
        <Area dataKey="deviationM" name="横向偏差" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.25} strokeWidth={1.5} dot={false} />
      </AreaChart>
    </aside>
  )
}
