import { useEffect, useRef } from 'react'
import SvgFallback from './SvgFallback'
import { yawToCompassDeg } from '../lib/geo'
import { sprayPlan } from '../lib/playback'
import type { DerivedPoint, TrajPoint } from '../types'

export interface MapViewProps {
  trace: TrajPoint[]
  derived: DerivedPoint[]
  mapStatus: 'ok' | 'fallback'
  apikey: string
  /** 回放：GNSS 散点洒到该下标（含）。缺省 = 全量（静态模式） */
  upToIndex?: number
  /** 回放：车标下标——位置取 derived[carIndex].matchedLatLng，航向取 trace[carIndex].headingDeg（IMU yaw）。缺省 = 无车标 */
  carIndex?: number
  /** DR 航位推算轨迹（缺省不渲染）。紫折线：匹配路线（蓝）之下；并计入 setLookAtData bounds 防初始视野裁剪 */
  drPath?: Array<[number, number]>
}

/** HERE Maps JS API 3.1 命名空间的最小结构声明——script 标签加载、无官方 npm 类型。
 *  'ok' 路径仅在真实浏览器执行（手动验收覆盖），jsdom 测试只覆盖 fallback 路径。 */
interface HereDefaultLayers {
  vector: { normal: { map: unknown } }
}

interface HereMarker {
  setGeometry(coord: { lat: number; lng: number }): void
  setIcon(icon: unknown): void
}

interface HereMap {
  addObject(obj: unknown): void
  removeObject(obj: unknown): void
  /** 3.1 视野适配入口（Step1 运行时源码核实：无 setViewBounds，经 ViewModel.setLookAtData({bounds})） */
  getViewModel(): { setLookAtData(data: { bounds?: unknown; zoom?: number; tilt?: number; heading?: number }): void }
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
    LineString: new () => { pushLatLngAlt: (lat: number, lng: number, alt?: number) => void }
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
function carIcon(here: HereNS, cache: Map<number, unknown>, compassDeg: number): unknown {
  const bucket = ((Math.round(compassDeg / 5) * 5) % 360 + 360) % 360
  let icon = cache.get(bucket)
  if (!icon) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">` +
      `<polygon points="14,4 8,24 14,19 20,24" fill="#1d4ed8" stroke="#ffffff" stroke-width="1.5" ` +
      `transform="rotate(${bucket} 14 14)"/></svg>`
    icon = new here.map.Icon(svg, { anchor: { x: 14, y: 14 } })
    cache.set(bucket, icon)
  }
  return icon
}

/** 地图视图：mapStatus='ok' 初始化 HERE 地图（App 层保证此时 window.H 已就绪）；否则渲染无底图 SVG 兜底。
 *  Step2：upToIndex 归一为 upTo（缺省全量）→ HERE 散点走增量喷洒 effect；carIndex 驱动车标。 */
export default function MapView({ trace, derived, mapStatus, apikey, upToIndex, carIndex, drPath }: MapViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const here = mapStatus === 'ok' ? getHere() : null // 'ok' 但 H 缺席时兜底走 SVG，防白屏
  const upTo = upToIndex ?? trace.length - 1

  // HERE 路径回放状态（随组件卸载/建图重建重置；App 换轨迹时先 setData(null) 卸载本组件）
  const mapRef = useRef<HereMap | null>(null)
  const sprayedRef = useRef<number[]>([]) // 已洒下标（升序）
  const objRef = useRef<unknown[]>([]) // 与 sprayedRef 平行的 Circle 对象
  const sprayedMapRef = useRef<HereMap | null>(null) // 账本所属地图实例（stale-map 守卫）
  const carRef = useRef<HereMarker | null>(null)
  const iconCacheRef = useRef(new Map<number, unknown>())

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
    carRef.current = null

    // DR 航位推算折线（紫）——先于匹配路径 addObject → 渲染于蓝线之下（HERE 对象按添加序叠放）。
    // 3.1 Polyline style 无 dash 选项，纯色实线（与 SVG 兜地的虚线观感有别，可接受）
    if (drPath && drPath.length > 1) {
      const ls = new here.geo.LineString()
      for (const p of drPath) ls.pushLatLngAlt(p[0], p[1])
      map.addObject(
        new here.map.Polyline(ls, { style: { strokeColor: '#7c3aed', lineWidth: 2 } }),
      )
    }

    // 匹配路径（蓝）——回放下仍全量显示：路网先知，车在路上走
    if (derived.length > 1) {
      const ls = new here.geo.LineString()
      for (const d of derived) ls.pushLatLngAlt(d.matchedLatLng[0], d.matchedLatLng[1])
      map.addObject(
        new here.map.Polyline(ls, { style: { strokeColor: '#2563eb', lineWidth: 3 } }),
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
    }
  }, [here, apikey, trace, derived, drPath])

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
    }
    const { removeIdx, addIdx } = sprayPlan(sprayedRef.current, Math.min(upTo, trace.length - 1), 2)
    for (const i of removeIdx) {
      const k = sprayedRef.current.indexOf(i)
      map.removeObject(objRef.current.splice(k, 1)[0])
      sprayedRef.current.splice(k, 1)
    }
    for (const i of addIdx) {
      const obj = new here.map.Circle({ lat: trace[i].lat, lng: trace[i].lng }, 3, {
        style: { fillColor: 'rgba(245, 158, 11, 0.9)', strokeColor: '#f59e0b', lineWidth: 1 },
      })
      map.addObject(obj)
      sprayedRef.current.push(i)
      objRef.current.push(obj)
    }
  }, [here, upTo, trace])

  // 车标：位置沿匹配路径垂足，航向烘焙进分桶图标。
  // volatility: true（评审 major 修正）：HERE 3.1 非易失对象的 setGeometry 走引擎 100ms debounce
  // 路径，50 次/秒更新会步进/冻结；易失对象即时 flush（官方 draggable-marker 示例同款配置）。
  useEffect(() => {
    const map = mapRef.current
    if (!here || !map) return
    if (carIndex === undefined || !trace[carIndex]) {
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
    const d = derived[carIndex]
    const coord = d
      ? { lat: d.matchedLatLng[0], lng: d.matchedLatLng[1] }
      : { lat: trace[carIndex].lat, lng: trace[carIndex].lng }
    const icon = carIcon(here, iconCacheRef.current, yawToCompassDeg(trace[carIndex].headingDeg))
    if (!carRef.current) {
      carRef.current = new here.map.Marker(coord, { icon, volatility: true })
      map.addObject(carRef.current)
    } else {
      carRef.current.setGeometry(coord)
      carRef.current.setIcon(icon)
    }
  }, [here, carIndex, trace, derived])

  if (!here) {
    const car =
      carIndex !== undefined && trace[carIndex]
        ? {
            lat: derived[carIndex]?.matchedLatLng[0] ?? trace[carIndex].lat,
            lng: derived[carIndex]?.matchedLatLng[1] ?? trace[carIndex].lng,
            compassDeg: yawToCompassDeg(trace[carIndex].headingDeg), // yaw→罗盘，两渲染路径共用此归一点
          }
        : undefined
    return (
      <div style={{ width: '100%', height: '100%' }}>
        <SvgFallback
          trace={trace}
          derived={derived}
          width={960}
          height={540}
          upToIndex={upTo}
          car={car}
          drPath={drPath}
        />
      </div>
    )
  }
  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
}
