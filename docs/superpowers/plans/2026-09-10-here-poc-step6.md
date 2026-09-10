# HERE Map Matching POC — Step6 实施计划（仿真隧道）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付「GNSS 拒止时长可调的仿真隧道」：宿主轨迹 `2011_10_03_drive_0042` 入库；失锁期橙色散点消失、DR 可见横向漂移（60s → 59m）、出隧道被 1Hz 更新纠回、HERE 匹配路线全程绑在高速路网；并把散点口径从「原始 OXTS」修正为「接收机实际报的 GNSS」。

**Architecture:** `buildGnssFeed` 增隧道窗口（纯函数，复用既有冻结机制）→ 失锁帧打 `noFix` → `deadReckon` 门控识别 `noFix`（现有 `numsats > thr` 在仿真隧道下失效，因为卫星数照样高）→ `MapView/SvgFallback` 从 `gnssPath` 画散点并跳过 `noFix` 帧 → App 增隧道时长旋钮与 DR 漂移读数。

**Tech Stack:** 现有地基，零新增 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-09-10-tunnel-scenario-design.md`（本计划的唯一需求来源）

**前置状态：** Step5 的改动（`gnssFeed` / `deadReckoning` 速度回退修复 / 0096+0106 入库 / 基本探测）**尚未提交**，仍在工作区。Step6 在其之上叠加，不入新分支。

## Global Constraints

- 零新增 npm 依赖；strict TS + `verbatimModuleSyntax`；测试显式 import from 'vitest'
- **钉死规则（跨实现必须逐条一致，防复刻漂移）**：
  - `TUNNEL_START_FRACTION = 0.3`；窗口 = `[0.3·T, min(0.3·T + D, T))`；D 缺省/0 = 只用真实失锁
  - 失锁帧判定 = `posmode === 0 || t ∈ 窗口`；失锁帧 `lat/lng` 冻结为**窗口前最后一帧有效定位**且置 `noFix: true`
  - 帧 0 无条件播种（沿用 Step4 语义）
  - 1Hz 更新门控 = `k % 10 === 0 && numsats > updateThreshold && !trace[k].noFix`
- **零回归分轨迹**（详见 spec）：0011/0033/0093 无 `posmode` → 逐位不变；0096/0106 **仅散点口径改变**（这是设计意图）；默认隧道关闭 → 旋钮不影响任何既有轨迹
- 0093 的 py-artifact 同步测试（≤0.1m）**必须全程继续绿**——它是"没碰坏既有 DR 数学"的唯一硬证据
- 隧道是**场景参数**，UI 必须显示"仿真"字样；轨迹/航向/速度/加速度全部真数据，**不做噪声注入**

## 现状（已核实，2026-09-10）

- **全量扫描结论**：156 条 KITTI raw drive 全部下载并扫描（`data/kitti/`），有 ≥12s 失锁的仅 6 条，最长 **34.3s**（0096）；**无隧道**
- **相机帧肉眼验证**（`data/fetch_kitti_frames.py`，Range 请求直取 image_00）：0106 = 城市峡谷（卡城中心高楼）、0096 = 林荫道树冠、0071 = 市中心步行街、0042 = 高速公路
- **漂移分解**（真实 `deadReckon` 实测）：0106 的 4.39m 几乎全是**沿轨**误差（横向仅 **0.9m**）——真实城市峡谷数据"MM 无事可做"
- **0042 实测**：1170 帧 / 116.9s / 2.59km / 均速 79.6km/h / 真值 accMax 0.9m / 在 KA_BOX 内 / `speedMps` 最低 9.35（下限 -0.1 安全）
- **0042 真实掉点**：`posmode==0` 共 60 帧（t=10.8–12.2s 一段 1.5s、48.9/74.5/102.5s 各 0.5s、末尾 3s），其中 10 帧落在仿真窗口内
- **隧道漂移实测（60s @30%）**：窗口 1328m、**横向漂移 max 59m**、出口 58.5m、出隧道余量 22s
- **时长取舍实测**：30s→11m（余 40s）｜60s→**59m**（余 22s）｜120s→74m（**余 0s**，窗口顶到轨迹尾，无纠回镜头）
- 对照候选实测横向漂移（60s）：0018 = 9m、0033 = 18m、0034 = 14m、0047 = 12m —— 0042 是次优的 3 倍且点数更少

## File Structure

```
src/
├── lib/
│   ├── gnssFeed.ts              # T1: 隧道窗口 + noFix 标记
│   └── deadReckoning.ts         # T2: 门控识别 noFix
├── components/
│   ├── MapView.tsx              # T3: gnssPath prop + 散点跳过 noFix + bbox
│   ├── SvgFallback.tsx          # T3: 同上（SVG 路径）
│   └── StatsPanel.tsx           # T4: DR 漂移读数
├── App.tsx                      # T3/T4: gnssPath 接线 + 隧道旋钮
├── types.ts                     # T1: TrajPoint.noFix?: boolean
└── __tests__/
    ├── gnssFeed.test.ts         # T1
    ├── deadReckoning.test.ts    # T2 + T7
    ├── mapview.test.tsx         # T3
    ├── app.test.tsx             # T4
    ├── trajectories.test.ts     # T5
    └── fixtures.test.ts         # T6
