import type { TrajPoint } from '../types'
import { haversineM, yawToCompassDeg } from './geo'

const DEG = Math.PI / 180
const M_PER_DEG_LAT = 111320

/** 逐点失锁标记（numsats ≤ satThreshold），与 trace 严格对齐。语义 = 叙事门控（隧道级失锁），与更新门控解耦。 */
export function detectOutages(trace: TrajPoint[], satThreshold = 4): boolean[] {
  return trace.map((p) => p.numsats <= satThreshold)
}

export interface DrResult {
  positions: Array<[number, number]> // [lat, lng]
  corrected: boolean[] // 历元（i%10===0）且可信（更新门控通过）→ true
  innovations: number[] // 更新前 |p_gnss − p|（米）；非纠正帧 = 0
}

/** 多速率航位推算：10Hz 惯性递推 + 1Hz GNSS 纠正（历元 = i%10===0，含帧 0）。
 *  帧 0 无条件以 GNSS 播种（不论卫星数）——前导失锁段即从帧 0 纯递推，全程无可信历元 = 全程纯递推。 */
export function deadReckon(
  trace: TrajPoint[],
  opts?: { gain?: number; updateThreshold?: number },
): DrResult {
  const gain = opts?.gain ?? 0.3
  const thr = opts?.updateThreshold ?? 6
  const positions: Array<[number, number]> = []
  const corrected: boolean[] = []
  const innovations: number[] = []
  if (trace.length === 0) return { positions, corrected, innovations }
  let p: [number, number] = [trace[0].lat, trace[0].lng]
  for (let k = 0; k < trace.length; k++) {
    if (k > 0) {
      // 10Hz 预测：v_k·dt_k，方向 = 本帧罗盘航向；dLat = v·dt·cos/111320，dLng = v·dt·sin/(111320·cos(lat))
      const dt = trace[k].timestamp - trace[k - 1].timestamp
      const c = yawToCompassDeg(trace[k].headingDeg) * DEG
      const step = trace[k].speedMps * dt
      p = [
        p[0] + (step * Math.cos(c)) / M_PER_DEG_LAT,
        p[1] + (step * Math.sin(c)) / (M_PER_DEG_LAT * Math.cos(p[0] * DEG)),
      ]
    }
    if (k % 10 === 0 && trace[k].numsats > thr) {
      innovations[k] = haversineM([trace[k].lat, trace[k].lng], p)
      p = [p[0] + gain * (trace[k].lat - p[0]), p[1] + gain * (trace[k].lng - p[1])]
      corrected[k] = true
    } else {
      innovations[k] = 0
      corrected[k] = false
    }
    positions[k] = [p[0], p[1]]
  }
  return { positions, corrected, innovations }
}
