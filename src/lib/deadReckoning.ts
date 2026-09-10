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
 *  反映实际运动而非多普勒测速。三档回退（Step5 修正，原实现两支都退 lastGoodSpeed）：
 *    · 位移可用（0.5–20 m/s 且方向与 IMU 航向一致）→ 用位移速度
 *    · 位移 ≈ 0（冻结流 / 隧道 / 停车）→ 用当前 speedMps（IMU 轮速），负数视为静止
 *    · 位移越界或方向不符（多径毛刺）→ 沿用上一帧合理速度 */
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
        } else if (dispSpeed <= 0.5) {
          // GNSS 冻结（位移 ≈ 0：失锁期冻结流 / 隧道 / 停车）→ 回退「当前」IMU 轮速——
          // 惯导知道车在走，也可能知道车停了。用 lastGoodSpeed 会让 0106 全程失锁原地不动。
          speed = Math.max(0, trace[k].speedMps)
        } else {
          // GNSS 跳变（位移 >20 m/s）或方向不符（>45°，多径毛刺）→ 沿用上一帧合理速度
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
    // 历元可信 = 卫星够多 **且** 接收机确实有定位解。后者不能省：仿真隧道里（0042 高速段）
    // 卫星数照样 8+，只看 numsats 会让更新把 DR 拽回隧道口，隧道永远漂不起来（V10 是活文档）。
    // 无 noFix 字段的既有轨迹该条件恒真 → 行为逐位不变（0093 py-sync 0.000008m 即证）。
    if (k % 10 === 0 && trace[k].numsats > thr && !trace[k].noFix) {
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
