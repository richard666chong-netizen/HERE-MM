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
 *  帧 0 无条件以 GNSS 播种（不论卫星数）——前导失锁段即从帧 0 纯递推，全程无可信历元 = 全程纯递推。
 *
 *  速度来源（Step4 T4 修正）：GPS 多普勒速度（speedMps）在低卫星数时系统性偏低甚至负值，
 *  导致 DR 累积漂移。改用 GNSS 位移速度（|GNSS[k]−GNSS[k−1]|/dt）作为主速度源——
 *  反映实际运动而非多普勒测速。GNSS 冻结（位移≈0，如隧道）时回退 speedMps（惯导知道车在走）；
 *  GNSS 跳变（位移>50m/frame，如多径毛刺）时用上一帧合理速度。 */
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
  let lastGoodSpeed = Math.max(0, trace[0].speedMps)
  for (let k = 0; k < trace.length; k++) {
    if (k > 0) {
      const dt = trace[k].timestamp - trace[k - 1].timestamp
      // 速度估计：优先 GNSS 位移速度（反映真实运动），冻结/跳变/方向不符时回退
      let speed: number
      if (dt > 0) {
        const dLatM = (trace[k].lat - trace[k - 1].lat) * M_PER_DEG_LAT
        const dLngM = (trace[k].lng - trace[k - 1].lng) * M_PER_DEG_LAT * Math.cos(trace[k].lat * DEG)
        const dispSpeed = Math.sqrt(dLatM * dLatM + dLngM * dLngM) / dt
        // 方向一致性检查：GNSS 位移方向 vs IMU 航向。偏差 >45° = 多径跳变，不可信
        const dispCompass = (Math.atan2(dLngM, dLatM) * 180 / Math.PI + 360) % 360
        const imuCompass = yawToCompassDeg(trace[k].headingDeg)
        let dirDiff = Math.abs(dispCompass - imuCompass) % 360
        if (dirDiff > 180) dirDiff = 360 - dirDiff
        if (dispSpeed > 0.5 && dispSpeed < 20 && dirDiff < 45) {
          speed = dispSpeed
          lastGoodSpeed = speed
        } else {
          speed = lastGoodSpeed
        }
      } else {
        speed = lastGoodSpeed
      }
      const c = yawToCompassDeg(trace[k].headingDeg) * DEG
      const step = speed * dt
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
