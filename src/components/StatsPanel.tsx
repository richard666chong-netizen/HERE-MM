import { useState } from 'react'
import type { CSSProperties } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts'
import type { DerivedPoint, TrajPoint } from '../types'
import { deviationHistogram, deviationStats, deviationVsDistance } from '../lib/stats'

export interface StatsPanelProps {
  trace: TrajPoint[]
  derived: DerivedPoint[]
  /** 失锁/隧道期本地 DR 推算位置与 OXTS 输出的最大偏差（米）。缺省（无 DR 层）不渲染该 chip。
   *  与上面三个 chip 的口径不同：那三个是「本地 DR → HERE MM 匹配路线」（MM 纠偏量）,
   *  这一个是「本地 DR → OXTS 输出」（两种 DR 算法精度差距）——演示口径即「DR 漂了 67m，MM 绑路后 X m」。
   *  注意：OXTS 输出不是独立高精度真值, 而是同一套传感器更精密的 INS 融合解。 */
  drMaxDriftM?: number
}

const CHART_W = 340
const CHART_H = 180

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
      <span style={{ fontSize: 12, color: '#6b7280' }}>{chip.label}</span>
      <strong style={{ fontSize: 15 }}>{chip.value.toFixed(2)} m</strong>
      {open && (
        <div style={POPOVER_STYLE}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{chip.label}</div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{chip.tooltip}</div>
        </div>
      )}
    </div>
  )
}

/** 偏差统计侧栏：汇总 chips（均值/95分位/最大）+ 直方图 + 偏差-里程曲线（视图零实时计算的落点） */
export default function StatsPanel({ trace, derived, drMaxDriftM }: StatsPanelProps) {
  if (derived.length === 0) {
    return (
      <aside style={panelStyle}>
        <h2 style={chartTitleStyle}>Deviation Stats</h2>
        <p style={{ fontSize: 13, color: '#6b7280' }}>No deviation data</p>
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

  const chips: ChipDef[] = [
    {
      label: 'Mean',
      value: stats.meanM,
      tooltip: 'Arithmetic mean of lateral deviation across all trajectory points.\n\nA: Local DR estimated position (heading + speed simplified integration, 1Hz GNSS correction)\nB: Nearest projection point on HERE MM matched polyline\n\nCalculation: sum(deviationM[]) / n\nSemantics: Average correction by MM on DR',
    },
    {
      label: 'P95',
      value: stats.p95M,
      tooltip: '95% of points have deviation below this value.\n\nA: Local DR estimated position\nB: HERE MM matched polyline projection\n\nCalculation: Nearest rank method: sorted[ceil(0.95 * n) - 1]\nSemantics: Deviation upper bound excluding worst 5%, common OEM acceptance metric',
    },
    {
      label: 'Max',
      value: stats.maxM,
      tooltip: 'Maximum single-point deviation across the trajectory.\n\nA: Local DR estimated position\nB: HERE MM matched polyline projection\n\nCalculation: sorted[n - 1]\nSemantics: Worst-case DR deviation from road network',
    },
  ]
  if (drMaxDriftM !== undefined) {
    chips.push({
      label: 'DR Drift',
      value: drMaxDriftM,
      tooltip: 'Maximum deviation between local DR and OXTS output.\n\nA: Local DR estimated position (heading + speed simplified integration)\nB: KITTI oxts output (OXTS RT3000 GNSS+INS fused solution, INS bridged during signal loss)\n\nCalculation: max(haversineM(DR[i], OXTS[i]))\nSemantics: Precision gap between two DR algorithms\n\nNote: OXTS output is not an independent ground truth, but a more sophisticated INS fusion from the same sensor suite',
    })
  }

  return (
    <aside style={panelStyle}>
      <h2 style={{ ...chartTitleStyle, marginTop: 0 }}>Deviation Stats</h2>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {chips.map((chip) => (
          <InfoChip key={chip.label} chip={chip} />
        ))}
      </div>

      <h2 style={chartTitleStyle}>Deviation Histogram</h2>
      <BarChart width={CHART_W} height={CHART_H} data={histData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis dataKey="range" tick={false} label={{ value: 'Lateral Deviation (m)', position: 'insideBottom', offset: -2, fontSize: 11 }} />
        <YAxis allowDecimals={false} width={28} />
        <Tooltip />
        <Bar dataKey="count" name="Count" fill="#2563eb" />
      </BarChart>

      <h2 style={chartTitleStyle}>Deviation vs. Distance</h2>
      <AreaChart width={CHART_W} height={CHART_H} data={distData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis
          dataKey="distanceKm"
          type="number"
          domain={['auto', 'auto']}
          tickFormatter={(v: number) => v.toFixed(1)}
          label={{ value: 'Distance (km)', position: 'insideBottom', offset: -2, fontSize: 11 }}
        />
        <YAxis width={28} />
        <Tooltip formatter={(v) => `${Number(v).toFixed(2)} m`} />
        <Area dataKey="deviationM" name="Lateral Deviation" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.25} strokeWidth={1.5} dot={false} />
      </AreaChart>
    </aside>
  )
}
