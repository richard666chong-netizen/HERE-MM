import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import App from '../App'
import { cacheKey } from '../lib/fixtureStore'
import { derive } from '../lib/derive'
import { deviationStats } from '../lib/stats'
import type { CacheEntry, TrajPoint } from '../types'

// 测试代码豁免静态 import public/（src 运行时路径禁止，见计划 Global Constraints）
import trace0011 from '../../public/sample/here/2011_09_26_drive_0011.json'
import trace0033 from '../../public/sample/here/2011_09_30_drive_0033.json'
import fixture0011 from '../../public/fixtures/2011_09_26_drive_0011.json'
import fixture0033 from '../../public/fixtures/2011_09_30_drive_0033.json'

// 有 key 时 App 会调 loader：mock 掉防 script 注入/8s 超时（hoisted，空 key 用例 loader 本就不被调，零影响）
vi.mock('../lib/hereLoader', () => ({ loadHereMaps: vi.fn(() => Promise.resolve({})) }))

const TRACES: Record<string, unknown> = {
  '2011_09_26_drive_0011': trace0011,
  '2011_09_30_drive_0033': trace0033,
}
const FIXTURES: Record<string, unknown> = {
  '2011_09_26_drive_0011': fixture0011,
  '2011_09_30_drive_0033': fixture0033,
}

function jsonResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as Response
}

describe('App (Step1 编排壳)', () => {
  beforeEach(() => {
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
    const select = screen.getByRole('combobox') as HTMLSelectElement
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
})
