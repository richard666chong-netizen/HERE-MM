import { useMemo } from 'react'
import { toLocalM, type LatLng } from '../lib/geo'
import type { DerivedPoint, TrajPoint } from '../types'

export interface SvgFallbackProps {
  trace: TrajPoint[]
  derived: DerivedPoint[]
  width: number
  height: number
  /** 回放：散点/终点标记只画到该下标（含）。缺省 = 全量 */
  upToIndex?: number
  /** 回放车标（undefined = 无）。位置/航向由 MapView 归一后传入 */
  car?: { lat: number; lng: number; headingDeg: number }
}

/** GNSS 散点抽稀：每 ⌈n/800⌉ 取 1，始终保留首尾点 */
function thinIndices(n: number): number[] {
  if (n <= 0) return []
  const stride = Math.ceil(n / 800)
  const out: number[] = []
  for (let i = 0; i < n; i += stride) out.push(i)
  if (out[out.length - 1] !== n - 1) out.push(n - 1)
  return out
}

const SCALE_BAR_STEPS_M = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]

/** 无底图 SVG 渲染：等距圆柱投影（标准纬线取 bbox 中点纬度，x 乘 cos(midLat)——防 49° 纬度图形 1.52× 横向变形），
 *  复用 geo.toLocalM（以 bbox 中心为原点）避免两套投影实现分叉。 */
export default function SvgFallback({ trace, derived, width, height, upToIndex, car }: SvgFallbackProps) {
  const geo = useMemo(() => {
    const all: LatLng[] = [
      ...trace.map((t) => [t.lat, t.lng] as LatLng),
      ...derived.map((d) => [d.matchedLatLng[0], d.matchedLatLng[1]] as LatLng),
    ]
    if (all.length === 0) return null

    let minLat = Infinity
    let maxLat = -Infinity
    let minLng = Infinity
    let maxLng = -Infinity
    for (const [lat, lng] of all) {
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
    }
    const center: LatLng = [(minLat + maxLat) / 2, (minLng + maxLng) / 2]

    // SVG y 轴向下：y 取负让正北朝上
    const project = (p: LatLng): [number, number] => {
      const [xM, yM] = toLocalM(p, center)
      return [xM, -yM]
    }

    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const p of all) {
      const [x, y] = project(p)
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }

    // bbox 加 5% 边距；跨度退化（单点/共线）兜底 1m，防 viewBox 零尺寸
    const spanX = Math.max(x1 - x0, 1)
    const spanY = Math.max(y1 - y0, 1)
    const padX = spanX * 0.05
    const padY = spanY * 0.05
    const vbX = x0 - padX
    const vbY = y0 - padY
    const vbW = spanX + 2 * padX
    const vbH = spanY + 2 * padY

    // 归一化：最长边映射到 1000 单位——r=1.5 / stroke=1.5 即像素级观感
    const unitsPerMeter = 1000 / Math.max(vbW, vbH)
    const vw = vbW * unitsPerMeter
    const vh = vbH * unitsPerMeter
    const xy = (p: LatLng): [number, number] => {
      const [x, y] = project(p)
      return [(x - vbX) * unitsPerMeter, (y - vbY) * unitsPerMeter]
    }
    const xyStr = (p: LatLng): string => {
      const [x, y] = xy(p)
      return `${x},${y}`
    }

    // 比例尺（左下角，按米标定）：取最接近 12% 视宽的整刻度
    const metersPerUnit = 1 / unitsPerMeter
    const targetM = vw * 0.12 * metersPerUnit
    const barM = SCALE_BAR_STEPS_M.reduce((a, b) => (Math.abs(b - targetM) < Math.abs(a - targetM) ? b : a))
    const barUnits = barM / metersPerUnit
    const barLabel = barM >= 1000 ? `${barM / 1000} km` : `${barM} m`
    const barX = 24
    const barY = vh - 24

    return {
      vw, vh, xy, xyStr,
      thin: thinIndices(trace.length),
      barX, barY, barUnits, barLabel,
    }
  }, [trace, derived])
  if (!geo) return null
  const { vw, vh, xy, xyStr, thin, barX, barY, barUnits, barLabel } = geo
  // 仍以全量 trace+derived 定 bbox——回放期间画幅稳定不跳变（upTo/car 不进 useMemo 依赖）
  const upTo = upToIndex ?? trace.length - 1

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${vw} ${vh}`}
      style={{ maxWidth: '100%', height: 'auto' }}
      role="img"
      aria-label="无底图 SVG 轨迹渲染（GNSS 散点 + 匹配路径）"
    >
      {/* 匹配路径折线（蓝） */}
      <polyline
        data-testid="matched-path"
        points={derived.map((d) => xyStr(d.matchedLatLng as LatLng)).join(' ')}
        fill="none"
        stroke="#2563eb"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* GNSS 散点（橙，抽稀；回放下只画已洒到的下标——filter 是每帧仅有的全量遍历） */}
      {thin
        .filter((i) => i <= upTo)
        .map((i) => {
          const [cx, cy] = xy([trace[i].lat, trace[i].lng])
          return <circle key={i} data-testid="gnss-dot" cx={cx} cy={cy} r={1.5} fill="#f59e0b" />
        })}

      {/* 起点（绿）恒显；终点（红）行进到才出现 */}
      {trace.length > 0 && (
        <>
          <circle
            data-testid="endpoint-marker"
            cx={xy([trace[0].lat, trace[0].lng])[0]}
            cy={xy([trace[0].lat, trace[0].lng])[1]}
            r={4.5}
            fill="#16a34a"
            stroke="#ffffff"
            strokeWidth={1}
          >
            <title>起点</title>
          </circle>
          {upTo >= trace.length - 1 && (
            <circle
              data-testid="endpoint-marker"
              cx={xy([trace[trace.length - 1].lat, trace[trace.length - 1].lng])[0]}
              cy={xy([trace[trace.length - 1].lat, trace[trace.length - 1].lng])[1]}
              r={4.5}
              fill="#dc2626"
              stroke="#ffffff"
              strokeWidth={1}
            >
              <title>终点</title>
            </circle>
          )}
        </>
      )}

      {/* 回放车标：位置沿匹配路径，航向 = IMU yaw */}
      {car && (
        <polygon
          data-testid="car-marker"
          points="0,-6 4.5,5 0,2.5 -4.5,5"
          transform={`translate(${xy([car.lat, car.lng]).join(' ')}) rotate(${car.headingDeg})`}
          fill="#1d4ed8"
          stroke="#ffffff"
          strokeWidth={1}
        />
      )}

      {/* 比例尺 */}
      <g data-testid="scale-bar">
        <line x1={barX} y1={barY} x2={barX + barUnits} y2={barY} stroke="#374151" strokeWidth={2} />
        <line x1={barX} y1={barY - 5} x2={barX} y2={barY + 5} stroke="#374151" strokeWidth={2} />
        <line x1={barX + barUnits} y1={barY - 5} x2={barX + barUnits} y2={barY + 5} stroke="#374151" strokeWidth={2} />
        <text x={barX + barUnits / 2} y={barY - 9} textAnchor="middle" fontSize={13} fill="#374151">
          {barLabel}
        </text>
      </g>
    </svg>
  )
}
