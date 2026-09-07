import { useEffect, useRef } from 'react'
import SvgFallback from './SvgFallback'
import type { DerivedPoint, TrajPoint } from '../types'

export interface MapViewProps {
  trace: TrajPoint[]
  derived: DerivedPoint[]
  mapStatus: 'ok' | 'fallback'
  apikey: string
}

/** HERE Maps JS API 3.1 命名空间的最小结构声明——script 标签加载、无官方 npm 类型。
 *  'ok' 路径仅在真实浏览器执行（T8 Step 5 手动验收覆盖），jsdom 测试只覆盖 fallback 路径。 */
interface HereDefaultLayers {
  vector: { normal: { map: unknown } }
}

interface HereMap {
  addObject(obj: unknown): void
  setViewBounds(rect: unknown): void
  dispose(): void
}

interface HereNS {
  service: {
    Platform: new (opts: { apikey: string }) => { createDefaultLayers: () => HereDefaultLayers }
  }
  map: {
    Map: new (
      el: HTMLElement,
      layer: unknown,
      opts?: { zoom?: number; center?: { lat: number; lng: number } },
    ) => HereMap
    Polyline: new (
      lineString: unknown,
      opts?: { style?: { strokeColor?: string; lineWidth?: number } },
    ) => unknown
    Circle: new (
      center: { lat: number; lng: number },
      radiusM: number,
      opts?: { style?: { fillColor?: string; strokeColor?: string; lineWidth?: number } },
    ) => unknown
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

/** 地图视图：mapStatus='ok' 初始化 HERE 地图（App 层保证此时 window.H 已就绪）；否则渲染无底图 SVG 兜底。 */
export default function MapView({ trace, derived, mapStatus, apikey }: MapViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const here = mapStatus === 'ok' ? getHere() : null // 'ok' 但 H 缺席时兜底走 SVG，防白屏

  useEffect(() => {
    if (!here || !hostRef.current) return
    const platform = new here.service.Platform({ apikey })
    const layers = platform.createDefaultLayers()
    const map = new here.map.Map(hostRef.current, layers.vector.normal.map, {
      zoom: 14,
      center: { lat: trace[0]?.lat ?? 49.01, lng: trace[0]?.lng ?? 8.44 },
    })
    // 拖拽/滚轮缩放交互（navigator 缩放）
    const behavior = new here.mapevents.Behavior(new here.mapevents.MapEvents(map))

    // 匹配路径（蓝）
    if (derived.length > 1) {
      const ls = new here.geo.LineString()
      for (const d of derived) ls.pushLatLngAlt(d.matchedLatLng[0], d.matchedLatLng[1])
      map.addObject(
        new here.map.Polyline(ls, { style: { strokeColor: '#2563eb', lineWidth: 3 } }),
      )
    }

    // GNSS 散点（橙，每 2 点抽稀）
    for (let i = 0; i < trace.length; i += 2) {
      map.addObject(
        new here.map.Circle({ lat: trace[i].lat, lng: trace[i].lng }, 3, {
          style: { fillColor: 'rgba(245, 158, 11, 0.9)', strokeColor: '#f59e0b', lineWidth: 1 },
        }),
      )
    }

    // 视野适配：H.geo.Rect 构造参数顺序 = (top, left, bottom, right)，即 (north, west, south, east)
    let north = -Infinity
    let south = Infinity
    let west = Infinity
    let east = -Infinity
    for (const p of [
      ...trace.map((t) => [t.lat, t.lng] as [number, number]),
      ...derived.map((d) => [d.matchedLatLng[0], d.matchedLatLng[1]] as [number, number]),
    ]) {
      if (p[0] > north) north = p[0]
      if (p[0] < south) south = p[0]
      if (p[1] < west) west = p[1]
      if (p[1] > east) east = p[1]
    }
    if (Number.isFinite(north)) map.setViewBounds(new here.geo.Rect(north, west, south, east))

    return () => {
      behavior.dispose()
      map.dispose() // HERE 3.1 的正确清理入口（连同引擎资源一并释放）
    }
  }, [here, apikey, trace, derived])

  if (!here) {
    return (
      <div style={{ width: '100%', height: '100%' }}>
        <SvgFallback trace={trace} derived={derived} width={960} height={540} />
      </div>
    )
  }
  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
}
