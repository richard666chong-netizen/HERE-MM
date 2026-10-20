import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import MapView from '../components/MapView'
import { derive } from '../lib/derive'
import { toLocalM, type LatLng } from '../lib/geo'
import type { DerivedPoint, ImportResponse, TrajPoint } from '../types'

// 测试代码豁免静态 import public/（src 运行时路径禁止，见 Global Constraints）
import f0093 from '../../public/fixtures/2011_09_26_drive_0093.json'

// mapStatus='ok' 路径不在本层测：HERE SDK 需真实浏览器环境（jsdom 不加载外部脚本），
// 由 T8 Step 5 真实 key 手动验收覆盖（计划 Task 7 Step 1 注明）。

function tp(lat: number, lng: number, headingDeg = 0, timestamp = 0): TrajPoint {
  return { lat, lng, timestamp, timestampUtc: '2026-09-07T00:00:00Z', headingDeg, speedMps: 0, numsats: 6 }
}

function dp(i: number, lat: number, lng: number): DerivedPoint {
  return { i, matchedLatLng: [lat, lng], deviationM: 0, headingDeg: 0, speedMps: 0, linkId: `s${i}` }
}

describe('MapView fallback（SvgFallback）路径', () => {
  it("mapStatus='fallback'：svg 存在、matched-path 非空、gnss-dot=2（1Hz 抽稀）、endpoint-marker=2", () => {
    const trace = [tp(49.0, 8.4, 0, 0), tp(49.01, 8.405, 0, 0.1), tp(49.02, 8.41, 0, 0.2)]
    const derived = [dp(0, 49.0, 8.4), dp(1, 49.01, 8.405), dp(2, 49.02, 8.41)]
    const { container } = render(<MapView trace={trace} derived={derived} mapStatus="fallback" apikey="" />)

    expect(container.querySelector('svg')).toBeTruthy()

    const path = container.querySelector('[data-testid="matched-path"]')
    expect(path).toBeTruthy()
    expect(path?.children.length).toBeGreaterThan(0) // 非空

    expect(container.querySelectorAll('[data-testid="gnss-dot"]').length).toBe(2) // 1Hz 抽稀：下标 0、2
    expect(container.querySelectorAll('[data-testid="endpoint-marker"]').length).toBe(2)
  })

  it('viewBox 宽高比符合等距圆柱投影（x 乘 cos(midLat)），±5%', () => {
    // 已知 bbox 的 2 点 trace：Δlat = 0.1、Δlng = 0.01、midLat = 49.05°
    const trace = [tp(49.0, 8.4, 0, 0), tp(49.1, 8.41, 0, 0.1)]
    const { container } = render(<MapView trace={trace} derived={[]} mapStatus="fallback" apikey="" />)

    const viewBox = container.querySelector('svg')?.getAttribute('viewBox')
    expect(viewBox).toBeTruthy()
    const parts = (viewBox as string).trim().split(/\s+/).map(Number)
    const w = parts[2]
    const h = parts[3]

    const midLatRad = ((49.0 + 49.1) / 2) * (Math.PI / 180)
    const expected = (0.01 * Math.cos(midLatRad)) / 0.1
    expect(w / h).toBeGreaterThan(expected * 0.95)
    expect(w / h).toBeLessThan(expected * 1.05)
  })
})

