import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CacheEntry } from '../types'
// 测试代码豁免静态 import public/（src 运行时路径禁止，见 Global Constraints）
import f0093 from '../../public/fixtures/2011_09_26_drive_0093.json'
import fixture0093Fixture from '../../public/fixtures/2011_09_26_drive_0093.json'
import { cacheKey, loadFixture, matchService, readCache, writeCache } from './fixtureStore'

const entry0093 = f0093 as unknown as CacheEntry

// vite base 前缀（2026-10-20 线上 404 修复的回归锁）：动态取值，base 变更时测试语义不变
const BASE = import.meta.env.BASE_URL

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('cacheKey', () => {
  it('is `here-mm-cache:{version}:{driveId}`（版本随 derive 算法升级）', () => {
    expect(cacheKey('2011_09_26_drive_0093')).toBe('here-mm-cache:v4:2011_09_26_drive_0093')
  })
})

describe('localStorage cache layer', () => {
  it('writeCache → readCache roundtrip', () => {
    writeCache(entry0093)
    const cached = readCache('2011_09_26_drive_0093')
    expect(cached).not.toBeNull()
    expect(cached!.response.routes[0].sections).toBeDefined()
    expect(cached!.response.routes[0].sections.length).toBeGreaterThan(0)
  })
  it('readCache miss returns null', () => {
    expect(readCache('2011_09_26_drive_0093')).toBeNull()
  })
  it('corrupted JSON silently degrades to null', () => {
    localStorage.setItem(cacheKey('2011_09_26_drive_0093'), '{not-json')
    expect(readCache('2011_09_26_drive_0093')).toBeNull()
  })
})

describe('loadFixture', () => {
  it('fetches /fixtures/<driveId>.json and returns entry', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => entry0093 }))
    vi.stubGlobal('fetch', fetchMock)
    const entry = await loadFixture('2011_09_26_drive_0093')
    expect(entry.response.routes[0].sections).toBeDefined()
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}fixtures/2011_09_26_drive_0093.json`)
  })
  it('variant fetches /fixtures/<driveId>-<variant>.json first', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...entry0093, driveId: '2011_10_03_drive_0042' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    await loadFixture('2011_10_03_drive_0042', 't60')
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}fixtures/2011_10_03_drive_0042-t60.json`)
  })
  it('variant falls back to base fixture when variant file not found', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        if (url.includes('-t30')) return { ok: false, status: 404, json: async () => ({}) }
        return { ok: true, status: 200, json: async () => entry0093 }
      }),
    )
    const entry = await loadFixture('2011_09_26_drive_0093', 't30')
    expect(entry.response.routes[0].sections).toBeDefined()
    expect(calls).toEqual([`${BASE}fixtures/2011_09_26_drive_0093-t30.json`, `${BASE}fixtures/2011_09_26_drive_0093.json`])
  })
  it('all urls fail throws `fixture load failed: <driveId>-<variant>`', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    await expect(loadFixture('missing_drive', 't60')).rejects.toThrow('fixture load failed: missing_drive-t60')
  })
  it('no variant: single url failure throws `fixture load failed: <driveId>`', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    await expect(loadFixture('missing_drive')).rejects.toThrow('fixture load failed: missing_drive')
  })
  it('JSON parse failure throws `fixture load failed: <driveId>`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token')
        },
      })),
    )
    await expect(loadFixture('bad_drive')).rejects.toThrow('fixture load failed: bad_drive')
  })
})


