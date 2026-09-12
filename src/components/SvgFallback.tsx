import { useMemo, useState } from 'react'
import { toLocalM, yawToCompassDeg, thinByTimestamp, type LatLng } from '../lib/geo'
import { getMarkerPopup, type MarkerType } from '../lib/markerInfo'
import type { DerivedPoint, TrajPoint } from '../types'

export interface SvgFallbackProps {
  trace: TrajPoint[]
  derived: DerivedPoint[]
  width: number
  height: number
  upToIndex?: number
  car?: { lat: number; lng: number; compassDeg: number }
  drPath?: Array<[number, number]>
  gnssPath?: TrajPoint[]
  interactive?: boolean
}



const SCALE_BAR_STEPS_M = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]

/** 无底图 SVG 渲染：等距圆柱投影（标准纬线取 bbox 中点纬度，x 乘 cos(midLat)——防 49° 纬度图形 1.52× 横向变形），
 *  复用 geo.toLocalM（以 bbox 中心为原点）避免两套投影实现分叉。 */
export default function SvgFallback({
  trace,
  derived,
  width,
  height,
  upToIndex,
  car,
  drPath,
  gnssPath,
  interactive,
}: SvgFallbackProps) {
  const [selected, setSelected] = useState<{ type: MarkerType; index: number } | null>(null)
  const geo = useMemo(() => {
    const dots = gnssPath ?? trace
    // drPath 一并入 bbox（评审 minor 修正）：0093 尾段 15.5s 纯递推分离可达 26m 级，不纳入则紫线被画幅裁剪
    // gnssPath 同理入画幅（Step6）：冻结位置可能在真值轨迹 bbox 之外（如全程失锁的 0106 型轨迹）
    const all: LatLng[] = [
      ...trace.map((t) => [t.lat, t.lng] as LatLng),
      ...dots.map((t) => [t.lat, t.lng] as LatLng),
      ...derived.map((d) => [d.matchedLatLng[0], d.matchedLatLng[1]] as LatLng),
      ...(drPath ?? []),
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
    // 比例尺（左下角，按米标定）：取最接近 12% 视宽的整刻度
    const metersPerUnit = 1 / unitsPerMeter
    const targetM = vw * 0.12 * metersPerUnit
    const barM = SCALE_BAR_STEPS_M.reduce((a, b) => (Math.abs(b - targetM) < Math.abs(a - targetM) ? b : a))
    const barUnits = barM / metersPerUnit
    const barLabel = barM >= 1000 ? `${barM / 1000} km` : `${barM} m`
    const barX = 24
    const barY = vh - 24

    return {
      vw, vh, xy,
      thin: thinByTimestamp((gnssPath ?? trace).map((p) => p.timestamp), 1.0, 200),
      thinDr: drPath ? Array.from({ length: drPath.length }, (_, i) => i).filter((i) => i % Math.max(1, Math.ceil(drPath.length / 800)) === 0) : [],
      thinMm: derived.length > 0 ? thinByTimestamp(trace.slice(0, derived.length).map((p) => p.timestamp), 1.0, 200) : [],
      barX, barY, barUnits, barLabel,
    }
  }, [trace, derived, drPath, gnssPath])
  if (!geo) return null
  const { vw, vh, xy, thin, thinDr, thinMm, barX, barY, barUnits, barLabel } = geo
  // 仍以全量 trace+derived+drPath 定 bbox——回放期间画幅稳定不跳变（upTo/car 不进 useMemo 依赖）
  const upTo = upToIndex ?? trace.length - 1

  // 三层 z 序 = SVG 文档序（后者盖上者）。DR 层（紫虚线）规格：散点之上、匹配路线（蓝）之下；
  // drPath 缺省时保持 Step1 原序（匹配路径在下、散点在上）——既有轨迹渲染零改动。
  const drEl =
    drPath && drPath.length > 0 ? (
      <g data-testid="dr-path">
        <polyline
          points={drPath.map(([la, ln]) => xy([la, ln] as LatLng).join(',')).join(' ')}
          fill="none"
          stroke="rgba(234,179,8,0.4)"
          strokeWidth={1.5}
        />
        {thinDr.map((i) => {
          const [cx, cy] = xy(drPath[i])
          const hdg = trace[i] ? yawToCompassDeg(trace[i].headingDeg) : 0
          return (
            <polygon
              key={i}
              points={`${cx},${cy - 16} ${cx + 10},${cy + 8} ${cx},${cy + 2} ${cx - 10},${cy + 8}`}
              fill="#eab308"
              stroke="#a16207"
              strokeWidth={1.5}
              transform={`rotate(${hdg} ${cx} ${cy})`}
              style={interactive ? { cursor: 'pointer' } : undefined}
              onClick={interactive ? (e) => { e.stopPropagation(); setSelected({ type: 'dr', index: i }) } : undefined}
            />
          )
        })}
      </g>
    ) : null
  const matchedEl = (
    <g data-testid="matched-path">
      {thinMm.map((i) => {
        const [cx, cy] = xy(derived[i].matchedLatLng as LatLng)
        const hdg = yawToCompassDeg(derived[i].headingDeg)
        return (
          <polygon
            key={i}
            points={`${cx},${cy - 16} ${cx + 10},${cy + 8} ${cx},${cy + 2} ${cx - 10},${cy + 8}`}
            fill="#2563eb"
            stroke="#1e40af"
            strokeWidth={1.5}
            transform={`rotate(${hdg} ${cx} ${cy})`}
            style={interactive ? { cursor: 'pointer' } : undefined}
            onClick={interactive ? (e) => { e.stopPropagation(); setSelected({ type: 'mm', index: i }) } : undefined}
          />
        )
      })}
    </g>
  )
  // GNSS 散点（橙，抽稀；回放下只画已洒到的下标——filter 是每帧仅有的全量遍历）。
  // noFix 帧不画：失锁期接收机无定位解（真实或仿真隧道），画出来是一坨冻住的点，不如留白
  const gnssDots = gnssPath ?? trace
  const dotsEl = thin
    .filter((i) => i <= upTo && !gnssDots[i].noFix)
    .map((i) => {
      const [cx, cy] = xy([gnssDots[i].lat, gnssDots[i].lng])
      const hdg = yawToCompassDeg(gnssDots[i].headingDeg)
      return (
        <g
          key={i}
          data-testid="gnss-dot"
          transform={`rotate(${hdg} ${cx} ${cy})`}
          style={interactive ? { cursor: 'pointer' } : undefined}
          onClick={interactive ? (e) => { e.stopPropagation(); setSelected({ type: 'gnss', index: i }) } : undefined}
        >
          <circle cx={cx} cy={cy} r={8} fill="none" stroke="#9ca3af" strokeWidth={2.5} />
          <line x1={cx} y1={cy} x2={cx} y2={cy - 12} stroke="#9ca3af" strokeWidth={1.5} />
        </g>
      )
    })

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${vw} ${vh}`}
      style={{ maxWidth: '100%', height: 'auto' }}
      role="img"
      aria-label="无底图 SVG 轨迹渲染（GNSS 散点 + 匹配路径）"
      onClick={interactive && selected ? () => setSelected(null) : undefined}
    >
      {drEl ? (
        <>
          {dotsEl}
          {drEl}
          {matchedEl}
        </>
      ) : (
        <>
          {matchedEl}
          {dotsEl}
        </>
      )}

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

      {/* 回放车标：位置沿匹配路径，航向 = 罗盘航向（MapView 已从 IMU yaw 转换） */}
      {car && (
        <polygon
          data-testid="car-marker"
          points="0,-6 4.5,5 0,2.5 -4.5,5"
          transform={`translate(${xy([car.lat, car.lng]).join(' ')}) rotate(${car.compassDeg})`}
          fill="#1d4ed8"
          stroke="#ffffff"
          strokeWidth={1}
        />
      )}

      {/* 图例 */}
      <g data-testid="legend" transform={`translate(${vw - 140}, 16)`}>
        <rect width="130" height={drPath && drPath.length > 0 ? 100 : 76} rx="4" fill="white" fillOpacity="0.85" stroke="#d1d5db" strokeWidth="0.5" />
        <circle cx="16" cy="22" r="6" fill="none" stroke="#9ca3af" strokeWidth={2} />
        <line x1="16" y1="22" x2="16" y2="13" stroke="#9ca3af" strokeWidth={1} />
        <text x="34" y="26" fontSize="13" fill="#374151">GNSS</text>
        {drPath && drPath.length > 0 ? (
          <>
            <polygon points="16,36 24,54 16,50 8,54" fill="#eab308" stroke="#a16207" strokeWidth={1} />
            <text x="34" y="52" fontSize="13" fill="#374151">DR</text>
            <polygon points="16,62 24,80 16,76 8,80" fill="#2563eb" stroke="#1e40af" strokeWidth={1} />
            <text x="34" y="78" fontSize="13" fill="#374151">MM</text>
          </>
        ) : (
          <>
            <polygon points="16,36 24,54 16,50 8,54" fill="#2563eb" stroke="#1e40af" strokeWidth={1} />
            <text x="34" y="52" fontSize="13" fill="#374151">MM</text>
          </>
        )}
      </g>

      {/* 比例尺 */}
      <g data-testid="scale-bar">
        <line x1={barX} y1={barY} x2={barX + barUnits} y2={barY} stroke="#374151" strokeWidth={2} />
        <line x1={barX} y1={barY - 5} x2={barX} y2={barY + 5} stroke="#374151" strokeWidth={2} />
        <line x1={barX + barUnits} y1={barY - 5} x2={barX + barUnits} y2={barY + 5} stroke="#374151" strokeWidth={2} />
        <text x={barX + barUnits / 2} y={barY - 9} textAnchor="middle" fontSize={13} fill="#374151">
          {barLabel}
        </text>
      </g>

      {interactive && selected && (() => {
        const popup = getMarkerPopup(selected.type, selected.index, trace, gnssDots, drPath, derived)
        if (!popup) return null
        const pw = 250
        const ph = popup.lines.length * 18 + 56
        return (
          <g data-testid="marker-popup" transform="translate(20, 20)" onClick={(e) => e.stopPropagation()}>
            <rect width={pw} height={ph} rx={4} fill="white" fillOpacity={0.94} stroke="#d1d5db" strokeWidth={0.5} />
            <text x={12} y={22} fontSize={14} fontWeight="bold" fill="#1f2937">{popup.title}</text>
            <line x1={12} y1={30} x2={pw - 12} y2={30} stroke="#e5e7eb" strokeWidth={1} />
            {popup.lines.map(([label, value], j) => (
              <text key={j} x={12} y={48 + j * 18} fontSize={12} fill="#374151">
                <tspan fontWeight="bold">{label}</tspan>
                <tspan dx={8}>{value}</tspan>
              </text>
            ))}
            <text x={12} y={ph - 8} fontSize={10} fill="#9ca3af">点击空白处关闭</text>
          </g>
        )
      })()}
    </svg>
  )
}