public/
├── sample/here/2011_10_03_drive_0042.json   # T5
└── fixtures/2011_10_03_drive_0042.json      # T6
scripts/record-fixtures-dr.ts                # T6: 增 --tunnel
```

---

### Task 1: gnssFeed 隧道窗口 + noFix 标记

**Files:**
- Modify: `src/lib/gnssFeed.ts`、`src/types.ts`
- Test: `src/__tests__/gnssFeed.test.ts`

**Interfaces:**
- Consumes: `TrajPoint`
- Produces:
  - `buildGnssFeed(trace: TrajPoint[], opts?: { tunnelDurationS?: number }): TrajPoint[]`
  - `TrajPoint.noFix?: boolean`（"该帧接收机无定位解"）
- 既有行为不变：无 `posmode` 列的轨迹**返回原引用**（`toBe` 断言，Step5 已锁定）

- [ ] **Step 1: 先写失败测试**（G6–G10）：
  - G6 窗口内冻结：`tunnelDurationS` 给定 + 合成 trace（10Hz、60s）→ 窗口内逐帧 lat/lng = 窗口前最后一帧；窗口外 = 原值
  - G7 窗口起点 = 0.3·T：断言窗口第一帧下标 = `30 * T / 10`（10Hz）
  - G8 超尾截断：`D` 大于剩余时长 → 不报错，冻结到轨迹末帧
  - G9 与真实失锁叠加：`posmode==0` 帧在窗口外也照样冻结；窗口内的 `posmode!=0` 帧也被冻结
  - G10 `noFix` 标记：窗口内与真实失锁帧 `noFix === true`，其余 `undefined`/`false`
- [ ] **Step 2: 跑红 →** `npx vitest run src/__tests__/gnssFeed.test.ts`
- [ ] **Step 3: 实现**（约 15 行改动）→ **Step 4: 跑绿（含既有 G1–G5）**
- [ ] **Step 5: Commit** `feat(gnssFeed): tunable GNSS-denial window with noFix flag`

---

### Task 2: deadReckon 门控识别 noFix

**Files:**
- Modify: `src/lib/deadReckoning.ts`
- Test: `src/__tests__/deadReckoning.test.ts`

**Interfaces:**
- Consumes: `TrajPoint.noFix`（T1）
- Produces: 更新门控 = `k % 10 === 0 && numsats > thr && !trace[k].noFix`
- 关键：无 `noFix` 字段的轨迹该条件恒真 → 既有行为逐位不变

- [ ] **Step 1: 先写失败测试**：
  - V9 **卫星很多但无解**：合成 trace，卫星恒 10 颗但第 20 帧起 `noFix: true` 且 GNSS 冻结 → 断言 `corrected[20]=false`、`corrected[30]=false`（旧实现会 true）、DR 继续递推（位移 = 帧数×dt×速度）
  - V10 **仿真隧道不漂移反证**：同 trace 去掉 `noFix` 标记 → DR 被 1Hz 更新拉回（分离 ≤1m）；加上 `noFix` → 分离 >10m。这条同时是"为什么必须改门控"的活文档
- [ ] **Step 2: 跑红 → Step 3: 实现（门控加一个条件）→ Step 4: 跑绿**
- [ ] **Step 5: 回归确认**：`[py-sync 0093] maxDev=0.000008m` 仍在输出中
- [ ] **Step 6: Commit** `fix(deadReckoning): trust noFix over satellite count in update gate`

---

### Task 3: 散点口径修正（gnssPath + 跳过 noFix）

**Files:**
- Modify: `src/components/SvgFallback.tsx`、`src/components/MapView.tsx`、`src/App.tsx`
- Test: `src/__tests__/mapview.test.tsx`

**Interfaces:**
- Produces:
  - `SvgFallback`/`MapView` 增可选 prop `gnssPath?: TrajPoint[]`（缺省 = `trace`，既有调用零改动）
  - 散点从 `gnssPath` 取点，**`noFix` 帧不产出 `gnss-dot`**
  - 画幅 bbox 的 `all` 数组并入 `gnssPath`（SvgFallback 的 geo memo 依赖 + MapView 的 setLookAtData bounds）
- 不变：车标走 `derived[carIndex]`；起终点标记走 `trace`；`derived`/`deviationM` 口径不动

- [ ] **Step 1: 先写失败测试**：
  - M1 `gnssPath` 含 `noFix` 帧 → `gnss-dot` 数量 = 非 `noFix` 帧的抽稀数；不传 `gnssPath` → 与现状一致（回归锚点）
  - M2 `gnssPath` 有 `noFix` 帧时 `matched-path`/`endpoint-marker` 仍在（不误删其他层）
- [ ] **Step 2: 跑红 → Step 3: 实现 → Step 4: 跑绿**
- [ ] **Step 5: App 接线**：`gnssPath={gnssFeed}`（隧道关闭时也应传——0096/0106 的真实失锁散点消失即由此生效）
- [ ] **Step 6: Commit** `fix(map): scatter reflects receiver-reported GNSS (noFix frames omitted)`

---

### Task 4: 隧道时长旋钮 + DR 漂移读数

**Files:**
- Modify: `src/App.tsx`、`src/components/StatsPanel.tsx`
- Test: `src/__tests__/app.test.tsx`

**Interfaces:**
- Produces:
  - App 状态 `tunnelS: 0 | 30 | 60 | 120`（默认 **0 = 关闭**）；`<select>` 与 `轨迹` 并列，带 `title` 标注"仿真：GNSS 拒止时长；轨迹与 IMU 数据为真实 KITTI"
  - `gnssFeed = useMemo(() => buildGnssFeed(trace, { tunnelDurationS: tunnelS || undefined }), [trace, tunnelS])`
  - DR 门控 = `detectOutages(trace, 4).some(Boolean) || gnssFeed.some((p) => p.noFix)`（**保留 `detectOutages` 一路** → 0093 的 DR 层不丢）
  - `StatsPanel` 增一行 **DR 漂移 `max|DR − 真值|`**（静态分析口径；回放图表本期不动）
- 离线约定：fixture 按 60s 录；旋钮在离线态只影响 DR 层与散点，蓝线"所录即所得"（`title` 标注）

- [ ] **Step 1: 先写失败测试**：
  - A1 隧道 = 60s 时 live 请求体 = `buildImportRequest(DR(buildGnssFeed(trace, {tunnelDurationS:60})))`，且 **≠** 隧道 = 关闭时的请求体（"旋钮没接线"的真证伪点）
  - A2 隧道 = 关闭时请求体 = Step5 的口径（回归锚点）
  - A3 0033：隧道 = 60s 时**请求体仍无变化**（无 `posmode` → feed 原样返回）——防"旋钮污染对照轨迹"
- [ ] **Step 2: 跑红 → Step 3: 实现 → Step 4: 跑绿（全套）**
- [ ] **Step 5: Commit** `feat(tunnel): tunable GNSS-denial knob + DR drift readout`

---

### Task 5: 0042 入库 + 契约测试

**Files:**
- Create: `public/sample/here/2011_10_03_drive_0042.json`
- Modify: `src/__tests__/trajectories.test.ts`

- [ ] **Step 1: 先写失败测试（红）**：`trajectories.test.ts` 导入 + `it.each` 增一行
      `['2011_10_03_drive_0042', d0042, 1170, -0.1]`（实测 `speedMps` 最低 9.35）；`posmode` 契约增
      `staleCount(d0042) === 60`
- [ ] **Step 2: 跑红**（文件不存在）→ **Step 3: 转换入库**：
      `python data/analyze_kitti.py`（幂等，已含 `posmode`）→
      `cp data/kitti/2011_10_03_drive_0042/trajectory_light.json public/sample/here/2011_10_03_drive_0042.json`
- [ ] **Step 4: 跑绿 → Step 5: Commit** `feat(data): onboard 2011_10_03_drive_0042 (highway, tunnel host)`

---

### Task 6: fixture 录制（--tunnel 60）+ 契约

**Files:**
- Modify: `scripts/record-fixtures-dr.ts`（增 `--tunnel <秒>`，缺省 60）、`src/__tests__/fixtures.test.ts`
- Create: `public/fixtures/2011_10_03_drive_0042.json`

**Interfaces:**
- Consumes: T1 的 `buildGnssFeed`（脚本已直接 import src 真实模块，无复刻漂移）
- Produces: 脚本的变换链变为 `buildGnssFeed(trace, {tunnelDurationS}) → deadReckon → buildImportRequest`，
  与 App live 路径**逐条一致**（离线=在线）

- [ ] **Step 1: 改脚本 + 跑录制**：
      `npm run record:dr -- 2011_10_03_drive_0042 --tunnel 60 --compare`
      预期：DR 增强 1 段 ~2.6km；对照（未增强的冻结流）应显著更差或无法成路——把两者的实测值记入本计划 Errata
- [ ] **Step 2: 先写失败测试**：`fixtures.test.ts` +1 条（段数/里程按实录值，先用 1 段 + ≥2000m 占位再按实录收紧）
- [ ] **Step 3: 跑绿（含既有 5 条 fixture 契约）→ Step 4: Commit**
      `feat(fixtures): record 0042 DR-augmented route (60s tunnel)`

---

### Task 7: DR 精度回归（0042 @60s）

**Files:**
- Modify: `src/__tests__/deadReckoning.test.ts`

**Interfaces:**
- Consumes: T1/T2 的产物
- Produces: 以 `nearestOnPolyline`（与渲染同源）度量**横向漂移**，锁住两个数：
  - 窗口内横向漂移 max（实测 **59m**，容差按实测收紧）
  - 出隧道后末帧横向漂移（实测趋于 **0m**）——证明 1Hz 更新确实纠回

- [ ] **Step 1: 先写测试并跑一次**（此时实现已在位 → 预期绿）。**必须做证伪实验**：临时移除 T2 的门控条件 → 断言转红；恢复 → 绿。把两次结果记入 Errata（"测试有鉴别力"的硬证据，沿用 Step5 的做法）
- [ ] **Step 2: Commit** `test(dr): lock 0042 tunnel lateral drift and recovery`

---

### Task 8: Step6 验收

- [ ] **Step 1: 全量绿**：`npm run test && npm run build`
- [ ] **Step 2: 手动验收（用户浏览器）**：
  - 选 0042 → 隧道 **关闭**：散点在 t=10.8–12.2s 等处短暂消失（真实掉点），无大漂移
  - 选 0042 → 隧道 **60s**：散点在 35.1–95.1s 段消失；紫线横向飘出高速达 ~59m；出隧道后紫线 10s 内贴回蓝线；蓝线全程贴路网
  - 0011 / 0033 / 0093：隧道关闭时与 Step5 渲染逐像素一致
  - 0096 / 0106：**仅散点在失锁期消失**，其余与 Step5 一致
  - 静态面板读数：DR 漂移 max ≈ 59m、deviationM 与既有量级一致
- [ ] **Step 3: 收尾**：Errata 补记（录制实录、证伪实验结果、隧道漂移精确值）

---

## Self-Review 记录

- **叙事覆盖**：为什么必须仿真（156 条扫描 + 相机帧 + 漂移分解）→ 隧道作为场景参数 → 散点口径修正 → 目标达成（散点消失/DR 漂移/纠回/绑路）✓
- **裁决记录**：宿主 0042（用户，含从 0018 的修正）；隧道默认 60s（实测甜点）；散点失锁期消失（用户）；显示修正与隧道同批做（用户）
- **占位符扫描**：无 TBD/TODO；T6 的段数/里程为"待实录值"，按实录收紧（数据驱动，非占位）
- **类型一致性**：`noFix?: boolean`（T1 产出 / T2、T3 消费）；`gnssPath?: TrajPoint[]`（T3 MapView↔SvgFallback↔App 一致）；`tunnelDurationS?: number`（T1/T4/T6 一致）
- **风险**：0042 真实掉点会让散点在若干 0.5s 处闪烁（真实指纹，保留）；离线态旋钮不改蓝线（已用 `title` 标注）

## 修订记录

- 2026-09-10 初稿。宿主由 0018 修正为 0042——依据是**横向漂移**实测（0018 仅 9m，0042 达 59m）；
  先前按"时长/弯道"选 0018 是错的度量，沿轨误差被当成了漂移。
- `superpowers:writing-plans` skill 在本会话不可用（`Unknown skill`），本计划按既有 Step4 计划格式手写。

## Errata（实现期运行时实证修正）

- **T6 fixture 按 30s 录（非计划里的 60s）——实测撞到 MM 能力边界**：
  - 60s（DR 横向漂 58.6m）→ HERE **2 段 / 2431m**，真值→匹配路线 mean 4.04 / **max 49.85m**：
    MM 跟着 DR 的漂移吸附到了**旁路**（它只能向最近路网吸附，DR 跑偏 60m 时它无从知道真值）。
  - 30s（DR 横向漂 ~11m）→ HERE **1 段 / 2594m**（真值 2590m），mean 1.19 / **max 6.10m** ✓
  - **MM 有效纠正范围 ≈ 车道间距量级**。演示目标是「MM 能正确绑路」→ fixture 取 30s；
    60s 保留为「能力边界」话术（同时是量产里 MM 必须与 DR 紧耦合而非串行的证据）。
  - T7 因此同时锁 30s（8–15m）与 60s（≥55m）两档漂移，把边界写成可执行断言。
  - 60s 录制的原始响应留档在 `data/fixture-0042-tunnel60.json`（gitignored）。
- **未增强对照**：把「失锁期冻结流」直送 HERE——60s 时得 **1 段 / 2536m**。
  即 **HERE 对「输入卡住」是鲁棒的，路线碎裂只由噪声/跳变引起**（与 0093 的 4 段碎裂同源）。
- **证伪实验（T2/T7）**：临时移除 `!noFix` 门控 → V9 / V10 / 0042 三条转红（漂移 58.6m → 32.7m），
  恢复后全绿。测试有鉴别力。
- **实现期抓到的边界 bug**：`buildGnssFeed` 窗口用半开区间 `[start, min(start+D, T))` 时，
  截断场景会漏掉末帧（G8 抓到）→ 改用 `+∞` 作开区间上界，使「截断」语义 = 一直拒止到录制结束。
- **测试期望修正（均为我写错，非实现错）**：
  - V10 对照口径：1Hz 更新对「冻结 GNSS」的平衡态是**有界振荡 ~24m**，不是「压回原处」→ 对照须对真值量。
  - A1 计数：换轨迹 + 开隧道共 **3 次**请求（原写 2 次，比的其实是隧道关闭那次）。
  - A3 前提：隧道是**场景参数**，对任何轨迹生效（0033 也会被套上）——「零污染」只在隧道关闭时成立。
  - 画幅断言：归一化把最长边钉在 1000 单位，故「画幅变高」应断言宽高比而非高度。
