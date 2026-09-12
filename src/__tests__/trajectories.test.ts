import { describe, expect, it } from 'vitest'
import d0093 from '../../public/sample/here/2011_09_26_drive_0093.json'
import d0096 from '../../public/sample/here/2011_09_26_drive_0096.json'
import d0106 from '../../public/sample/here/2011_09_26_drive_0106.json'
import d0042 from '../../public/sample/here/2011_10_03_drive_0042.json'

interface TrajPoint {
  lat: number
  lng: number
  timestamp: number
  timestampUtc: string
  headingDeg: number
  speedMps: number
  numsats: number
  posmode?: number // Step5 起退化样本携带；既有三条无此列（见下方 posmode 契约）
}

const REQUIRED_FIELDS = [
  'lat', 'lng', 'timestamp', 'timestampUtc', 'headingDeg', 'speedMps', 'numsats',
] as const

// Karlsruhe 城区包围盒（宽于实测范围，仅拦截 swapped-coord / 截断 / 错文件类损坏）
const KA_BOX = { latMin: 48.95, latMax: 49.05, lngMin: 8.40, lngMax: 8.50 }

describe('bundled demo trajectories (contract)', () => {
  it.each([
    ['2011_09_26_drive_0093', d0093 as unknown as TrajPoint[], 433, -12],
    ['2011_09_26_drive_0096', d0096 as unknown as TrajPoint[], 475, -0.1], // 实测 min 0.329
    ['2011_09_26_drive_0106', d0106 as unknown as TrajPoint[], 227, -0.2], // 起步静止段噪声，实测 min −0.081
    ['2011_10_03_drive_0042', d0042 as unknown as TrajPoint[], 1170, -0.1], // 仿真隧道宿主，实测 min 9.35
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

  // Step5 退化样本：posmode === 0（接收机无定位解）= 失锁硬判据，比 numsats 干净
  // （36 个 drive 里只有 9 个出现过，0093 恰好 0 帧）。既有样本不得回填该列。
  it('posmode 失锁判据契约', () => {
    const staleCount = (pts: TrajPoint[]) => pts.filter((p) => p.posmode === 0).length
    expect(staleCount(d0096 as unknown as TrajPoint[])).toBe(333) // 70% 时长，最长连续 18.7s
    expect(staleCount(d0106 as unknown as TrajPoint[])).toBe(227) // 全程无定位解
    // 0042：真实的**间歇性**掉点（t=10.8–12.2s 段 1.5s + 48.9/74.5/102.5s 各 0.5s + 末尾 3s），
    // 不是连续长失锁——仿真隧道是另外叠加的（见 gnssFeed 的 tunnelDurationS）
    expect(staleCount(d0042 as unknown as TrajPoint[])).toBe(60)
    expect((d0093 as unknown as TrajPoint[]).every((p) => p.posmode === undefined)).toBe(true)
  })
})
