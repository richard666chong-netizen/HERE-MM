import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import StatsPanel from '../components/StatsPanel'
import { deviationStats } from '../lib/stats'
import type { DerivedPoint, TrajPoint } from '../types'

// 10Hz、100 帧；deviationM = (i%10)+1 周期模式（切片间均值必不同）；driftM = i/10（前缀最大可预测）
const N = 100
const trace: TrajPoint[] = Array.from({ length: N }, (_, i) => ({
  lat: 49, lng: 8.4 + i * 0.00001, timestamp: i / 10, timestampUtc: '', headingDeg: 90, speedMps: 1, numsats: 8,
}))
const derived: DerivedPoint[] = Array.from({ length: N }, (_, i) => ({
  i, matchedLatLng: [49, 8.4] as [number, number], deviationM: (i % 10) + 1, headingDeg: 90, speedMps: 1, linkId: `s${i}`,
}))
const driftM = Array.from({ length: N }, (_, i) => i / 10)

function expectChip(label: string, v: number): void {
  const chip = screen.getByText(label).closest('[data-testid="stat-chip"]')!
  expect(chip.textContent).toContain(`${v.toFixed(2)} m`)
}

describe('StatsPanel 双态（HTML renderStatsPanel 移植）', () => {
  it('全量态（无 upToIndex）：无红字读数，chips=全量统计，DR Max Drift 始终渲染', () => {
    render(<StatsPanel trace={trace} derived={derived} driftM={driftM} />)
    expect(screen.queryByTestId('current-deviation')).toBeNull()
    const stats = deviationStats(derived)
    expectChip('Mean Deviation', stats.meanM)
    expectChip('P95 Deviation', stats.p95M)
    expectChip('Max Deviation', stats.maxM)
    expectChip('DR Max Drift', 9.9) // max(driftM) = 99/10
    expect(screen.getAllByTestId('hist-bar')).toHaveLength(20)
  })

  it('切片态（upToIndex=54）：红字读数在，chips=0.5s 量化帧的切片统计（非第 54 帧）', () => {
    render(<StatsPanel trace={trace} derived={derived} driftM={driftM} upToIndex={54} />)
    expect(screen.getByTestId('current-deviation').textContent).toContain('5.00 m') // (54%10)+1，读数全速
    // t=5.4 → tQ=5.0 → eff=50：slice(0,51)，若错用 55 帧则 mean 5.41≠5.27、drift 5.4≠5.0
    const q = deviationStats(derived.slice(0, 51))
    expectChip('Mean Deviation', q.meanM)
    expectChip('DR Max Drift', 5.0) // max(driftM[0..50])
  })

  it('端点免量化（upToIndex=99）：chips 精确等于全量统计', () => {
    render(<StatsPanel trace={trace} derived={derived} driftM={driftM} upToIndex={99} />)
    const stats = deviationStats(derived)
    expectChip('Mean Deviation', stats.meanM)
    expectChip('Max Deviation', stats.maxM)
    expectChip('DR Max Drift', 9.9)
  })

  it('空数据：No deviation data 占位', () => {
    render(<StatsPanel trace={[]} derived={[]} driftM={[]} />)
    expect(screen.getByText('No deviation data')).toBeTruthy()
  })
})
