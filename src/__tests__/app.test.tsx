import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from '../App'
import { probeBasemap } from '../lib/hereLoader'
import { cacheKey } from '../lib/fixtureStore'
import { deadReckon, detectOutages } from '../lib/deadReckoning'
import { buildGnssFeed } from '../lib/gnssFeed'
import { derive } from '../lib/derive'
import { buildImportRequest } from '../lib/hereRouterClient'
import { deviationStats, driftSeries } from '../lib/stats'
import type { CacheEntry, TrajPoint } from '../types'

// 测试代码豁免静态 import public/（src 运行时路径禁止，见计划 Global Constraints）
import trace0093 from '../../public/sample/here/2011_09_26_drive_0093.json'
import trace0096 from '../../public/sample/here/2011_09_26_drive_0096.json'
import trace0042 from '../../public/sample/here/2011_10_03_drive_0042.json'
import fixture0093 from '../../public/fixtures/2011_09_26_drive_0093.json'
import fixture0096 from '../../public/fixtures/2011_09_26_drive_0096.json'

// 有 key 时 App 会调 loader + 底图探测：mock 掉防 script 注入/8s 超时（hoisted，空 key 用例本就不被调，零影响）。
// probeBasemap 缺省 true = 与接线前行为一致（mapStatus 仍为 'ok'），既有用例零回归。
vi.mock('../lib/hereLoader', () => ({
  loadHereMaps: vi.fn(() => Promise.resolve({})),
  probeBasemap: vi.fn(() => Promise.resolve(true)),
}))
const probeMock = vi.mocked(probeBasemap)

const TRACES: Record<string, unknown> = {
  '2011_09_26_drive_0093': trace0093,
  '2011_09_26_drive_0096': trace0096,
  '2011_10_03_drive_0042': trace0042,
}
const FIXTURES: Record<string, unknown> = {
  '2011_09_26_drive_0093': fixture0093,
  '2011_09_26_drive_0096': fixture0096,
}

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as Response
}

