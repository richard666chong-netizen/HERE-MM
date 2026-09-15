import { useEffect, useMemo, useRef, useState } from 'react'
import SvgFallback from './SvgFallback'
import { yawToCompassDeg, thinByTimestamp } from '../lib/geo'
import { interpCarPos, interpHeadingDeg } from '../lib/playback'
import { getMarkerPopup, type MarkerType } from '../lib/markerInfo'
import type { DerivedPoint, TrajPoint } from '../types'

export interface MapViewProps {
  trace: TrajPoint[]
  derived: DerivedPoint[]
  mapStatus: 'ok' | 'fallback'
  apikey: string
  /** 回放：GNSS 散点洒到该下标（含）。缺省 = 全量（静态模式） */
  upToIndex?: number
  /** 回放：车标浮点位置——位置取相邻垂足插值（interpCarPos），航向取 IMU yaw 最短弧插值（interpHeadingDeg）。缺省 = 无车标 */
  carPos?: number
  /** DR 航位推算轨迹（缺省不渲染）。紫折线：匹配路线（蓝）之下；并计入 setLookAtData bounds 防初始视野裁剪 */
  drPath?: Array<[number, number]>
  /** 「接收机实际报的 GNSS」流（缺省 = trace）——散点从它画，`noFix` 帧不画。
   *  与 trace 同下标对齐；失锁期位置被冻结，故直接省略而非画一坨不动的点。 */
  gnssPath?: TrajPoint[]
  /** 是否渲染 MM 匹配路径蓝色箭头（客户演示模式隐藏） */
  showMm?: boolean
  interactive?: boolean
}

/** HERE Maps JS API 3.1 命名空间的最小结构声明——script 标签加载、无官方 npm 类型。
 *  'ok' 路径仅在真实浏览器执行（手动验收覆盖），jsdom 测试只覆盖 fallback 路径。 */
interface HereDefaultLayers {
  vector: { normal: { map: unknown } }
  raster: { normal: { map: unknown } }
}

interface HereMarker {
  setGeometry(coord: { lat: number; lng: number }): void
  setIcon(icon: unknown): void
  addEventListener(event: string, handler: () => void): void
}

interface HereMap {
  addObject(obj: unknown): void
  removeObject(obj: unknown): void
  setCenter(coord: { lat: number; lng: number }): void
  setZoom(z: number): void
  getZoom(): number
  getViewModel(): { setLookAtData(data: { bounds?: unknown; zoom?: number; tilt?: number; heading?: number; center?: { lat: number; lng: number } }): void }
  dispose(): void
}

interface HereNS {
  /** 地图实例本体是顶层 H.Map（Step1 实证），H.map.* 是地图对象命名空间 */
  Map: new (
    el: HTMLElement,
    layer: unknown,
    opts?: { zoom?: number; center?: { lat: number; lng: number } },
  ) => HereMap
  service: {
    Platform: new (opts: { apikey: string }) => { createDefaultLayers: () => HereDefaultLayers }
  }
  map: {
    Polyline: new (
      lineString: unknown,
      opts?: { style?: { strokeColor?: string; lineWidth?: number } },
    ) => unknown
    Circle: new (
      center: { lat: number; lng: number },
      radiusM: number,
      opts?: { style?: { fillColor?: string; strokeColor?: string; lineWidth?: number } },
    ) => unknown
    Marker: new (
      coord: { lat: number; lng: number },
      opts?: { icon?: unknown; volatility?: boolean },
    ) => HereMarker
    Icon: new (svg: string, opts?: { anchor?: { x: number; y: number } }) => unknown
  }
  geo: {
    LineString: new () => { pushPoint: (coord: { lat: number; lng: number }) => void; pushLatLngAlt: (lat: number, lng: number, alt?: number) => void }
    Rect: new (top: number, left: number, bottom: number, right: number) => unknown
  }
  mapevents: {
    MapEvents: new (map: HereMap) => unknown
    Behavior: new (events: unknown) => { dispose(): void }
  }
}