describe('MapView replay（SvgFallback 路径）', () => {
  const trace = [tp(49.0, 8.4, 0, 0), tp(49.01, 8.405, 90, 0.1), tp(49.02, 8.41, 180, 0.2)]
  // derived 与 trace 坐标故意错开（评审修正，防假绿）：车标取 trace（传感器路径，carTrace 缺省回退），
  // 不取 matchedLatLng——测试数据重合时两种实现都过，错开后可判别
  const derived = [dp(0, 49.001, 8.401), dp(1, 49.015, 8.406), dp(2, 49.019, 8.409)]

  it('upToIndex limits spray to 1 dot + start marker only; car marker present as HTML overlay', () => {
    const { container } = render(
      <MapView trace={trace} derived={derived} mapStatus="fallback" apikey="" upToIndex={1} carPos={1} />,
    )
    expect(container.querySelectorAll('[data-testid="gnss-dot"]').length).toBe(1) // 1Hz 抽稀：下标 0
    expect(container.querySelectorAll('[data-testid="endpoint-marker"]').length).toBe(1) // 仅起点，终点未到
    const car = container.querySelector('[data-testid="car-marker"]')
    expect(car).toBeTruthy()
    // 车标为 HTML 叠层（固定在容器中心），不随 SVG viewBox 缩放
    expect(car!.tagName).toBe('DIV')
    const carCircle = container.querySelector('[data-testid="car-position-circle"]')
    expect(carCircle).toBeTruthy()
  })

  it('upToIndex = last restores full static render; no car marker without carPos', () => {
    const { container } = render(
      <MapView trace={trace} derived={derived} mapStatus="fallback" apikey="" upToIndex={2} />,
    )
    expect(container.querySelectorAll('[data-testid="gnss-dot"]').length).toBe(2) // 1Hz 抽稀：下标 0、2
    expect(container.querySelectorAll('[data-testid="endpoint-marker"]').length).toBe(2) // 终点出现
    expect(container.querySelector('[data-testid="car-marker"]')).toBeNull()
  })
})

