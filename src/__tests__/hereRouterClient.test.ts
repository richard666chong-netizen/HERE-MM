import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildImportRequest, importRoute } from '../lib/hereRouterClient'
import type { TrajPoint } from '../types'

// 测试代码豁免静态 import public/；polyline 必须取真实 fixture 的可解码串——
// 合成串会被 decodeFlexiblePolyline 拒收（评审 blocker 修正：App 的 derive 链会解码它）
import fixture0093 from '../../public/fixtures/2011_09_26_drive_0093.json'

function tp(i: number): TrajPoint {
  return { lat: 49 + i * 1e-4, lng: 8.4 + i * 1e-4, timestamp: i, timestampUtc: '', headingDeg: 0, speedMps: 0, numsats: 7 }
}

const REAL_POLYLINE = (fixture0093 as unknown as { response: { routes: { sections: { polyline: string }[] }[] } })
  .response.routes[0].sections[0].polyline

const OK_RESPONSE = {
  routes: [
    {
      id: 'route-1',
      sections: [
        { id: 's1', type: 'vehicle', polyline: REAL_POLYLINE, summary: { duration: 60, length: 500 } },
      ],
    },
  ],
  notices: [],
}

function jsonResponse(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response
}

describe('buildImportRequest', () => {
  it('small trace passes through rounded to 6 decimals', () => {
    const req = buildImportRequest([tp(0), tp(1)])
    expect(req).toEqual([
      { lat: 49, lng: 8.4 },
      { lat: expect.closeTo(49.0001, 8), lng: expect.closeTo(8.4001, 8) },
    ])
  })
  it('long trace downsamples to <=500 points, keeps first and last', () => {
    const trace = Array.from({ length: 1594 }, (_, i) => tp(i))
    const req = buildImportRequest(trace)
    expect(req.length).toBeLessThanOrEqual(500)
    expect(req.length).toBe(400) // stride = ceil(1594/500) = 4 → 0,4,…,1592 (399 点) + 末点 1593
    expect(req[0]!.lat).toBeCloseTo(49, 6)
    expect(req[req.length - 1]!.lng).toBeCloseTo(8.4 + 1593 * 1e-4, 6)
  })
})

describe('importRoute', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        void input
        void init
        return jsonResponse(OK_RESPONSE)
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs to v8/import with query params and downsampled trace body', async () => {
    await importRoute('test-key', [tp(0), tp(1), tp(2)])
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe(
      'https://router.hereapi.com/v8/import?return=polyline,summary&transportMode=car&apikey=test-key',
    )
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ trace: buildImportRequest([tp(0), tp(1), tp(2)]) })
  })

  it('returns validated response', async () => {
    await expect(importRoute('k', [tp(0)])).resolves.toEqual(OK_RESPONSE)
  })

  it('throws on HTTP error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => jsonResponse({ error: 'x' }, 429)),
    )
    await expect(importRoute('k', [tp(0)])).rejects.toThrow('here import failed: HTTP 429')
  })

  it('throws on structurally invalid response', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => jsonResponse({ routes: [] })))
    await expect(importRoute('k', [tp(0)])).rejects.toThrow('here import failed: invalid response')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => jsonResponse({ routes: [{ id: 'r', sections: [{ id: 's', polyline: '', summary: { duration: 1, length: 1 } }] }] })),
    )
    await expect(importRoute('k', [tp(0)])).rejects.toThrow('here import failed: invalid response')
  })
})
