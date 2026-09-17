import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CacheEntry } from '../types'
// 测试代码豁免静态 import public/（src 运行时路径禁止，见 Global Constraints）
import f0093 from '../../public/fixtures/2011_09_26_drive_0093.json'
import fixture0093Fixture from '../../public/fixtures/2011_09_26_drive_0093.json'
import { cacheKey, loadFixture, matchService, readCache, writeCache } from './fixtureStore'

const entry0093 = f0093 as unknown as CacheEntry

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
    expect(fetchMock).toHaveBeenCalledWith('/fixtures/2011_09_26_drive_0093.json')
  })
  it('non-200 throws `fixture load failed: <driveId>`', async () => {
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
    writeCache(entry0093)
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
    expect(fetchMock).toHaveBeenCalledWith('/fixtures/2011_09_26_drive_0093.json')
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
        if (String(input).startsWith('/fixtures/')) {
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