// Step4 任务3：DR 图层。drPath 缺省 = 不渲染（既有轨迹零改动）；存在 = 紫虚线渲染于
// 匹配路线（蓝）之下、GNSS 散点之上，且画幅（viewBox / HERE bounds）纳入 DR 点防裁剪。
describe('MapView DR 图层（SvgFallback 路径）', () => {
  const trace3 = [tp(49.0, 8.4, 0, 0), tp(49.01, 8.405, 0, 0.1), tp(49.02, 8.41, 0, 0.2)]
  const derived3 = [dp(0, 49.0, 8.4), dp(1, 49.01, 8.405), dp(2, 49.02, 8.41)]
  const drPath: Array<[number, number]> = [
    [49.0, 8.4],
    [49.01, 8.405],
    [49.02, 8.41],
  ]

  it('drPath 存在：dr-path 折线非空、紫虚线样式、z 序 = 散点之上/匹配路线之下；缺省 → null', () => {
    const { container } = render(
      <MapView trace={trace3} derived={derived3} mapStatus="fallback" apikey="" drPath={drPath} />,
    )
    const dr = container.querySelector('[data-testid="dr-path"]')
    expect(dr).toBeTruthy()
    expect(dr?.children.length).toBeGreaterThan(0) // 非空
    expect(dr?.querySelector('polygon')?.getAttribute('fill')).toBe('#eab308') // 黄色箭头
    // z 序 = 文档序（后者盖上者）：首散点 < dr-path < matched-path
    const idx = (sel: string) =>
      Array.from(container.querySelector('svg')!.children).indexOf(container.querySelector(sel)!)
    expect(idx('[data-testid="dr-path"]')).toBeGreaterThan(idx('[data-testid="gnss-dot"]'))
    expect(idx('[data-testid="dr-path"]')).toBeLessThan(idx('[data-testid="matched-path"]'))

    // 不传 drPath → 无 DR 层
    const { container: c2 } = render(
      <MapView trace={trace3} derived={derived3} mapStatus="fallback" apikey="" />,
    )
    expect(c2.querySelector('[data-testid="dr-path"]')).toBeNull()
  })

  it('多 section 拼接烟囱：0093 两段不相邻 polyline → derive 不抛错、matched-path 非空、gnss-dot 在场', () => {
    // 0093 是 importSplitRoute 拆分路由（4 段），取空间不相邻的段 0 与段 2 合成 response
    const secs = (f0093 as unknown as { response: { routes: { sections: { id: string; polyline: string; summary: { duration: number; length: number } }[] }[] } }).response.routes[0].sections
    const response: ImportResponse = {
      routes: [{ id: 'synthetic-2sec', sections: [{ id: secs[0].id, type: 'vehicle', polyline: secs[0].polyline, summary: secs[0].summary }, { id: secs[2].id, type: 'vehicle', polyline: secs[2].polyline, summary: secs[2].summary }] }],
    }
    const trace = [tp(48.99779, 8.46905, 0, 0), tp(48.99807, 8.4701, 0, 0.1), tp(48.99837, 8.47056, 0, 0.2)]
    let derived: DerivedPoint[] = []
    expect(() => {
      derived = derive(trace, response)
    }).not.toThrow()
    expect(derived.length).toBe(3)
    const { container } = render(
      <MapView trace={trace} derived={derived} mapStatus="fallback" apikey="" />,
    )
    const path = container.querySelector('[data-testid="matched-path"]')
    expect(path?.children.length).toBeGreaterThan(0)
    expect(container.querySelectorAll('[data-testid="gnss-dot"]').length).toBe(2) // 1Hz 抽稀
  })

  it('画幅纳入 drPath：DR 点北向 +0.01° 出 trace bbox → viewBox 高度按投影量增长（±10%）', () => {
    // 宽度主导归一化（东西 0.025°≈1.8km > 增长后 vbH≈1.48km），两次渲染 unitsPerMeter 恒定，
    // 高度增量可换算回米；trace 南北仅 0.001°≈111m，+0.01°≈1113m 的 DR 位移远超 5% 边距效应
    const trace = [tp(49.0, 8.4, 0, 0), tp(49.001, 8.425, 0, 0.1)]
    const vb = (path?: Array<[number, number]>) => {
      const { container } = render(
        <MapView trace={trace} derived={[]} mapStatus="fallback" apikey="" drPath={path} />,
      )
      const parts = (container.querySelector('svg')!.getAttribute('viewBox') as string)
        .trim()
        .split(/\s+/)
        .map(Number)
      return { h: parts[3] }
    }
    const h0 = vb().h
    const h1 = vb([[49.011, 8.41]]).h // trace bbox 北缘 +0.01°；lng 在 bbox 内 → 宽度不变
    // 期望增量 = 0.01° 纬向米量（复用组件同款投影 toLocalM）×1.1（5% 边距随新跨度进入）
    const mid: LatLng = [49.0005, 8.4125]
    const dyM = toLocalM([49.011, mid[1]], mid)[1] - toLocalM([49.001, mid[1]], mid)[1]
    const spanXM = toLocalM([mid[0], 8.425], mid)[0] - toLocalM([mid[0], 8.4], mid)[0] // 东西全跨度（米）
    const growthM = ((h1 - h0) * (spanXM * 1.1)) / 1000 // 单位→米：vbW=1.1·spanX 映射 1000 单位
    const expectM = dyM * 1.1
    expect(growthM).toBeGreaterThan(expectM * 0.9)
    expect(growthM).toBeLessThan(expectM * 1.1)
  })
})

