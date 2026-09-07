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
})
