import type { TrajPoint } from '../types'

/** 仿真隧道起点 = 轨迹总时长的 30%。钉死常量——UI、录制脚本、测试均引用它，不得各自硬编码。
 *  取值依据（实测）：0042 @60s 从此处起拒止得横向漂移 59m 且出隧道仍留 22s 纠回镜头；
 *  提前到 25% 会让 120s 窗口顶到轨迹尾、失去纠回段。 */
export const TUNNEL_START_FRACTION = 0.3

export interface GnssFeedOptions {
  /** 仿真隧道：GNSS 拒止时长（秒）。缺省/0 = 只用真实失锁（posmode === 0）。
   *  超出轨迹尾部则截断（不报错）——这是**场景参数**，不是数据。 */
  tunnelDurationS?: number
}

/** 退化 GNSS 流：接收机 posmode === 0（无定位解）时报的是「无新解」，实测表现为位置停在最后一帧有效定位。
 *
 *  为什么需要这一层：KITTI oxts 的 lat/lng 在失锁期是 INS 桥接解——它约等于真值，但**不是 GNSS**。
 *  直接把它当 GNSS 喂 DR，DR 只会复读真值（实测 0096 全程偏离 2.51m、0106 仅 0.99m），
 *  既看不出 DR 价值也量化不了精度。把「真值」与「接收机实际给出的 GNSS」分开之后，
 *  DR 才真的在失锁期自由递推，误差可对着可信真值（pos_accuracy ≤1.8m）量。
 *
 *  Step6 增仿真隧道：失锁来源有两个——真实的 `posmode === 0`，以及**场景参数**指定的拒止窗口。
 *  轨迹/航向/速度/加速度全部真数据，只有「拒止多久」是设定值（这正是隧道的物理定义）。
 *
 *  - 失锁帧：`lat/lng` 冻结为失锁前最后一帧有效定位，并置 `noFix: true`（渲染层据此不画散点）
 *  - 帧 0 无条件播种（与 deadReckon 的初始化规则一致）
 *  - 只改 lat/lng + noFix：headingDeg/speedMps/numsats 逐帧透传——失锁期的速度源就在这里
 *  - 无 posmode 列且隧道关闭（0093）→ 原引用返回，零回归
 */
export function buildGnssFeed(trace: TrajPoint[], opts?: GnssFeedOptions): TrajPoint[] {
  if (trace.length === 0) return trace
  const dur = opts?.tunnelDurationS ?? 0
  if (dur <= 0 && !trace.some((p) => p.posmode !== undefined)) return trace

  const totalS = trace[trace.length - 1].timestamp
  const tunnelStart = TUNNEL_START_FRACTION * totalS
  // 窗口覆盖到轨迹尾时用 +∞ 作开区间上界：半开区间 [start, totalS) 会把末帧漏掉，
  // 而「截断」的语义是「一直拒止到录制结束」（G8 抓到过这个 off-by-one）
  const tunnelEnd = tunnelStart + dur >= totalS ? Infinity : tunnelStart + dur

  let last: [number, number] = [trace[0].lat, trace[0].lng]
  return trace.map((p) => {
    const stale =
      p.posmode === 0 || (dur > 0 && p.timestamp >= tunnelStart && p.timestamp < tunnelEnd)
    if (!stale) {
      last = [p.lat, p.lng]
      return p
    }
    return { ...p, lat: last[0], lng: last[1], noFix: true }
  })
}