// Step6：散点口径从「原始 OXTS」改为「接收机实际报的 GNSS」——失锁帧不画点，
// 隧道/城市峡谷/树荫时期的退化才看得见（此前散点画真值，退化被抹平）。
describe('MapView 散点口径（gnssPath）', () => {
  const trace = [tp(49.0, 8.4, 0, 0), tp(49.01, 8.405, 0, 0.1), tp(49.02, 8.41, 0, 0.2)]
  const derived = [dp(0, 49.0, 8.4), dp(1, 49.01, 8.405), dp(2, 49.02, 8.41)]

  it('gnssPath 中 noFix 帧不产出 gnss-dot，其余图层不受影响', () => {
    const gnssPath = trace.map((p, i) => (i === 1 ? { ...p, noFix: true } : p))
    const { container } = render(
      <MapView trace={trace} derived={derived} mapStatus="fallback" apikey="" gnssPath={gnssPath} />,
    )
    expect(container.querySelectorAll('[data-testid="gnss-dot"]').length).toBe(2) // 帧 1 消失
    expect(container.querySelector('[data-testid="matched-path"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="endpoint-marker"]').length).toBe(2) // 起终点走真值
  })

  it('gnssPath 一并入画幅：只存在于 gnssPath 的远点也会被 viewBox 覆盖（防裁剪）', () => {
    // 归一化把最长边钉在 1000 单位，故画幅"变高"表现为宽高比变小（宽不变、高变长）
    const aspect = (gnssPath?: TrajPoint[]) => {
      const { container } = render(
        <MapView trace={trace} derived={[]} mapStatus="fallback" apikey="" gnssPath={gnssPath} />,
      )
      const parts = (container.querySelector('svg')!.getAttribute('viewBox') as string)
        .trim()
        .split(/\s+/)
        .map(Number)
      return parts[2] / parts[3]
    }
    expect(aspect([...trace, tp(49.06, 8.4)])).toBeLessThan(aspect())
  })
})

