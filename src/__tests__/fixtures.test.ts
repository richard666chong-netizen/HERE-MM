import { describe, expect, it } from 'vitest'
import type { ImportResponse } from '../types'

// 测试代码豁免静态 import public/（src 运行时路径禁止，见 Global Constraints）
import f0011 from '../../public/fixtures/2011_09_26_drive_0011.json'
import f0033 from '../../public/fixtures/2011_09_30_drive_0033.json'
import f0093 from '../../public/fixtures/2011_09_26_drive_0093.json'

// minPolylineChars：逐段 polyline 字符下限，默认 20；0093 是 importSplitRoute 拆分路由，
// 4m/35m 短段合法地只含 2 个点（17/20 字符），传 10 仍可拦截空 / 乱码 polyline
function checkFixture(f: unknown, driveId: string, minSections: number, minRouteLenM: number, minPolylineChars = 20) {
  const e = f as { driveId: string; source: string; createdAt: string; response: ImportResponse; derived: unknown[] }
  expect(e.driveId).toBe(driveId)
  expect(e.source).toBe('mock')
  expect(typeof e.createdAt).toBe('string')
  expect(Array.isArray(e.derived)).toBe(true)
  const secs = e.response.routes[0].sections
  expect(secs.length).toBeGreaterThanOrEqual(minSections)
  for (const s of secs) {
    expect(typeof s.id).toBe('string')
    expect(typeof s.polyline).toBe('string')
    expect(s.polyline.length).toBeGreaterThan(minPolylineChars)
    expect(typeof s.summary.duration).toBe('number')
    expect(typeof s.summary.length).toBe('number')
    expect(s.summary.length).toBeGreaterThanOrEqual(minRouteLenM)
  }
}

describe('bundled match fixtures (contract, v8/import schema)', () => {
  it('2011_09_26_drive_0011: 1 section, >=100m route', () => {
    checkFixture(f0011, '2011_09_26_drive_0011', 1, 100)
  })
  it('2011_09_30_drive_0033: 1 section, >=1500m route', () => {
    checkFixture(f0033, '2011_09_30_drive_0033', 1, 1500)
  })
  it('2011_09_26_drive_0093: 4 sections, >=250m total (split route)', () => {
    // minRouteLenM 是逐段下限，拆分路由含 4m 短段故传 1；总里程单独断言（实测 292m）
    checkFixture(f0093, '2011_09_26_drive_0093', 4, 1, 10)
    const secs = (f0093 as unknown as { response: ImportResponse }).response.routes[0].sections
    expect(secs.reduce((a, s) => a + s.summary.length, 0)).toBeGreaterThanOrEqual(250)
  })
})