// vite base 感知的 URL 匹配：运行时 fetch 的本地资源必须带 BASE_URL 前缀（2026-10-20 线上 404
// 修复的回归锁——Pages 部署在 /HERE-MM/ 子路径，绝对路径 /sample 会打到域名根）。动态取
// BASE_URL 而非硬编码，base 变更时测试语义不变。
const BASE_RE = import.meta.env.BASE_URL.replace(/\//g, '\\/')
const TRACE_URL_RE = new RegExp(`^${BASE_RE}sample\\/here\\/(.+)\\.json$`)
const FIXTURE_URL_RE = new RegExp(`^${BASE_RE}fixtures\\/(.+)\\.json$`)

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
        const mTrace = url.match(TRACE_URL_RE)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(FIXTURE_URL_RE)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('renders header: POC title + drive selector; default drive is 0096', async () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'HERE Map Matching POC' })).toBeTruthy()
    const select = screen.getByRole('combobox', { name: 'Trajectory' }) as HTMLSelectElement
    expect(select.value).toBe('2011_09_26_drive_0096') // 默认选中 0096（林荫道真实失锁、真值可信——demo 首屏）
    expect(screen.getByRole('option', { name: /0093/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /0096/ })).toBeTruthy()
    // 等待异步取数完成，让挂起的状态更新落在 act 内（防 update-not-wrapped-in-act 噪声）
    await screen.findByText('MOCK')
  })

  it('loads mock match end-to-end: MOCK badge + exact stats chips + SVG fallback', async () => {
    render(<App />)
    expect(await screen.findByText('MOCK')).toBeTruthy() // 异步取数完成后角标亮

    // StatsPanel 汇总数字 = 同一份数据经 derive/deviationStats 的精确期望值（接线正确性）
    // Mock 模式下 DR 也运行：偏差 = DR 结果 → fixture MM
    const trace = trace0096 as unknown as TrajPoint[]
    const entry = fixture0096 as unknown as CacheEntry
    const feed = buildGnssFeed(trace)
    const drPos = deadReckon(feed).positions
    const liveTrace = feed.map((p, i) => ({ ...p, lat: drPos[i][0], lng: drPos[i][1] }))
    const stats = deviationStats(derive(liveTrace, entry.response))
    const driftMax = Math.max(0, ...driftSeries(trace, drPos))
    const chips: ReadonlyArray<readonly [string, number]> = [
      ['Mean Deviation', stats.meanM],
      ['P95 Deviation', stats.p95M],
      ['Max Deviation', stats.maxM],
      ['DR Max Drift', driftMax],
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
    const driveId = '2011_09_26_drive_0096'
    expect(localStorage.getItem(cacheKey(driveId))).not.toBeNull() // 未缓存加载后已回填

    fireEvent.click(screen.getByRole('button', { name: 'Clear Cache' }))
    expect(localStorage.getItem(cacheKey(driveId))).toBeNull() // 点击后（重载完成前）键已消失
    // 重载当前 driveId 完成：角标复亮 + 缓存回填（同时收敛异步更新进 act）
    await screen.findByText('MOCK')
    expect(localStorage.getItem(cacheKey(driveId))).not.toBeNull()
  })

  it('mock 回落回填的缓存条目 createdAt=写入时刻（24h TTL 的起点；防 fixture 录制日令 TTL 立即过期）', async () => {
    render(<App />)
    await screen.findByText('MOCK')
    const entry = JSON.parse(localStorage.getItem(cacheKey('2011_09_26_drive_0096'))!) as CacheEntry // 默认轨迹 0096
    expect(entry.source).toBe('mock')
    const ageMs = Date.now() - new Date(entry.createdAt).getTime()
    expect(ageMs).toBeGreaterThanOrEqual(0)
    expect(ageMs).toBeLessThan(60_000) // 「刚才写入」≠ fixture 的 9 月录制日（约 5 周前）
  })

  it('demo tab: replay bar + linked chart + car marker; switching back pauses', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)) // 不放帧：断言与时间解耦
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    render(<App />)
    await screen.findByText('MOCK')

    // 默认工程分析模式：tab 选中态 + 无回放条 + StatsPanel 在
    expect(screen.getByRole('tab', { name: 'Analysis' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.getByText('Deviation Histogram')).toBeTruthy()

    // 切到客户演示模式
    fireEvent.click(screen.getByRole('tab', { name: 'Demo' }))
    expect(screen.getByRole('tab', { name: 'Demo' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('Deviation Histogram')).toBeTruthy() // 统一面板：demo 同样显示
    expect(screen.getByTestId('current-deviation')).toBeTruthy() // 切片态红字读数在
    const trace = trace0096 as unknown as TrajPoint[]
    const slider = screen.getByRole('slider') as HTMLInputElement
    expect(Number(slider.max)).toBe(trace.length - 1) // 385
    const totalSec = trace[trace.length - 1].timestamp
    expect(screen.getByTestId('replay-time').textContent).toContain(`${totalSec.toFixed(1)}s`)
    expect(screen.getByTestId('replay-deviation').textContent).toContain('m')
    expect(screen.getByTestId('car-marker')).toBeTruthy() // SVG 兜底路径车标在

    // 播放按钮同步翻转；倍速按钮 aria-pressed
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '2x' }))
    expect(screen.getByRole('button', { name: '2x' }).getAttribute('aria-pressed')).toBe('true')

    // 播放中拖动进度条：pointerdown 即暂停（防 rAF 前推漂移）、松手自动续播；
    // 拖动后时间读数联动（期望值取自导入数据，不硬编码）
    fireEvent.pointerDown(slider)
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy() // 已暂停
    fireEvent.change(slider, { target: { value: '100' } })
    const t100 = trace[100].timestamp
    expect(screen.getByTestId('replay-time').textContent).toContain(`${t100.toFixed(1)}s`)
    fireEvent.pointerUp(slider)
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy() // 拖动前在播放 → 续播

    // 拖到终点松手：不重启播放（停在暂停态）
    fireEvent.pointerDown(slider)
    fireEvent.change(slider, { target: { value: String(trace.length - 1) } })
    fireEvent.pointerUp(slider)
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy() // 未续播（终点）

    // 切回工程分析：回放条消失并已暂停；再切回来按钮为「播放」（进度保留在终点）
    fireEvent.click(screen.getByRole('tab', { name: 'Analysis' }))
    expect(screen.queryByRole('slider')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Demo' }))
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy()
    expect((screen.getByRole('slider') as HTMLInputElement).value).toBe(String(trace.length - 1))
  })

  it('with key: live path lights LIVE badge; record button clears cache and reloads', async () => {
    vi.stubEnv('VITE_HERE_KEY', 'test-key')
    const liveResponse = (fixture0096 as unknown as CacheEntry).response
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.startsWith('https://router.hereapi.com/v8/import')) {
        return { ok: true, status: 200, json: async () => liveResponse } as Response
      }
      const mTrace = url.match(TRACE_URL_RE)
      if (mTrace) return jsonResponse(TRACES[mTrace[1]])
      const mFixture = url.match(FIXTURE_URL_RE)
      if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    expect(await screen.findByText('LIVE')).toBeTruthy() // live 调用成功 → 角标 LIVE
    const stored = JSON.parse(localStorage.getItem(cacheKey('2011_09_26_drive_0096'))!)
    expect(stored.source).toBe('live')

    // 录制按钮：清当前缓存 → 重载（再次 live）
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    expect(localStorage.getItem(cacheKey('2011_09_26_drive_0096'))).toBeNull() // 重载完成前键已消失
    expect(await screen.findByText('LIVE')).toBeTruthy() // 重载后复亮
    // 重载确实发生（评审修正，防「只删缓存不重载」假绿）：键经 live 回填恢复 + live 端点共调 2 次
    expect(localStorage.getItem(cacheKey('2011_09_26_drive_0096'))).not.toBeNull()
    const liveCalls = fetchMock.mock.calls.filter(([u]) => String(u).startsWith('https://router.hereapi.com/v8/import')).length
    expect(liveCalls).toBe(2)
  })

  it('record button hidden without key (existing mock path unaffected)', async () => {
    render(<App />)
    await screen.findByText('MOCK')
    expect(screen.queryByRole('button', { name: 'Record' })).toBeNull()
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
        const mTrace = url.match(TRACE_URL_RE)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(FIXTURE_URL_RE)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
    render(<App />)
    expect(await screen.findByText(/Load failed/i)).toBeTruthy()
    expect(localStorage.getItem(cacheKey('2011_09_26_drive_0096'))).toBeNull() // live entry 已被驱逐
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
        const mTrace = url.match(TRACE_URL_RE)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(FIXTURE_URL_RE)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    render(<App />)
    // 默认轨迹已是 0096，本用例锁 0093：显式切换后再断言请求体
    fireEvent.change(screen.getByRole('combobox', { name: 'Trajectory' }), { target: { value: '2011_09_26_drive_0093' } })
    await screen.findByText('LIVE')

    const drPositions = deadReckon(t0093).positions
    const drAugmented = t0093.map((p, i) => ({ ...p, lat: drPositions[i][0], lng: drPositions[i][1] }))
    const expectedBody = buildImportRequest(drAugmented)
    const actualBody = JSON.parse(capturedBody!).trace
    expect(actualBody).toEqual(expectedBody)
    const originalBody = buildImportRequest(t0093)
    expect(actualBody).not.toEqual(originalBody)
  })

  // Step5：0096 的失锁是 posmode==0（接收机无定位解）。失锁期 OXTS 是 INS 桥接解 ≈ 真值，
  // 直接拿它递推等于没做（实测仅偏离 2.51m）——live 请求必须走「冻结 GNSS 流」再递推。
  it('0096 live: DR-augmented trace from frozen GNSS feed (≠ 用原始 OXTS 递推的 body)', async () => {
    vi.stubEnv('VITE_HERE_KEY', 'test-key')
    const t0096 = trace0096 as unknown as TrajPoint[]
    const liveResponse = (fixture0096 as unknown as CacheEntry).response
    let capturedBody: string | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input)
        if (url.startsWith('https://router.hereapi.com/v8/import')) {
          capturedBody = init?.body as string
          return { ok: true, status: 200, json: async () => liveResponse } as Response
        }
        const mTrace = url.match(TRACE_URL_RE)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(FIXTURE_URL_RE)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    render(<App />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Trajectory' }), { target: { value: '2011_09_26_drive_0096' } })
    await screen.findByText('LIVE')

    const drPositions = deadReckon(buildGnssFeed(t0096)).positions
    const expectedBody = buildImportRequest(
      t0096.map((p, i) => ({ ...p, lat: drPositions[i][0], lng: drPositions[i][1] })),
    )
    const actualBody = JSON.parse(capturedBody!).trace
    expect(actualBody).toEqual(expectedBody)
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
    expect(screen.getByTestId('matched-path')?.children.length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('gnss-dot').length).toBeGreaterThan(0) // 散点逐点一个 testid
  })

  it('0093 live (无隧道): DR-augmented trace sent to HERE API (body ≠ original trace)', async () => {
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
        const mTrace = url.match(TRACE_URL_RE)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(FIXTURE_URL_RE)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    render(<App />)
    // 默认轨迹已是 0096，本用例锁 0093：显式切换后再断言请求体
    fireEvent.change(screen.getByRole('combobox', { name: 'Trajectory' }), { target: { value: '2011_09_26_drive_0093' } })
    await screen.findByText('LIVE')

    expect(detectOutages(t0093, 4).some(Boolean)).toBe(true)
    const drPositions = deadReckon(t0093).positions
    const expectedBody = buildImportRequest(
      t0093.map((p, i) => ({ ...p, lat: drPositions[i][0], lng: drPositions[i][1] })),
    )
    const actualBody = JSON.parse(capturedBody!).trace
    expect(actualBody).toEqual(expectedBody)
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
        const mTrace = url.match(TRACE_URL_RE)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(FIXTURE_URL_RE)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    render(<App />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Trajectory' }), {
      target: { value: '2011_10_03_drive_0042' },
    })
    await screen.findByText('LIVE')
    fireEvent.change(screen.getByRole('combobox', { name: 'Tunnel' }), { target: { value: '60' } })
    // 三次请求：初始 0096（默认）→ 换 0042（隧道仍关）→ 开隧道 60s（缓存按隧道时长分档 → 必然重取数）
    await waitFor(() => expect(bodies.length).toBe(3))

    const feed = buildGnssFeed(t, { tunnelDurationS: 60 })
    const dr = deadReckon(feed).positions
    const expected = buildImportRequest(feed.map((p, i) => ({ ...p, lat: dr[i][0], lng: dr[i][1] })))
    expect(JSON.parse(bodies[2]).trace).toEqual(expected)
    expect(JSON.parse(bodies[2]).trace).not.toEqual(JSON.parse(bodies[1]).trace)
  })

  it('0093 live + 隧道 60s：隧道是场景参数，也会被套上（≠ 隧道关闭时的请求体）', async () => {
    vi.stubEnv('VITE_HERE_KEY', 'test-key')
    const t = trace0093 as unknown as TrajPoint[]
    let count = 0
    let capturedBody = ''
    const liveResp = (fixture0093 as unknown as CacheEntry).response
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
            json: async () => liveResp,
          } as Response
        }
        const mTrace = url.match(TRACE_URL_RE)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(FIXTURE_URL_RE)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    render(<App />)
    // 默认轨迹已是 0096，本用例锁 0093：显式切换后再开隧道
    fireEvent.change(screen.getByRole('combobox', { name: 'Trajectory' }), { target: { value: '2011_09_26_drive_0093' } })
    await screen.findByText('LIVE')
    fireEvent.change(screen.getByRole('combobox', { name: 'Tunnel' }), { target: { value: '60' } })
    // 三次 live 请求：初始 0096（默认）→ 切 0093 → 开隧道 60s（缓存按隧道时长分档 → 必然重取数）
    await waitFor(() => expect(count).toBe(3))
    const feed = buildGnssFeed(t, { tunnelDurationS: 60 })
    const dr = deadReckon(feed).positions
    const expected = buildImportRequest(feed.map((p, i) => ({ ...p, lat: dr[i][0], lng: dr[i][1] })))
    expect(JSON.parse(capturedBody).trace).toEqual(expected)
    expect(JSON.parse(capturedBody).trace).not.toEqual(buildImportRequest(t))
  })

  it('统计面板 DR 漂移读数：0042 + 隧道 60s → max|DR − 真值| = 66.86m', async () => {
    vi.stubEnv('VITE_HERE_KEY', 'test-key')
    let count = 0
    const liveResp = (fixture0093 as unknown as CacheEntry).response
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
            json: async () => liveResp,
          } as Response
        }
        const mTrace = url.match(TRACE_URL_RE)
        if (mTrace) return jsonResponse(TRACES[mTrace[1]])
        const mFixture = url.match(FIXTURE_URL_RE)
        if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    render(<App />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Trajectory' }), {
      target: { value: '2011_10_03_drive_0042' },
    })
    await screen.findByText('LIVE')
    fireEvent.change(screen.getByRole('combobox', { name: 'Tunnel' }), { target: { value: '60' } })
    await waitFor(() => expect(count).toBe(3))

    // DR Max Drift chip 常驻渲染（统一面板口径，不再按失锁门控）：0042+60s 隧道 → 漂移爬升至 66.86m
    const chip = screen.getByText('DR Max Drift').closest('[data-testid="stat-chip"]')!
    expect(chip.textContent).toContain('66.86 m') // 实测：横向 58.6m + 沿轨 ~8m
  })
})
