import type { DerivedPoint, TrajPoint } from '../types'

export interface MarkerPopupData {
  title: string
  lines: Array<[string, string]>
}

export type MarkerType = 'gnss' | 'dr' | 'mm'

export function getMarkerPopup(
  type: MarkerType,
  index: number,
  trace: TrajPoint[],
  gnssDots: TrajPoint[],
  drPath: Array<[number, number]> | undefined,
  derived: DerivedPoint[],
): MarkerPopupData | null {
  if (type === 'gnss') {
    const p = gnssDots[index]
    if (!p) return null
    const fixStatus = p.noFix || p.posmode === 0
      ? 'No Fix'
      : p.numsats >= 5
        ? '3D Fix'
        : 'Degraded'
    return {
      title: `GNSS #${index}`,
      lines: [
        ['经度', `${p.lng.toFixed(6)}°`],
        ['纬度', `${p.lat.toFixed(6)}°`],
        ['航向', `${p.headingDeg.toFixed(2)}°`],
        ['速度', `${p.speedMps.toFixed(2)} m/s`],
        ['FIX', `${fixStatus} (${p.numsats} sats)`],
        ['DOP', 'N/A'],
        ['时间', `${p.timestamp.toFixed(1)}s`],
      ],
    }
  }

  if (type === 'dr') {
    if (!drPath || !drPath[index]) return null
    const t = trace[index]
    return {
      title: `DR #${index}`,
      lines: [
        ['经度', `${drPath[index][1].toFixed(6)}°`],
        ['纬度', `${drPath[index][0].toFixed(6)}°`],
        ['航向', t ? `${t.headingDeg.toFixed(2)}°` : 'N/A'],
        ['速度', t ? `${t.speedMps.toFixed(2)} m/s` : 'N/A'],
        ['时间', t ? `${t.timestamp.toFixed(1)}s` : 'N/A'],
      ],
    }
  }

  const d = derived[index]
  if (!d) return null
  return {
    title: `MM #${index}`,
    lines: [
      ['经度', `${d.matchedLatLng[1].toFixed(6)}°`],
      ['纬度', `${d.matchedLatLng[0].toFixed(6)}°`],
      ['Link ID', d.linkId ?? 'N/A'],
      ['匹路状态', d.deviationM > 10 ? 'Off Road' : 'On Road'],
      ['航向', `${d.headingDeg.toFixed(2)}°`],
      ['偏差', `${d.deviationM.toFixed(2)} m`],
      ['时间', trace[index] ? `${trace[index].timestamp.toFixed(1)}s` : 'N/A'],
    ],
  }
}
