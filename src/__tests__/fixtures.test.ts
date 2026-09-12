import { describe, expect, it } from 'vitest'
import type { ImportResponse } from '../types'

// 测试代码豁免静态 import public/（src 运行时路径禁止，见 Global Constraints）
import f0093 from '../../public/fixtures/2011_09_26_drive_0093.json'
import f0096 from '../../public/fixtures/2011_09_26_drive_0096.json'
import f0106 from '../../public/fixtures/2011_09_26_drive_0106.json'
import f0042 from '../../public/fixtures/2011_10_03_drive_0042.json'

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
  it('2011_09_26_drive_0093: 4 sections, >=250m total (split route)', () => {
    // minRouteLenM 是逐段下限，拆分路由含 4m 短段故传 1；总里程单独断言（实测 292m）
    checkFixture(f0093, '2011_09_26_drive_0093', 4, 1, 10)
    const secs = (f0093 as unknown as { response: ImportResponse }).response.routes[0].sections
    expect(secs.reduce((a, s) => a + s.summary.length, 0)).toBeGreaterThanOrEqual(250)
  })

  // Step5：两条可信用真值的退化轨迹，fixture 由 scripts/record-fixtures-dr.ts 按 App live 路径
  // 同一条变换链录制（buildGnssFeed → deadReckon → buildImportRequest），故离线=在线。
  it('2011_09_26_drive_0096: 1 section, >=380m route (失锁 35s，DR 增强后仍连续)', () => {
    checkFixture(f0096, '2011_09_26_drive_0096', 1, 380) // 实录 402m
  })
  it('2011_09_26_drive_0106: 1 section, >=100m route (全程无定位解，DR 自由递推成路)', () => {
    checkFixture(f0106, '2011_09_26_drive_0106', 1, 100) // 实录 110m
  })

  // Step6 仿真隧道宿主：**30s** 隧道录制（DR 横向漂 11m，HERE 仍绑对主路：1 段 2594m vs 真值 2590m，
  // 真值→匹配路线 mean 1.19 / max 6.10m）。不用 60s：那时 DR 横向漂 59m 超出车道间距量级，
  // HERE 会跟着漂移匹配到旁路（2 段 2431m，max 49.85m）——那是「MM 能力边界」话术，不是主演示。
  it('2011_10_03_drive_0042: 1 section, >=2500m route (仿真隧道 30s，DR 增强后绑对主路)', () => {
    checkFixture(f0042, '2011_10_03_drive_0042', 1, 2500) // 实录 2594m
  })
})