// 2026-09-16 heading-up 抖动修复：旋转从「外层 CSS rotate(scale) 宿主 div」改为「引擎原生相机航向」。
// 只测接线（对引擎的调用序列），不测 HERE 渲染——渲染仍归真实浏览器手动验收（文件头既有约定）。
describe('MapView heading-up：引擎原生相机航向（mapStatus=ok，假 H）', () => {
  interface LookAtCall {
    heading?: number
    /** HERE 3.1 真实契约：lookAtData 的坐标字段是 position（H.geo.Point），不是 setCenter 风格的 center */
    position?: { lat: number; lng: number }
    bounds?: unknown
    zoom?: number
  }
  interface BehaviorOp {
    op: 'disable' | 'enable'
    flag: number
  }
  interface ZoomCall {
    z: number
    animate: boolean | undefined
  }
  function installFakeH(): { lookAt: LookAtCall[]; behaviorOps: BehaviorOp[]; zoomCalls: ZoomCall[] } {
    const lookAt: LookAtCall[] = []
    const behaviorOps: BehaviorOp[] = []
    const zoomCalls: ZoomCall[] = []
    let zoom = 17
    class FakeMap {
      addObject(): void {}
      removeObject(): void {}
      setCenter(): void {}
      setZoom(z: number, animate?: boolean): void {
        zoomCalls.push({ z, animate })
        zoom = z
      }
      getZoom(): number {
        return zoom
      }
      getViewModel(): { setLookAtData(data: LookAtCall): void } {
        return { setLookAtData: (d: LookAtCall) => lookAt.push(d) }
      }
      getViewPort(): { resize(): void } {
        return { resize(): void {} }
      }
      dispose(): void {}
    }
    ;(window as unknown as { H: unknown }).H = {
      service: { Platform: class { createDefaultLayers() { return { vector: { normal: { map: {} } } } } } },
      Map: FakeMap,
      mapevents: {
        MapEvents: class {},
        // 假 Behavior：静态 WHEELZOOM 为假值 4，测试只断言 disable/enable 收到的 flag === 此值
        Behavior: class {
          static WHEELZOOM = 4
          dispose(): void {}
          disable(flag: number): void { behaviorOps.push({ op: 'disable', flag }) }
          enable(flag: number): void { behaviorOps.push({ op: 'enable', flag }) }
        },
      },
      map: {
        Polyline: class {},
        Marker: class { setGeometry(): void {} setIcon(): void {} addEventListener(): void {} },
        Icon: class {},
      },
      geo: {
        LineString: class { pushPoint(): void {} pushLatLngAlt(): void {} },
        Rect: class {},
        Point: class {
          lat: number
          lng: number
          constructor(lat: number, lng: number) {
            this.lat = lat
            this.lng = lng
          }
        },
      },
    }
    return { lookAt, behaviorOps, zoomCalls }
  }
  afterEach(() => {
    delete (window as unknown as { H?: unknown }).H
  })

  it('建图期视野适配即带 heading=180：analysis 模式无相机跟随，地图须为真北向上（引擎定律 R=180−h，h=0 渲染南向上）', () => {
    const { lookAt } = installFakeH()
    const trace = [tp(49.0, 8.4, 0, 0), tp(49.0, 8.401, 0, 0.1)]
    const derived = [dp(0, 49.0, 8.4), dp(1, 49.001, 8.4015)]
    render(
      <MapView trace={trace} derived={derived} mapStatus="ok" apikey="k" carTrace={trace} />,
    )
    // 无 carPos → 相机跟随 effect 不跑，唯一 setLookAtData = 建图期 bounds 调用
    const boundsCall = lookAt.find((c) => c.bounds !== undefined)
    expect(boundsCall).toBeTruthy()
    expect(boundsCall!.heading).toBe(180)
  })

  it('Heading Up：setLookAtData 收到 heading=(compass+180)%360 且宿主无 CSS transform；切回北向上 heading=180（引擎定律 R=180−h）', () => {
    const { lookAt } = installFakeH()
    // yaw=180 → compass=270（yawToCompassDeg=(90−yaw)%360）：判别性取值——错误实现发 270、
    // 正确应为 90；yaw=90（compass=0）是退化值（(360−0)%360=0），无法区分两种实现（假绿教训）
    const trace = [tp(49.0, 8.4, 180, 0), tp(49.0, 8.401, 180, 0.1), tp(49.0, 8.402, 180, 0.2)]
    const derived = [dp(0, 49.0, 8.4), dp(1, 49.001, 8.4015), dp(2, 49.002, 8.402)]
    const { container } = render(
      <MapView trace={trace} derived={derived} mapStatus="ok" apikey="k" carPos={1} carTrace={trace} />,
    )
    const host = container.querySelector('[data-testid="map-host"]') as HTMLElement | null
    expect(host).toBeTruthy()

    // 切到车头向上：heading = (compass+180)%360。实测引擎语义（2026-09-16 用户判别终验）：
    // 传 h → 内容旋转 R=180°−h（h 方位朝屏幕下方）——与文档「相机朝向」不符，经验常数。
    // 本测试无 carTrack → compass 走位移方位回退（frame0→2 向东=90）→ heading=270。
    // yaw=180（IMU→270）被无视 = 航向源已换绑路/位移。
    fireEvent.click(screen.getByRole('button', { name: 'Heading Up' }))
    const headingCalls = lookAt.filter((c) => typeof c.heading === 'number')
    expect(headingCalls.length).toBeGreaterThan(0)
    const last = headingCalls[headingCalls.length - 1]
    expect(last.heading).toBeCloseTo(270, 1)
    // 平移字段必须是 position（v3.1 契约）：车标在 carPos=1 → interp frac=0 → trace[1] 坐标。
    // 首版误用 setCenter 风格 center，引擎静默忽略 → 相机不平移 → 车标原地转圈（2026-09-16 实测回归）
    // playing 缺省=undefined（暂停态）：单步 setLookAtData position=车标坐标（无 screenToGeo 偏移）
    const firstCarCall = headingCalls.find((c) => c.position !== undefined)
    expect(firstCarCall).toBeTruthy()
    expect(firstCarCall!.position).toMatchObject({ lat: trace[1].lat, lng: trace[1].lng })
    expect(host!.style.transform).toBe('')

    // 切回北向上：航向 = 180。引擎实测定律（2026-09-17 geoToScreen 探针 + 用户三轮行为拟合）：
    // 内容旋转 R = 180° − h → h=0 渲染南向上（用户实测车标与移动方向恒相反的根因），
    // h=180 才是真北向上。判别性：180 vs 0 差恰 180°。
    fireEvent.click(screen.getByRole('button', { name: 'North Up' }))
    const after = lookAt.filter((c) => typeof c.heading === 'number')
    expect(after[after.length - 1].heading).toBe(180)
    // playing 缺省=undefined（暂停态）：单步 setLookAtData position=车标坐标
    const firstAfterCar = after.find((c) => c.position !== undefined)
    expect(firstAfterCar).toBeTruthy()
    expect(firstAfterCar!.position).toMatchObject({ lat: trace[1].lat, lng: trace[1].lng })
  })

  // 2026-10-20 Phase 11：播放中滚轮缩放失效（探针定量：播放 8 格 +0.27 vs 暂停 +3.6）。
  // 根因：每帧跟随 setLookAtData 打断原生 WHEELZOOM 缩放动画。修法=播放中禁用原生通道，
  // 自建 wheel 监听走无动画 setZoom 步进（同步生效，follow 帧不携带 zoom → 无从打断）。
  function setupPlayback(playing: boolean | undefined) {
    const fake = installFakeH()
    const trace = [tp(49.0, 8.4, 0, 0), tp(49.01, 8.405, 0, 0.1)]
    const derived = [dp(0, 49.0, 8.4), dp(1, 49.01, 8.405)]
    const utils = render(
      <MapView trace={trace} derived={derived} mapStatus="ok" apikey="k" carPos={1} carTrace={trace} playing={playing} />,
    )
    const host = utils.container.querySelector('[data-testid="map-host"]') as HTMLElement
    return { ...fake, ...utils, host, trace, derived }
  }

  it('播放中：禁用原生 WHEELZOOM；wheel 走无动画 setZoom 步进（±0.5，animate=false）', () => {
    const { behaviorOps, zoomCalls, host } = setupPlayback(true)
    expect(behaviorOps.filter((o) => o.op === 'disable' && o.flag === 4).length).toBeGreaterThan(0)
    fireEvent.wheel(host, { deltaY: -120 })
    fireEvent.wheel(host, { deltaY: -120 })
    fireEvent.wheel(host, { deltaY: 120 })
    // 17 → 17.5 → 18 → 17.5：每次从上一次结果步进（判别于「固定目标值」型错误实现）
    expect(zoomCalls.map((c) => c.z)).toEqual([17.5, 18, 17.5])
    // 无动画同步生效是修复的机理核心：animate 必须为 false（undefined 则退回引擎默认动画 → 假绿）
    expect(zoomCalls.every((c) => c.animate === false)).toBe(true)
  })

  it('暂停：原生 WHEELZOOM 启用；wheel 不触发 setZoom（交还原生动画缩放）', () => {
    const { behaviorOps, zoomCalls, host } = setupPlayback(false)
    expect(behaviorOps.filter((o) => o.op === 'enable' && o.flag === 4).length).toBeGreaterThan(0)
    fireEvent.wheel(host, { deltaY: -120 })
    expect(zoomCalls).toHaveLength(0)
  })

  it('playing 切换：播放→暂停 enable 原生通道且 wheel 不再步进；暂停→播放再 disable', () => {
    const { behaviorOps, zoomCalls, host, trace, derived, rerender } = setupPlayback(true)
    rerender(
      <MapView trace={trace} derived={derived} mapStatus="ok" apikey="k" carPos={1} carTrace={trace} playing={false} />,
    )
    expect(behaviorOps[behaviorOps.length - 1]).toEqual({ op: 'enable', flag: 4 })
    fireEvent.wheel(host, { deltaY: -120 })
    expect(zoomCalls).toHaveLength(0)

    rerender(
      <MapView trace={trace} derived={derived} mapStatus="ok" apikey="k" carPos={1} carTrace={trace} playing />,
    )
    expect(behaviorOps[behaviorOps.length - 1]).toEqual({ op: 'disable', flag: 4 })
    fireEvent.wheel(host, { deltaY: -120 })
    expect(zoomCalls.map((c) => c.z)).toEqual([17.5])
  })
})
