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
