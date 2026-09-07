import { describe, expect, it } from 'vitest'
import type { ImportResponse } from '../types'

// 测试代码豁免静态 import public/（src 运行时路径禁止，见 Global Constraints）
import f0011 from '../../public/fixtures/2011_09_26_drive_0011.json'
import f0033 from '../../public/fixtures/2011_09_30_drive_0033.json'

function checkFixture(f: unknown, driveId: string, minSections: number, minRouteLenM: number) {
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
    expect(s.polyline.length).toBeGreaterThan(20)
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
})