function getHere(): HereNS | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { H?: HereNS }).H ?? null
}



/** 车标图标：SVG 箭头烘焙航向（HERE 3.1 marker 无原生 rotation），5° 分桶缓存（≤72 个）。
 *  评审已实证 opts.anchor 平面对象可行（官方 3.1 文档示例即用字面量），无需兜底；
 *  运行时预案（Errata 模式）仅剩：若 marker.setGeometry/setIcon 不存在，退化为每帧 removeObject + addObject 重建车标。 */
function carIcon(here: HereNS, cache: Map<number, unknown>, compassDeg: number, size = 56): unknown {
  const bucket = ((Math.round(compassDeg / 5) * 5) % 360 + 360) % 360
  const key = size === 56 ? bucket : bucket + 1000
  let icon = cache.get(key)
  if (!icon) {
    const half = size / 2
    const r = size * 0.43
    const tip = size * 0.14
    const base = size * 0.86
    const left = size * 0.29
    const right = size * 0.71
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<circle cx="${half}" cy="${half}" r="${r}" fill="none" stroke="#1d4ed8" stroke-width="4" stroke-opacity="0.35"/>` +
      `<polygon points="${half},${tip} ${left},${base} ${half},${base*0.79} ${right},${base}" fill="#1d4ed8" stroke="#ffffff" stroke-width="3" ` +
      `transform="rotate(${bucket} ${half} ${half})"/></svg>`
    icon = new here.map.Icon(svg, { anchor: { x: half, y: half } })
    cache.set(key, icon)
  }
  return icon
}

type IconMarkerType = 'gnss' | 'dr' | 'mm'

function markerIcon(
  here: HereNS,
  cache: Map<string, unknown>,
  type: IconMarkerType,
  compassDeg: number,
): unknown {
  const bucket = ((Math.round(compassDeg / 5) * 5) % 360 + 360) % 360
  const key = `${type}:${bucket}`
  let icon = cache.get(key)
  if (!icon) {
    let svg: string
    if (type === 'gnss') {
      svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">` +
        `<circle cx="14" cy="14" r="9" fill="none" stroke="#9ca3af" stroke-width="2.5"/>` +
        `<line x1="14" y1="14" x2="14" y2="3" stroke="#9ca3af" stroke-width="1.5" ` +
        `transform="rotate(${bucket} 14 14)"/></svg>`
    } else if (type === 'dr') {
      svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">` +
        `<polygon points="20,3 31,29 20,22 9,29" fill="#eab308" stroke="#a16207" stroke-width="1.5" ` +
        `transform="rotate(${bucket} 20 20)"/></svg>`
    } else {
      svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">` +
        `<polygon points="20,3 31,29 20,22 9,29" fill="#2563eb" stroke="#1e40af" stroke-width="1.5" ` +
        `transform="rotate(${bucket} 20 20)"/></svg>`
    }
    const half = type === 'gnss' ? 14 : 20
    icon = new here.map.Icon(svg, { anchor: { x: half, y: half } })
    cache.set(key, icon)
  }
  return icon
}

/** 地图视图：mapStatus='ok' 初始化 HERE 地图（App 层保证此时 window.H 已就绪）；否则渲染无底图 SVG 兜底。
 *  Step2：upToIndex 归一为 upTo（缺省全量）→ HERE 散点走增量喷洒 effect；carPos 驱动车标。 */
