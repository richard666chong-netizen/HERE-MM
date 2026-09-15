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
  showMm?: boolean
  interactive?: boolean
}



const SCALE_BAR_STEPS_M = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]

/** 无底图 SVG 渲染：等距圆柱投影（标准纬线取 bbox 中点纬度，x 乘 cos(midLat)——防 49° 纬度图形 1.52× 横向变形），
 *  复用 geo.toLocalM（以 bbox 中心为原点）避免两套投影实现分叉。 */
export default function SvgFallback({
  trace,
  derived,
  width: _width,
  height: _height,
  upToIndex,
  car,
  drPath,
  gnssPath,
  showMm = true,
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
  const matchedEl = showMm ? (
    <g data-testid="matched-path">
      <polyline
        points={derived.map((d) => xy(d.matchedLatLng as LatLng).join(',')).join(' ')}
        fill="none"
        stroke="rgba(37,99,235,0.7)"
        strokeWidth={2}
      />
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
  ) : null
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
          <circle cx={cx} cy={cy} r={6} fill="none" stroke="#9ca3af" strokeWidth={2} />
          <line x1={cx} y1={cy} x2={cx} y2={cy - 9} stroke="#9ca3af" strokeWidth={1.2} />
        </g>
      )
    })

  // 导航跟随模式：车标固定在容器中心（HTML 叠层），轨迹层 translate+rotate 跟随车辆。
  // rotate(-compassDeg)：SVG y 轴朝下，arrow tip 在 y=-18（朝上=北）。
  //   compassDeg=0（北）→ rotate(0) → 箭头朝上 ✓
  //   compassDeg=90（东）→ rotate(-90) → 箭头朝右（东）✓  （SVG rotate 负=逆时针=CCW）
  //   等价于将轨迹层逆时针旋转 compassDeg，使行驶方向指向屏幕上方
  const [carSvgX, carSvgY] = car ? xy([car.lat, car.lng]) : [0, 0]
  const fixX = vw / 2
  const fixY = vh / 2
  const worldTransform = car
    ? `translate(${fixX - carSvgX} ${fixY - carSvgY}) rotate(${-car.compassDeg} ${carSvgX} ${carSvgY})`
    : undefined

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${vw} ${vh}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block', width: '100%', height: '100%' }}
      role="img"
      aria-label="SVG trajectory render without basemap (GNSS dots + matched path)"
      onClick={interactive && selected ? () => setSelected(null) : undefined}
    >
      {/* 导航跟随：有车标时轨迹层包裹在 transform <g> 中——地图随车位移+旋转，车标固定屏幕位置 */}
      {(() => {
        const trajectory = (
          <>
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
                  <title>Start</title>
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
                    <title>End</title>
                  </circle>
                )}
              </>
            )}
          </>
        )
        return car ? <g transform={worldTransform}>{trajectory}</g> : trajectory
      })()}

      {/* 图例 */}
      <g data-testid="legend" transform={`translate(${vw - 140}, 16)`}>
        <rect width="130" height={52 + (drPath && drPath.length > 0 ? 24 : 0) + (showMm ? 24 : 0)} rx="4" fill="white" fillOpacity="0.85" stroke="#d1d5db" strokeWidth="0.5" />
        <circle cx="16" cy="22" r="6" fill="none" stroke="#9ca3af" strokeWidth={2} />
        <line x1="16" y1="22" x2="16" y2="13" stroke="#9ca3af" strokeWidth={1} />
        <text x="34" y="26" fontSize="13" fill="#374151">GNSS</text>
        {drPath && drPath.length > 0 ? (
          <>
            <polygon points="16,36 24,54 16,50 8,54" fill="#eab308" stroke="#a16207" strokeWidth={1} />
            <text x="34" y="52" fontSize="13" fill="#374151">DR</text>
            {showMm ? (
              <>
                <polygon points="16,62 24,80 16,76 8,80" fill="#2563eb" stroke="#1e40af" strokeWidth={1} />
                <text x="34" y="78" fontSize="13" fill="#374151">MM</text>
              </>
            ) : null}
          </>
        ) : showMm ? (
          <>
            <polygon points="16,36 24,54 16,50 8,54" fill="#2563eb" stroke="#1e40af" strokeWidth={1} />
            <text x="34" y="52" fontSize="13" fill="#374151">MM</text>
          </>
        ) : null}
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
            <text x={12} y={ph - 8} fontSize={10} fill="#9ca3af">Click outside to close</text>
          </g>
        )
      })()}
    </svg>

    {/* 车标 HTML 叠层：固定像素大小，始终在容器中心，不受 SVG viewBox 缩放影响 */}
    {car && (
      <div
        data-testid="car-marker"
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
          zIndex: 10,
          width: 0,
          height: 0,
        }}
      >
         <svg width="60" height="60" viewBox="-30 -30 60 60" style={{ position: 'absolute', left: -30, top: -30, overflow: 'visible' }}>
           <circle
             data-testid="car-position-circle"
             cx="0" cy="0" r="26"
             fill="none" stroke="#1d4ed8" strokeWidth="3" opacity="0.3"
           />
           {/* arrow: tip at y=-18 (up in SVG = screen up). After worldTransform rotate, this should point toward movement direction */}
           <polygon
             points="0,-18 13,15 0,7 -13,15"
             fill="#1d4ed8" stroke="#ffffff" strokeWidth="2.5"
           />
           {/* DEBUG: north indicator — a small red line pointing up (SVG -y) to show where "north" is after rotation */}
           <line x1="0" y1="-28" x2="0" y2="-22" stroke="#ef4444" strokeWidth="2" />
         </svg>
      </div>
    )}
    </div>
  )
}
