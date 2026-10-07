import { memo, useMemo, useState } from 'react'
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
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
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
function StatsPanelImpl({ trace, derived, driftM, upToIndex }: StatsPanelProps) {
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

/** memo：demo 模式下 App 以 60Hz（pb.pos）重渲染，而本面板只消费 pb.index——
 *  props 均为稳定引用/原始值，memo 把重渲压到 index 变化频率（最终审查 minor #2） */
export default memo(StatsPanelImpl)
