import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../App'
import { probeBasemap } from '../lib/hereLoader'
import { cacheKey } from '../lib/fixtureStore'
import { deadReckon, detectOutages } from '../lib/deadReckoning'
import { buildGnssFeed } from '../lib/gnssFeed'
import { derive } from '../lib/derive'
import { buildImportRequest } from '../lib/hereRouterClient'
import { deviationStats } from '../lib/stats'
import type { CacheEntry, TrajPoint } from '../types'

// 测试代码豁免静态 import public/（src 运行时路径禁止，见计划 Global Constraints）
import trace0011 from '../../public/sample/here/2011_09_26_drive_0011.json'
import trace0033 from '../../public/sample/here/2011_09_30_drive_0033.json'
import trace0093 from '../../public/sample/here/2011_09_26_drive_0093.json'
import trace0096 from '../../public/sample/here/2011_09_26_drive_0096.json'
import trace0042 from '../../public/sample/here/2011_10_03_drive_0042.json'
import fixture0011 from '../../public/fixtures/2011_09_26_drive_0011.json'
import fixture0033 from '../../public/fixtures/2011_09_30_drive_0033.json'
import fixture0093 from '../../public/fixtures/2011_09_26_drive_0093.json'

// 有 key 时 App 会调 loader + 底图探测：mock 掉防 script 注入/8s 超时（hoisted，空 key 用例本就不被调，零影响）。
// probeBasemap 缺省 true = 与接线前行为一致（mapStatus 仍为 'ok'），既有用例零回归。
vi.mock('../lib/hereLoader', () => ({
  loadHereMaps: vi.fn(() => Promise.resolve({})),
  probeBasemap: vi.fn(() => Promise.resolve(true)),
}))
const probeMock = vi.mocked(probeBasemap)

const TRACES: Record<string, unknown> = {
  '2011_09_26_drive_0011': trace0011,
  '2011_09_30_drive_0033': trace0033,
  '2011_09_26_drive_0093': trace0093,
  '2011_09_26_drive_0096': trace0096,
  '2011_10_03_drive_0042': trace0042,
}
const FIXTURES: Record<string, unknown> = {
  '2011_09_26_drive_0011': fixture0011,
  '2011_09_30_drive_0033': fixture0033,
  '2011_09_26_drive_0093': fixture0093,
}

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as Response
}