describe('matchService', () => {
  it('cache hit returns entry without touching fetch', async () => {
    // 契约变更（方案 A）：mock 源条目只有 <24h 才短路命中；真实 fixture 的 createdAt 是 9 月录制日，
    // 原样入缓存会被判过期——刷成新鲜时间戳，本测试的意图（命中不打 fetch）由 fresh 分支承载
    writeCache({ ...entry0093, createdAt: new Date().toISOString() })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(matchService('2011_09_26_drive_0093')).resolves.toEqual(expect.objectContaining({ driveId: '2011_09_26_drive_0093' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('cache miss falls back to fixture fetch and returns entry', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => entry0093 }))
    vi.stubGlobal('fetch', fetchMock)
    const entry = await matchService('2011_09_26_drive_0093')
    expect(entry.response.routes[0].sections).toBeDefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}fixtures/2011_09_26_drive_0093.json`)
  })
})

describe('matchService live 分支', () => {
  const TRACE = [
    { lat: 49.0, lng: 8.4, timestamp: 0, timestampUtc: '', headingDeg: 0, speedMps: 0, numsats: 7 },
    { lat: 49.001, lng: 8.401, timestamp: 0.1, timestampUtc: '', headingDeg: 0, speedMps: 0, numsats: 7 },
    { lat: 49.002, lng: 8.402, timestamp: 0.2, timestampUtc: '', headingDeg: 0, speedMps: 0, numsats: 7 },
  ]
  const REAL_POLYLINE = (fixture0093Fixture as unknown as { response: { routes: { sections: { polyline: string }[] }[] } }).response.routes[0].sections[0].polyline
  const LIVE_RESPONSE = {
    routes: [
      { id: 'r', sections: [{ id: 's', type: 'vehicle', polyline: REAL_POLYLINE, summary: { duration: 1740, length: 1740 } }] },
    ],
  }

  function stubFetch(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      for (const [prefix, data] of Object.entries(routes)) {
        if (url.startsWith(prefix)) return { ok: true, status: 200, json: async () => data } as Response
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fn)
    return fn
  }

  it('cache miss + opts: live success → source live + 写缓存', async () => {
    const fn = stubFetch({ 'https://router.hereapi.com/v8/import': LIVE_RESPONSE })
    const entry = await matchService('2011_09_26_drive_0093', { apikey: 'k', trace: TRACE })
    expect(entry.source).toBe('live')
    expect(entry.response).toEqual(LIVE_RESPONSE)
    expect(String(fn.mock.calls[0]![0])).toContain('router.hereapi.com/v8/import')
    const stored = JSON.parse(localStorage.getItem(cacheKey('2011_09_26_drive_0093'))!)
    expect(stored.source).toBe('live')
  })

  it('live failure → silent fallback to fixture (source mock)', async () => {
    const fixtureEntry = { driveId: '2011_09_26_drive_0093', source: 'mock', createdAt: '', response: LIVE_RESPONSE, derived: [] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        if (String(input).startsWith(`${BASE}fixtures/`)) {
          return { ok: true, status: 200, json: async () => fixtureEntry } as Response
        }
        return { ok: false, status: 503, json: async () => ({}) } as Response
      }),
    )
    const entry = await matchService('2011_09_26_drive_0093', { apikey: 'k', trace: TRACE })
    expect(entry.source).toBe('mock')
  })

  it('cache hit: live fetch never called', async () => {
    const fn = stubFetch({ 'https://router.hereapi.com': LIVE_RESPONSE })
    writeCache({ driveId: '2011_09_26_drive_0093', source: 'live', createdAt: '', response: LIVE_RESPONSE as never, derived: [] })
    const entry = await matchService('2011_09_26_drive_0093', { apikey: 'k', trace: TRACE })
    expect(entry.source).toBe('live')
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('matchService 自愈：mock 缓存 24h TTL（2026-10-20 锐边修复，用户拍板方案 A）', () => {
  // 背景：live 失败落 fixture 的条目会被 App 回填进缓存，此后缓存命中短路、永远 MOCK 直到手动清除——
  // 「一次瞬断永久钉死」。本组测试锁 TTL 语义：mock 条目超 24h 视为无缓存重试 live；live 条目永不过期。
  const TTL_MS = 24 * 3600 * 1000
  const fresh = (): string => new Date(Date.now() - 1000).toISOString()
  const stale = (): string => new Date(Date.now() - TTL_MS - 1000).toISOString()

  // 与 'matchService live 分支' describe 内同名常量保持同形（其作用于该 describe 内部，此处需本地副本）
  const TRACE = [
    { lat: 49.0, lng: 8.4, timestamp: 0, timestampUtc: '', headingDeg: 0, speedMps: 0, numsats: 7 },
    { lat: 49.001, lng: 8.401, timestamp: 0.1, timestampUtc: '', headingDeg: 0, speedMps: 0, numsats: 7 },
    { lat: 49.002, lng: 8.402, timestamp: 0.2, timestampUtc: '', headingDeg: 0, speedMps: 0, numsats: 7 },
  ]
  const REAL_POLYLINE = (fixture0093Fixture as unknown as { response: { routes: { sections: { polyline: string }[] }[] } }).response.routes[0].sections[0].polyline
  const LIVE_RESPONSE = {
    routes: [
      { id: 'r', sections: [{ id: 's', type: 'vehicle', polyline: REAL_POLYLINE, summary: { duration: 1740, length: 1740 } }] },
    ],
  }
  const MOCK_ENTRY: CacheEntry = {
    driveId: '2011_09_26_drive_0093',
    source: 'mock',
    createdAt: '',
    response: LIVE_RESPONSE as never, // 同 'matchService live 分支' 的写法：只验证调用路径，不构造完整 ImportResponse
    derived: [],
  }

  function stubRouterOk() {
    const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).startsWith('https://router.hereapi.com')) {
        return { ok: true, status: 200, json: async () => LIVE_RESPONSE } as Response
      }
      throw new Error(`unexpected fetch: ${String(input)}`)
    })
    vi.stubGlobal('fetch', fn)
    return fn
  }

  it('mock 缓存未过期（<24h）：直接命中，不碰 fetch（24h 内免打扰）', async () => {
    writeCache({ ...MOCK_ENTRY, createdAt: fresh() })
    const fn = stubRouterOk()
    const entry = await matchService('2011_09_26_drive_0093', { apikey: 'k', trace: TRACE })
    expect(entry.source).toBe('mock')
    expect(fn).not.toHaveBeenCalled()
  })

  it('mock 缓存过期（>24h）+ live 成功：重试 live → 返回 live 且缓存转正（自愈）', async () => {
    writeCache({ ...MOCK_ENTRY, createdAt: stale() })
    const fn = stubRouterOk()
    const entry = await matchService('2011_09_26_drive_0093', { apikey: 'k', trace: TRACE })
    expect(entry.source).toBe('live')
    expect(fn).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(localStorage.getItem(cacheKey('2011_09_26_drive_0093'))!)
    expect(stored.source).toBe('live')
  })

  it('mock 缓存过期 + live 仍失败：落回 fixture（自愈未达成，行为不退化）', async () => {
    writeCache({ ...MOCK_ENTRY, createdAt: stale() })
    const fixtureEntry = { ...MOCK_ENTRY, createdAt: fresh() }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        if (String(input).startsWith('https://router.hereapi.com')) {
          return { ok: false, status: 503, json: async () => ({}) } as Response
        }
        if (String(input).startsWith(`${BASE}fixtures/`)) {
          return { ok: true, status: 200, json: async () => fixtureEntry } as Response
        }
        throw new Error(`unexpected fetch: ${String(input)}`)
      }),
    )
    const entry = await matchService('2011_09_26_drive_0093', { apikey: 'k', trace: TRACE })
    expect(entry.source).toBe('mock')
  })

  it('mock 缓存 createdAt 非法：视为过期重试 live', async () => {
    writeCache({ ...MOCK_ENTRY, createdAt: 'not-a-date' })
    stubRouterOk()
    const entry = await matchService('2011_09_26_drive_0093', { apikey: 'k', trace: TRACE })
    expect(entry.source).toBe('live')
  })

  it('live 缓存无论多久远都直接命中（TTL 只管 mock 源；你确认的语义：live 一次成功永久 LIVE）', async () => {
    writeCache({ driveId: '2011_09_26_drive_0093', source: 'live', createdAt: stale(), response: LIVE_RESPONSE as never, derived: [] })
    const fn = stubRouterOk()
    const entry = await matchService('2011_09_26_drive_0093', { apikey: 'k', trace: TRACE })
    expect(entry.source).toBe('live')
    expect(fn).not.toHaveBeenCalled()
  })
})