export default function MapView({
  trace,
  derived,
  mapStatus,
  apikey,
  upToIndex,
  carPos,
  drPath,
  gnssPath,
  showMm = true,
  interactive,
}: MapViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [headingUp, setHeadingUp] = useState(false)
  const here = mapStatus === 'ok' ? getHere() : null
  const upTo = upToIndex ?? trace.length - 1
  const dots = gnssPath ?? trace
  const gnssSampleIdx = useMemo(
    () => thinByTimestamp(dots.map((p) => p.timestamp), 1.0, 200),
    [dots],
  )
  /** 车标状态（子帧插值唯一计算点）：HERE effect、SVG 兜底分支、heading-up 旋转三处共用 */
  const carState = useMemo(() => {
    if (carPos === undefined || trace.length === 0) return undefined
    const last = trace.length - 1
    const clamped = Math.max(0, Math.min(carPos, last))
    const i0 = Math.floor(clamped)
    const i1 = Math.min(i0 + 1, last)
    const frac = i0 === i1 ? 0 : clamped - i0
    const [lat, lng] = interpCarPos(clamped, trace, derived)
    return {
      lat,
      lng,
      compassDeg: yawToCompassDeg(interpHeadingDeg(trace[i0].headingDeg, trace[i1].headingDeg, frac)),
    }
  }, [carPos, trace, derived])
  const compassDeg = carState?.compassDeg ?? 0
  const [selected, setSelected] = useState<{ type: MarkerType; index: number } | null>(null)
  const interactiveRef = useRef(interactive)
  interactiveRef.current = interactive

  // HERE 路径回放状态（随组件卸载/建图重建重置；App 换轨迹时先 setData(null) 卸载本组件）
  const mapRef = useRef<HereMap | null>(null)
  const sprayedRef = useRef<number[]>([]) // 已洒下标（升序）
  const objRef = useRef<Array<unknown | null>>([]) // 与 sprayedRef 平行；noFix 帧占位 null（不画但记账）
  const dotsRef = useRef<TrajPoint[] | null>(null) // 账本所属散点源（换源即重洒）
  const sprayedMapRef = useRef<HereMap | null>(null) // 账本所属地图实例（stale-map 守卫）
  const carRef = useRef<HereMarker | null>(null)
  const endMarkerRef = useRef<HereMarker | null>(null)
  const iconCacheRef = useRef(new Map<number, unknown>())
  const triangleIconCacheRef = useRef(new Map<string, unknown>())

  // 建图 + 匹配路径（全量）+ 视野适配。声明顺序保证本 effect 先于喷洒/车标 effect 运行。
  useEffect(() => {
    if (!here || !hostRef.current) return
    const platform = new here.service.Platform({ apikey })
    const layers = platform.createDefaultLayers()
    const map = new here.Map(hostRef.current, layers.vector.normal.map, {
      zoom: 14,
      center: { lat: trace[0]?.lat ?? 49.01, lng: trace[0]?.lng ?? 8.44 },
    })
    // 拖拽/滚轮缩放交互（navigator 缩放）
    const behavior = new here.mapevents.Behavior(new here.mapevents.MapEvents(map))
    mapRef.current = map
    sprayedRef.current = []
    objRef.current = []
    sprayedMapRef.current = null
    dotsRef.current = dots
    carRef.current = null
    endMarkerRef.current = null
    triangleIconCacheRef.current = new Map()

    // DR 航位推算：polyline 连续线 + 稀疏方向箭头。HERE SDK marker >500 会 culling，
    // polyline 不受此限保证路径连续；箭头按等步长 ≤400 个做方向指示 + 点击弹窗。
    if (drPath && drPath.length > 0) {
      const ls = new here.geo.LineString()
      for (const [lat, lng] of drPath) ls.pushPoint({ lat, lng })
      map.addObject(
        new here.map.Polyline(ls, { style: { strokeColor: 'rgba(234,179,8,0.5)', lineWidth: 2 } }),
      )
      const drStride = Math.max(1, Math.ceil(drPath.length / 400))
      for (let i = 0; i < drPath.length; i += drStride) {
        const hdg = trace[i] ? yawToCompassDeg(trace[i].headingDeg) : 0
        const m = new here.map.Marker(
          { lat: drPath[i][0], lng: drPath[i][1] },
          { icon: markerIcon(here, triangleIconCacheRef.current, 'dr', hdg) },
        )
        m.addEventListener('tap', () => {
          if (interactiveRef.current) setSelected({ type: 'dr', index: i })
        })
        map.addObject(m)
      }
    }

    // 匹配路径点（蓝色三角，航向 = IMU yaw 透传）
    if (showMm && derived.length > 0) {
      const mmLs = new here.geo.LineString()
      for (const i of thinByTimestamp(trace.map((p) => p.timestamp), 0.1, 2000)) {
        if (!derived[i]) continue
        mmLs.pushPoint({ lat: derived[i].matchedLatLng[0], lng: derived[i].matchedLatLng[1] })
      }
      map.addObject(
        new here.map.Polyline(mmLs, { style: { strokeColor: 'rgba(37,99,235,0.7)', lineWidth: 4 } }),
      )
      for (const i of thinByTimestamp(trace.map((p) => p.timestamp), 1.0, 200)) {
        const hdg = yawToCompassDeg(derived[i].headingDeg)
        const m = new here.map.Marker(
          { lat: derived[i].matchedLatLng[0], lng: derived[i].matchedLatLng[1] },
          { icon: markerIcon(here, triangleIconCacheRef.current, 'mm', hdg) },
        )
        m.addEventListener('tap', () => {
          if (interactiveRef.current) setSelected({ type: 'mm', index: i })
        })
        map.addObject(m)
      }
    }

    // 起点标记（绿点，恒画）：终点红点归喷洒 effect（随回放进度增删），起点与进度无关故画在建图期
    if (trace.length > 0) {
      map.addObject(
        new here.map.Marker(
          { lat: trace[0].lat, lng: trace[0].lng },
          { icon: new here.map.Icon(
            '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="#16a34a" stroke="#fff" stroke-width="2"/></svg>',
            { anchor: { x: 10, y: 10 } },
          ) },
        ),
      )
    }

    // 视野适配：H.geo.Rect 构造参数顺序 = (top, left, bottom, right)，即 (north, west, south, east)。
    // drPath 点一并纳入（评审 minor 修正）：0093 尾段纯递推分离可达 26m 级，不纳入则紫线被初始视野裁剪
    let north = -Infinity
    let south = Infinity
    let west = Infinity
    let east = -Infinity
    for (const p of [
      ...trace.map((t) => [t.lat, t.lng] as [number, number]),
      ...derived.map((d) => [d.matchedLatLng[0], d.matchedLatLng[1]] as [number, number]),
      ...(drPath ?? []),
    ]) {
      if (p[0] > north) north = p[0]
      if (p[0] < south) south = p[0]
      if (p[1] < west) west = p[1]
      if (p[1] > east) east = p[1]
    }
    if (Number.isFinite(north))
      map.getViewModel().setLookAtData({ bounds: new here.geo.Rect(north, west, south, east) })

    return () => {
      behavior.dispose()
      map.dispose() // HERE 3.1 的正确清理入口（连同引擎资源一并释放）
      mapRef.current = null
      sprayedRef.current = []
      objRef.current = []
      sprayedMapRef.current = null
      carRef.current = null
      endMarkerRef.current = null
      triangleIconCacheRef.current = new Map()
    }
  }, [here, apikey, trace, derived, drPath, showMm])

  // GNSS 喷洒：sprayPlan 纯函数算增量（前进补洒/回退回收），本 effect 只做对象映射。
  // ⚠ 无 cleanup（评审 blocker 修正）：React 在每次依赖变化时都先跑上一轮 cleanup，
  // 回滚式 cleanup 会让每步 upTo 变化退化为「全删全重洒」（O(n²)，5x 尾段 ~8 万次引擎操作/秒必卡）。
  // 安全性：卸载/换图由建图 effect 的 dispose+账本重置兜底（声明序先行）；
  // stale-map 守卫自愈「地图重建而本 effect 未重跑」的理论窗口（App 数据流必经卸载，纯防御）。
  useEffect(() => {
    const map = mapRef.current
    if (!here || !map) return
    if (sprayedMapRef.current !== map) {
      sprayedMapRef.current = map
      sprayedRef.current = [] // 旧图对象已随 dispose 死亡，账本清零全量重洒
      objRef.current = []
      dotsRef.current = dots
    }
    // 散点源换人（隧道开关 → noFix 掩码变）：账本整体失效，清空重洒。
    // 不做这步会出现「该消失的点不消失、该回来的点不回来」——sprayPlan 只认下标增减，看不见掩码变化。
    if (dotsRef.current !== dots) {
      for (const o of objRef.current) if (o) map.removeObject(o)
      dotsRef.current = dots
      sprayedRef.current = []
      objRef.current = []
    }
    const upToClamped = Math.min(upTo, trace.length - 1)
    const kept = new Set(sprayedRef.current.filter((i) => i <= upToClamped))
    const removeIdx = sprayedRef.current.filter((i) => i > upToClamped)
    const addIdx = gnssSampleIdx.filter((i) => i <= upToClamped && !kept.has(i))
    for (const i of removeIdx) {
      const k = sprayedRef.current.indexOf(i)
      const obj = objRef.current.splice(k, 1)[0]
      if (obj) map.removeObject(obj)
      sprayedRef.current.splice(k, 1)
    }
    for (const i of addIdx) {
      // noFix 帧记账不画（占位 null 保持与 sprayedRef 平行，撤销时靠上面的 null 守卫跳过）
      const obj = dots[i]?.noFix
        ? null
        : (() => {
            const m = new here.map.Marker(
              { lat: dots[i].lat, lng: dots[i].lng },
              { icon: markerIcon(here, triangleIconCacheRef.current, 'gnss', yawToCompassDeg(dots[i].headingDeg)) },
            )
            m.addEventListener('tap', () => {
              if (interactiveRef.current) setSelected({ type: 'gnss', index: i })
            })
            return m
          })()
      if (obj) map.addObject(obj)
      sprayedRef.current.push(i)
      objRef.current.push(obj)
    }

    // 终点标记（红点，回放至末帧出现、回拖消失）。归喷洒 effect 而非建图 effect：
    // 建图 effect 依赖 trace/derived（回放进度不在依赖里），挂那里终点只会「建图时定终身」不随回放增删。
    const finished = trace.length > 0 && upToClamped >= trace.length - 1
    if (finished && !endMarkerRef.current) {
      endMarkerRef.current = new here.map.Marker(
        { lat: trace[trace.length - 1].lat, lng: trace[trace.length - 1].lng },
        { icon: new here.map.Icon(
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="#dc2626" stroke="#fff" stroke-width="2"/></svg>',
          { anchor: { x: 10, y: 10 } },
        ) },
      )
      map.addObject(endMarkerRef.current)
    } else if (!finished && endMarkerRef.current) {
      map.removeObject(endMarkerRef.current)
      endMarkerRef.current = null
    }
  }, [here, upTo, trace, dots, gnssSampleIdx])

  // 车标：位置沿匹配路径垂足，航向烘焙进分桶图标。
  // volatility: true（评审 major 修正）：HERE 3.1 非易失对象的 setGeometry 走引擎 100ms debounce
  // 路径，50 次/秒更新会步进/冻结；易失对象即时 flush（官方 draggable-marker 示例同款配置）。
  useEffect(() => {
    const map = mapRef.current
    if (!here || !map) return
    if (!carState) {
      if (carRef.current) {
        map.removeObject(carRef.current)
        carRef.current = null
      }
      return
    }
    if (iconCacheRef.current.size === 0) {
      // 预热全部 72 个航向桶（评审 minor 采纳）：data-URI SVG icon 异步 LOADING，
      // 惰性创建会在弯道换桶瞬间闪空 1–2 帧；预热后 setIcon 恒命中 READY 态
      for (let h = 0; h < 360; h += 5) carIcon(here, iconCacheRef.current, h)
    }
    const coord = { lat: carState.lat, lng: carState.lng }
    try {
      map.setCenter(coord)
      map.setZoom(headingUp ? 16 : 17)
    } catch {
      // 静默
    }
    const icon = carIcon(here, iconCacheRef.current, carState.compassDeg, 56)
    if (!carRef.current) {
      carRef.current = new here.map.Marker(coord, { icon, volatility: true })
      map.addObject(carRef.current)
    } else {
      carRef.current.setGeometry(coord)
      carRef.current.setIcon(icon)
    }
  }, [here, carState, headingUp])

  if (!here) {
    const car = carState
    return (
      <div style={{ position: 'relative', width: '100%', height: '100%' }}>
        <SvgFallback
          trace={trace}
          derived={derived}
          width={960}
          height={540}
          upToIndex={upTo}
          car={car}
          drPath={drPath}
          gnssPath={gnssPath}
          showMm={showMm}
          interactive={interactive}
        />
      </div>
    )
  }
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div
        ref={hostRef}
        style={{
          position: 'absolute',
          width: '100%',
          height: '134%',
          top: 0,
          left: 0,
          transform: headingUp
            ? `rotate(${(360 - compassDeg) % 360}deg) scale(2.3)`
            : 'none',
          transformOrigin: 'center center',
        }}
      />
      {carPos !== undefined && (
        <button
          type="button"
          onClick={() => setHeadingUp((v) => !v)}
          style={{
            position: 'absolute', top: 12, left: 12, zIndex: 10,
            padding: '0.35rem 0.8rem', fontSize: 13, cursor: 'pointer',
            borderRadius: 6, border: '1px solid #d1d5db', background: 'rgba(255,255,255,0.95)',
          }}
        >
          {headingUp ? 'North Up' : 'Heading Up'}
        </button>
      )}
      <div
        data-testid="map-legend"
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          background: 'rgba(255,255,255,0.9)',
          padding: '10px 14px',
          borderRadius: 4,
          border: '1px solid #d1d5db',
          fontSize: 13,
          pointerEvents: 'none',
          lineHeight: '24px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <svg width="20" height="20" viewBox="0 0 20 20" style={{ marginRight: 8 }}>
            <circle cx="10" cy="10" r="6" fill="none" stroke="#9ca3af" strokeWidth="2" />
            <line x1="10" y1="10" x2="10" y2="3" stroke="#9ca3af" strokeWidth="1.5" />
          </svg>
          GNSS
        </div>
        {drPath && drPath.length > 0 ? (
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <svg width="20" height="20" viewBox="0 0 20 20" style={{ marginRight: 8 }}>
              <polygon points="10,2 17,16 10,12 3,16" fill="#eab308" stroke="#a16207" strokeWidth="1" />
            </svg>
            DR
          </div>
        ) : null}
        {showMm ? (
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <svg width="20" height="20" viewBox="0 0 20 20" style={{ marginRight: 8 }}>
              <polygon points="10,2 17,16 10,12 3,16" fill="#2563eb" stroke="#1e40af" strokeWidth="1" />
            </svg>
            MM
          </div>
        ) : null}
      </div>

      {interactive && selected && (() => {
        const popup = getMarkerPopup(selected.type, selected.index, trace, dots, drPath, derived)
        if (!popup) return null
        return (
          <div
            data-testid="marker-popup"
            style={{
              position: 'absolute',
              top: 12,
              left: 12,
              background: 'rgba(255,255,255,0.94)',
              border: '1px solid #d1d5db',
              borderRadius: 4,
              padding: '10px 14px',
              fontSize: 13,
              pointerEvents: 'auto',
              zIndex: 10,
              minWidth: 220,
            }}
          >
            <div style={{ fontWeight: 'bold', marginBottom: 4 }}>{popup.title}</div>
            <div style={{ borderTop: '1px solid #e5e7eb', marginBottom: 6 }} />
            {popup.lines.map(([label, value], j) => (
              <div key={j} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, lineHeight: '20px' }}>
                <span style={{ color: '#6b7280' }}>{label}</span>
                <span>{value}</span>
              </div>
            ))}
            <button
              onClick={() => setSelected(null)}
              style={{ position: 'absolute', top: 4, right: 8, border: 'none', background: 'none', cursor: 'pointer', fontSize: 16, lineHeight: 1, color: '#9ca3af' }}
            >
              ×
            </button>
          </div>
        )
      })()}
    </div>
  )
}