describe('App (Step1 编排壳)', () => {
  beforeEach(() => {
    probeMock.mockReset()
    probeMock.mockResolvedValue(true) // 缺省可达（与接线前一致）；探测失败用例自行覆盖
    localStorage.clear() // jsdom localStorage 跨测试持久，隔离缓存命中路径
    // 空 key → App 同步走 fallback 路径，loader 永不被调：
    // 防 .env 真 key 泄入 Vitest（共享 vite.config.ts）+ script 注入不受 fetch 桩拦截 + 8s 超时撞 5s testTimeout
    vi.stubEnv('VITE_HERE_KEY', '')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        const mTrace = url.match(/^\/sample\/here\/(.+)\.json$/)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(/^\/fixtures\/(.+)\.json$/)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('renders header: POC title + drive selector with 0033/0011', async () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'HERE Map Matching POC' })).toBeTruthy()
    const select = screen.getByRole('combobox', { name: '轨迹' }) as HTMLSelectElement
    expect(select.value).toBe('2011_09_30_drive_0033') // 默认选中 0033
    expect(screen.getByRole('option', { name: /0033/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /0011/ })).toBeTruthy()
    // 等待异步取数完成，让挂起的状态更新落在 act 内（防 update-not-wrapped-in-act 噪声）
    await screen.findByText('MOCK')
  })

  it('loads mock match end-to-end: MOCK badge + exact stats chips + SVG fallback', async () => {
    render(<App />)
    expect(await screen.findByText('MOCK')).toBeTruthy() // 异步取数完成后角标亮

    // StatsPanel 汇总数字 = 同一份数据经 derive/deviationStats 的精确期望值（接线正确性）
    const trace = trace0033 as unknown as TrajPoint[]
    const entry = fixture0033 as unknown as CacheEntry
    const stats = deviationStats(derive(trace, entry.response))
    const chips: ReadonlyArray<readonly [string, number]> = [
      ['均值', stats.meanM],
      ['95分位', stats.p95M],
      ['最大', stats.maxM],
    ]
    for (const [label, v] of chips) {
      const chip = screen.getByText(label)!.closest('[data-testid="stat-chip"]')!
      expect(chip.textContent).toContain(`${v.toFixed(2)} m`)
    }

    // SvgFallback 挂载（空 key 同步 fallback，HERE loader 未被调）
    expect(screen.getAllByTestId('gnss-dot').length).toBeGreaterThan(1)
    expect(screen.getAllByTestId('endpoint-marker').length).toBe(2)
  })

  it('clear-cache button removes the here-mm-cache key for current drive', async () => {
    render(<App />)
    await screen.findByText('MOCK')
    const driveId = '2011_09_30_drive_0033'
    expect(localStorage.getItem(cacheKey(driveId))).not.toBeNull() // 未缓存加载后已回填

    fireEvent.click(screen.getByRole('button', { name: '清除缓存' }))
    expect(localStorage.getItem(cacheKey(driveId))).toBeNull() // 点击后（重载完成前）键已消失
    // 重载当前 driveId 完成：角标复亮 + 缓存回填（同时收敛异步更新进 act）
    await screen.findByText('MOCK')
    expect(localStorage.getItem(cacheKey(driveId))).not.toBeNull()
  })

  it('demo tab: replay bar + linked chart + car marker; switching back pauses', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)) // 不放帧：断言与时间解耦
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    render(<App />)
    await screen.findByText('MOCK')

    // 默认工程分析模式：tab 选中态 + 无回放条 + StatsPanel 在
    expect(screen.getByRole('tab', { name: '工程分析模式' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.getByText('偏差分布直方图')).toBeTruthy()

    // 切到客户演示模式
    fireEvent.click(screen.getByRole('tab', { name: '客户演示模式' }))
    expect(screen.getByRole('tab', { name: '客户演示模式' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByText('偏差分布直方图')).toBeNull() // 侧栏换成回放曲线
    const trace = trace0033 as unknown as TrajPoint[]
    const slider = screen.getByRole('slider') as HTMLInputElement
    expect(Number(slider.max)).toBe(trace.length - 1) // 1593
    const totalSec = trace[trace.length - 1].timestamp
    expect(screen.getByTestId('replay-time').textContent).toContain(`${totalSec.toFixed(1)}s`)
    expect(screen.getByTestId('replay-deviation').textContent).toContain('m')
    expect(screen.getByTestId('car-marker')).toBeTruthy() // SVG 兜底路径车标在

    // 播放按钮同步翻转；倍速按钮 aria-pressed
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    expect(screen.getByRole('button', { name: '暂停' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '2x' }))
    expect(screen.getByRole('button', { name: '2x' }).getAttribute('aria-pressed')).toBe('true')

    // 播放中拖动进度条：pointerdown 即暂停（防 rAF 前推漂移）、松手自动续播；
    // 拖动后时间读数联动（期望值取自导入数据，不硬编码）
    fireEvent.pointerDown(slider)
    expect(screen.getByRole('button', { name: '播放' })).toBeTruthy() // 已暂停
    fireEvent.change(slider, { target: { value: '100' } })
    const t100 = trace[100].timestamp
    expect(screen.getByTestId('replay-time').textContent).toContain(`${t100.toFixed(1)}s`)
    fireEvent.pointerUp(slider)
    expect(screen.getByRole('button', { name: '暂停' })).toBeTruthy() // 拖动前在播放 → 续播

    // 拖到终点松手：不重启播放（停在暂停态）
    fireEvent.pointerDown(slider)
    fireEvent.change(slider, { target: { value: String(trace.length - 1) } })
    fireEvent.pointerUp(slider)
    expect(screen.getByRole('button', { name: '播放' })).toBeTruthy() // 未续播（终点）

    // 切回工程分析：回放条消失并已暂停；再切回来按钮为「播放」（进度保留在终点）
    fireEvent.click(screen.getByRole('tab', { name: '工程分析模式' }))
    expect(screen.queryByRole('slider')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '客户演示模式' }))
    expect(screen.getByRole('button', { name: '播放' })).toBeTruthy()
    expect((screen.getByRole('slider') as HTMLInputElement).value).toBe(String(trace.length - 1))
  })

  it('with key: live path lights LIVE badge; record button clears cache and reloads', async () => {
    vi.stubEnv('VITE_HERE_KEY', 'test-key')
    const liveResponse = {
      routes: [
        { id: 'r', sections: [{ id: 's', type: 'vehicle', polyline: (fixture0033 as unknown as CacheEntry).response.routes[0].sections[0].polyline, summary: { duration: 1740, length: 1740 } }] },
      ],
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.startsWith('https://router.hereapi.com/v8/import')) {
        return { ok: true, status: 200, json: async () => liveResponse } as Response
      }
      const mTrace = url.match(/^\/sample\/here\/(.+)\.json$/)
      if (mTrace) return jsonResponse(TRACES[mTrace[1]])
      const mFixture = url.match(/^\/fixtures\/(.+)\.json$/)
      if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    expect(await screen.findByText('LIVE')).toBeTruthy() // live 调用成功 → 角标 LIVE
    const stored = JSON.parse(localStorage.getItem(cacheKey('2011_09_30_drive_0033'))!)
    expect(stored.source).toBe('live')

    // 录制按钮：清当前缓存 → 重载（再次 live）
    fireEvent.click(screen.getByRole('button', { name: '录制' }))
    expect(localStorage.getItem(cacheKey('2011_09_30_drive_0033'))).toBeNull() // 重载完成前键已消失
    expect(await screen.findByText('LIVE')).toBeTruthy() // 重载后复亮
    // 重载确实发生（评审修正，防「只删缓存不重载」假绿）：键经 live 回填恢复 + live 端点共调 2 次
    expect(localStorage.getItem(cacheKey('2011_09_30_drive_0033'))).not.toBeNull()
    const liveCalls = fetchMock.mock.calls.filter(([u]) => String(u).startsWith('https://router.hereapi.com/v8/import')).length
    expect(liveCalls).toBe(2)
  })

  it('record button hidden without key (existing mock path unaffected)', async () => {
    render(<App />)
    await screen.findByText('MOCK')
    expect(screen.queryByRole('button', { name: '录制' })).toBeNull()
  })

  it('live entry with undecodable polyline is evicted from cache on derive failure', async () => {
    vi.stubEnv('VITE_HERE_KEY', 'test-key')
    const badLive = {
      routes: [
        { id: 'r', sections: [{ id: 's', type: 'vehicle', polyline: '!!not-a-polyline!!', summary: { duration: 9, length: 44 } }] },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input)
        if (url.startsWith('https://router.hereapi.com/v8/import')) {
          return { ok: true, status: 200, json: async () => badLive } as Response
        }
        const mTrace = url.match(/^\/sample\/here\/(.+)\.json$/)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(/^\/fixtures\/(.+)\.json$/)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
    render(<App />)
    expect(await screen.findByText(/加载失败/)).toBeTruthy() // derive 对坏 polyline 抛错
    expect(localStorage.getItem(cacheKey('2011_09_30_drive_0033'))).toBeNull() // live entry 已被驱逐
  })

  // Step4 T4：DR 增强 live 匹配。0093 含失锁点 → live 请求 trace 用 DR 位置替换 lat/lng；
  // 0033 无失锁点 → live 请求零变化（门控阈值 4 下 ≤4 星点为 0）。
  it('0093 live: DR-augmented trace sent to HERE API (body ≠ original trace)', async () => {
    vi.stubEnv('VITE_HERE_KEY', 'test-key')
    const t0093 = trace0093 as unknown as TrajPoint[]
    const f0093 = fixture0093 as unknown as CacheEntry
    const liveResponse = f0093.response
    let capturedBody: string | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.startsWith('https://router.hereapi.com/v8/import')) {
          capturedBody = init?.body as string
          return { ok: true, status: 200, json: async () => liveResponse } as Response
        }
        const mTrace = url.match(/^\/sample\/here\/(.+)\.json$/)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(/^\/fixtures\/(.+)\.json$/)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    render(<App />)
    // 选 0093（下拉第三项）
    fireEvent.change(screen.getByRole('combobox', { name: '轨迹' }), { target: { value: '2011_09_26_drive_0093' } })
    await screen.findByText('LIVE')

    // 期望 body.trace = buildImportRequest(drAugmented)（DR 位置替换 lat/lng，同进程同变换含 round6）
    const drPositions = deadReckon(t0093).positions
    const drAugmented = t0093.map((p, i) => ({ ...p, lat: drPositions[i][0], lng: drPositions[i][1] }))
    const expectedBody = buildImportRequest(drAugmented)
    const actualBody = JSON.parse(capturedBody!).trace
    expect(actualBody).toEqual(expectedBody)
    // 反断言：body ≠ buildImportRequest(原始 trace)——「忘了增强」的真证伪点
    const originalBody = buildImportRequest(t0093)
    expect(actualBody).not.toEqual(originalBody)
  })

  // Step5：0096 的失锁是 posmode==0（接收机无定位解）。失锁期 OXTS 是 INS 桥接解 ≈ 真值，
  // 直接拿它递推等于没做（实测仅偏离 2.51m）——live 请求必须走「冻结 GNSS 流」再递推。
  it('0096 live: DR-augmented trace from frozen GNSS feed (≠ 用原始 OXTS 递推的 body)', async () => {
    vi.stubEnv('VITE_HERE_KEY', 'test-key')
    const t0096 = trace0096 as unknown as TrajPoint[]
    const liveResponse = (fixture0093 as unknown as CacheEntry).response // 桩只需合法响应形状，断言在请求体
    let capturedBody: string | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.startsWith('https://router.hereapi.com/v8/import')) {
          capturedBody = init?.body as string
          return { ok: true, status: 200, json: async () => liveResponse } as Response
        }
        const mTrace = url.match(/^\/sample\/here\/(.+)\.json$/)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(/^\/fixtures\/(.+)\.json$/)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    render(<App />)
    fireEvent.change(screen.getByRole('combobox', { name: '轨迹' }), { target: { value: '2011_09_26_drive_0096' } })
    await screen.findByText('LIVE')

    const drPositions = deadReckon(buildGnssFeed(t0096)).positions
    const expectedBody = buildImportRequest(
      t0096.map((p, i) => ({ ...p, lat: drPositions[i][0], lng: drPositions[i][1] })),
    )
    const actualBody = JSON.parse(capturedBody!).trace
    expect(actualBody).toEqual(expectedBody)
    // 反断言：≠ 用原始 OXTS 递推的 body——「忘了接 gnssFeed」的真证伪点
    const rawPositions = deadReckon(t0096).positions
    const rawBody = buildImportRequest(
      t0096.map((p, i) => ({ ...p, lat: rawPositions[i][0], lng: rawPositions[i][1] })),
    )
    expect(actualBody).not.toEqual(rawBody)
  })

  // Step5：SDK 脚本加载成功 ≠ 瓦片能到达（VPN/企业网静默拦截 → 地图区白板、控制台零报错）。
  // 探测失败必须落 SVG 兜底而不是留一块空白，且探测确实被调用（防「忘了接线」）。
  it('底图探测失败：仍渲染 SVG 兜底（非白板），且探测带 apikey 被调用', async () => {
    vi.stubEnv('VITE_HERE_KEY', 'test-key')
    probeMock.mockResolvedValue(false)
    render(<App />)
    await screen.findByText('MOCK')
    expect(probeMock).toHaveBeenCalledWith('test-key')
    expect(screen.getByTestId('matched-path')).toBeTruthy() // 兜底路径渲染中，不是空白
    expect(screen.getAllByTestId('gnss-dot').length).toBeGreaterThan(0) // 散点逐点一个 testid
  })

  it('0033 live: zero DR augmentation (no outages at threshold 4 → trace unchanged)', async () => {
    vi.stubEnv('VITE_HERE_KEY', 'test-key')
    const t0033 = trace0033 as unknown as TrajPoint[]
    const f0033 = fixture0033 as unknown as CacheEntry
    const liveResponse = f0033.response
    let capturedBody: string | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.startsWith('https://router.hereapi.com/v8/import')) {
          capturedBody = init?.body as string
          return { ok: true, status: 200, json: async () => liveResponse } as Response
        }
        const mTrace = url.match(/^\/sample\/here\/(.+)\.json$/)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(/^\/fixtures\/(.+)\.json$/)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    render(<App />)
    await screen.findByText('LIVE')

    // 0033 在门控阈值 4 下 ≤4 星点为 0 → live 请求零变化
    expect(detectOutages(t0033, 4).some(Boolean)).toBe(false) // 前置验证
    const actualBody = JSON.parse(capturedBody!).trace
    const expectedBody = buildImportRequest(t0033)
    expect(actualBody).toEqual(expectedBody) // 原始 trace 直送，无 DR 增强
  })

  // Step6 仿真隧道：旋钮改变 live 请求的 trace（DR 的输入是隧道流）。
  // 隧道是**场景参数**——轨迹/航向/速度全真，只有「GNSS 被拒止多久」是设定值。
  it('0042 live + 隧道 60s：请求体 = DR(隧道流)，且 ≠ 隧道关闭时的请求体', async () => {
    vi.stubEnv('VITE_HERE_KEY', 'test-key')
    const t = trace0042 as unknown as TrajPoint[]
    const liveResponse = (fixture0093 as unknown as CacheEntry).response
    const bodies: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.startsWith('https://router.hereapi.com/v8/import')) {
          bodies.push(init?.body as string)
          return { ok: true, status: 200, json: async () => liveResponse } as Response
        }
        const mTrace = url.match(/^\/sample\/here\/(.+)\.json$/)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(/^\/fixtures\/(.+)\.json$/)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    render(<App />)
    fireEvent.change(screen.getByRole('combobox', { name: '轨迹' }), {
      target: { value: '2011_10_03_drive_0042' },
    })
    await screen.findByText('LIVE')
    fireEvent.change(screen.getByRole('combobox', { name: '隧道' }), { target: { value: '60' } })
    // 三次请求：初始 0033 → 换 0042（隧道仍关）→ 开隧道 60s（缓存按隧道时长分档 → 必然重取数）
    await waitFor(() => expect(bodies.length).toBe(3))

    const feed = buildGnssFeed(t, { tunnelDurationS: 60 })
    const dr = deadReckon(feed).positions
    const expected = buildImportRequest(feed.map((p, i) => ({ ...p, lat: dr[i][0], lng: dr[i][1] })))
    expect(JSON.parse(bodies[2]).trace).toEqual(expected)
    // 反断言：隧道开启后的请求体 ≠ 同一轨迹隧道关闭时的请求体——「旋钮没接线」的真证伪点
    expect(JSON.parse(bodies[2]).trace).not.toEqual(JSON.parse(bodies[1]).trace)
  })

  it('0033 live + 隧道 60s：隧道是场景参数，对照轨迹也会被套上（≠ 隧道关闭时的请求体）', async () => {
    vi.stubEnv('VITE_HERE_KEY', 'test-key')
    const t = trace0033 as unknown as TrajPoint[]
    let count = 0
    let capturedBody = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.startsWith('https://router.hereapi.com/v8/import')) {
          count++
          capturedBody = init?.body as string
          return {
            ok: true,
            status: 200,
            json: async () => (fixture0033 as unknown as CacheEntry).response,
          } as Response
        }
        const mTrace = url.match(/^\/sample\/here\/(.+)\.json$/)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(/^\/fixtures\/(.+)\.json$/)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    render(<App />)
    await screen.findByText('LIVE')
    fireEvent.change(screen.getByRole('combobox', { name: '隧道' }), { target: { value: '60' } })
    await waitFor(() => expect(count).toBe(2)) // 初始 0033 + 开隧道后重取数
    // 0033 无 posmode 列，但隧道窗口照样生效（场景参数作用于当前轨迹，不挑宿主）
    const feed = buildGnssFeed(t, { tunnelDurationS: 60 })
    const dr = deadReckon(feed).positions
    const expected = buildImportRequest(feed.map((p, i) => ({ ...p, lat: dr[i][0], lng: dr[i][1] })))
    expect(JSON.parse(capturedBody).trace).toEqual(expected)
    expect(JSON.parse(capturedBody).trace).not.toEqual(buildImportRequest(t)) // 确实变了
  })

  it('统计面板 DR 漂移读数：0042 + 隧道 60s → max|DR − 真值| = 66.86m', async () => {
    vi.stubEnv('VITE_HERE_KEY', 'test-key')
    let count = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.startsWith('https://router.hereapi.com/v8/import')) {
          count++
          void init
          return {
            ok: true,
            status: 200,
            json: async () => (fixture0093 as unknown as CacheEntry).response,
          } as Response
        }
        const mTrace = url.match(/^\/sample\/here\/(.+)\.json$/)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(/^\/fixtures\/(.+)\.json$/)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    render(<App />)
    fireEvent.change(screen.getByRole('combobox', { name: '轨迹' }), {
      target: { value: '2011_10_03_drive_0042' },
    })
    await screen.findByText('LIVE')
    fireEvent.change(screen.getByRole('combobox', { name: '隧道' }), { target: { value: '60' } })
    await waitFor(() => expect(count).toBe(3))

    // 隧道关闭时不显示该 chip（无失锁叙事就无 DR 漂移可言）
    const chip = screen.getByText('DR 漂移').closest('[data-testid="stat-chip"]')!
    expect(chip.textContent).toContain('66.86 m') // 实测：横向 58.6m + 沿轨 ~8m
  })
})
