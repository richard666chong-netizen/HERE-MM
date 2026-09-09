import { describe, expect, it } from 'vitest'
import d0011 from '../../public/sample/here/2011_09_26_drive_0011.json'
import d0033 from '../../public/sample/here/2011_09_30_drive_0033.json'
import d0093 from '../../public/sample/here/2011_09_26_drive_0093.json'

interface TrajPoint {
  lat: number
  lng: number
  timestamp: number
  timestampUtc: string
  headingDeg: number
  speedMps: number
  numsats: number
}

const REQUIRED_FIELDS = [
  'lat', 'lng', 'timestamp', 'timestampUtc', 'headingDeg', 'speedMps', 'numsats',
] as const

// Karlsruhe 城区包围盒（宽于实测范围，仅拦截 swapped-coord / 截断 / 错文件类损坏）
const KA_BOX = { latMin: 48.95, latMax: 49.05, lngMin: 8.40, lngMax: 8.50 }

describe('bundled demo trajectories (contract)', () => {
  it.each([
    ['2011_09_26_drive_0011', d0011 as unknown as TrajPoint[], 233, -0.1],
    ['2011_09_30_drive_0033', d0033 as unknown as TrajPoint[], 1594, -0.1],
    ['2011_09_26_drive_0093', d0093 as unknown as TrajPoint[], 433, -12],
  ])('%s', (_driveId, pts, expectedCount, minSpeedMps) => {
    expect(pts).toHaveLength(expectedCount)
    for (const p of pts) {
      for (const f of REQUIRED_FIELDS) expect(p).toHaveProperty(f)
      expect(p.lat).toBeGreaterThanOrEqual(KA_BOX.latMin)
      expect(p.lat).toBeLessThanOrEqual(KA_BOX.latMax)
      expect(p.lng).toBeGreaterThanOrEqual(KA_BOX.lngMin)
      expect(p.lng).toBeLessThanOrEqual(KA_BOX.lngMax)
      expect(Number.isFinite(p.headingDeg)).toBe(true)
      // KITTI 静止段 GPS 测速噪声可到 -0.03 m/s（实测最小 -0.03），容许 -0.1 以内的抖动；
      // 0093 低星重收敛期有 32 点真实速度毛刺（最低 -11.08 m/s），下限按行参数化（该行传 -12）；
      // 仍拦截真正损坏（错文件 / 字段错位导致的异常速度）
      expect(p.speedMps).toBeGreaterThanOrEqual(minSpeedMps)
    }
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].timestamp).toBeGreaterThan(pts[i - 1].timestamp)
    }
  })
})
