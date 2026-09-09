# HERE Map Matching POC — Step4 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Step4：接入 KITTI 退化轨迹 `2011_09_26_drive_0093`（城市峡谷，卫星 2–6，偏差 max 26m）+ 路线 A 多速率 DR（10Hz IMU 预测 / 1Hz GNSS 更新）+ DR 增强后喂 HERE Route Import 绑路 + 三层渲染（GNSS 散点 / DR 轨迹 / 匹配路线）——交付「退化场景下 DR+MM 的完整叙事」。

**Architecture:** `lib/deadReckoning.ts` 纯函数（失锁检测 + 2D 多速率航位推算）→ App 加载期产出 `drPositions`（10Hz 滤波输出）→ ① 作为第三图层渲染；② 作为 import 请求的增强 trace（live 路径），并重录 0093 的 DR 增强匹配 fixture（4 段碎裂 → 预期连续路线，即核心对比叙事）。数据格式零改动（trajectory_light 已带 headingDeg/speedMps/numsats/axMps2/wzDegs）。

**Tech Stack:** 现有地基，零新增 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-09-07-here-map-matching-poc-design.md`（L15 领域深度叙事、L131 退化场景素材）；本步为 spec 交付后的增量迭代，架构裁决记录于本文档修订记录。

## Global Constraints

- 零新增 npm 依赖；strict TS + `verbatimModuleSyntax`；测试显式 import from 'vitest'
- 既有 81 测试与既有轨迹（0011/0033）行为零破坏（DR 图层仅对存在失锁段的轨迹可视化；无失锁时图层不渲染）
- **DR 为路线 A**（用户裁决 2026-09-09）：2D 航位推算——航向用 oxts 融合航向（失锁期间惯性维持）、速度用 `speedMps`（轮速等效），**不做全量 ESKF**（升级路径见文末）；多速率结构 = 10Hz 预测 + 1Hz GNSS 历元更新（每 10 帧抽样位置，用户提议的 1:10 构型）
- **不做人工扰动**（用户裁决 2026-09-09）——退化来自真实数据（0093 卫星 2–6、t≈15s 位置突跳 6.2m）
- key 处理沿用（不进 git/代码/对话）；提交直接进 main，conventional commits
- DR 数学必须可测：合成向量（直线/匀速圆周/冻结 GNSS）下手算期望值写进测试

## 现状（已核实，2026-09-09）

- GNSS 扫描（47 条 City 轨迹 + navstat 增强判据）：**0093 为最强退化候选**——43.3s/433 点/0.54km，卫星 min 2 / 均值 4.5（p10=2），行驶中 ≤4 星连续 3.7s、≤7 星连续 20.6s，t≈15s 位置突跳 6.2m（≈8× 车速，低星重收敛指纹）；navstat 全程恒 4（该信号在 KITTI 无效，已记）
- 0093 已转换入库：`data/kitti/2011_09_26_drive_0093/trajectory_light.json`（433 点，含 axMps2/wzDegs 扩展字段）
- 0093 原始（非 DR 增强）匹配已录：433 点请求 → **4 sections / 292m**（对比原始轨迹 540m——退化输入致匹配碎裂）；偏差统计：mean 6.77 / p50 6.80 / p95 15.79 / **max 26.34 m**
- 已预置（未提交，T1 一并入库）：`public/sample/here/2011_09_26_drive_0093.json`、`public/fixtures/2011_09_26_drive_0093.json`（CacheEntry 包装的 live 响应）、`scripts/record-fixtures.mjs` 的 DRIVES 增补
- 对照组：0033 偏差 mean 1.53m / max 7.09m（RTK 级），0011 mean ~1m 级——0093 的 26m 让 MM 纠偏首次肉眼可见
- 既有 derive() 对多 section 是顺序拼接（含段间跳跃线）；既有测试只覆盖过单 section

## File Structure

```
src/
├── lib/
│   └── deadReckoning.ts        # T2: detectOutages + deadReckon（多速率 1:10）
├── App.tsx                     # T3: DRIVE_IDS 增 0093；加载期算 drPositions；传层
├── components/
│   ├── MapView.tsx             # T3: drPath 图层（HERE Polyline + SvgFallback）
│   └── SvgFallback.tsx         # T3: drPath 折线渲染
└── __tests__/
    ├── deadReckoning.test.ts   # T2
    ├── trajectories.test.ts    # T1: 契约测试扩到 3 条轨迹
    └── fixtures.test.ts        # T1: fixture 契约扩到 3 条
scripts/
└── record-fixtures.mjs         # T4: --dr 增强录制（py 一次性重录为替代方案，见任务内裁决）
```

---

### Task 1: 0093 数据入库 + 契约测试扩展

**Files:**
- Commit（已预置）: `public/sample/here/2011_09_26_drive_0093.json`、`public/fixtures/2011_09_26_drive_0093.json`、`scripts/record-fixtures.mjs`（DRIVES 增补）
- Modify: `src/__tests__/trajectories.test.ts`、`src/__tests__/fixtures.test.ts`

**Interfaces:**
- Produces: 第三条 demo 轨迹（433 点）与其 fixture（4 sections/292m，source:'live'）进入契约保护；`DRIVE_IDS` 增补在 T3（App 改动归 T3，本任务纯数据+测试）

- [ ] **Step 1: 扩契约测试（先红）**——trajectories.test.ts 的 `it.each` 增一行 `['2011_09_26_drive_0093', d0093 as unknown as TrajPoint[], 433]`（顶部 import 对应 json；KA_BOX 断言沿用——0093 bbox 中心 48.998,8.469 在盒内）；fixtures.test.ts 增 `checkFixture(f0093, '2011_09_26_drive_0093', 4, 250)`（≥4 段、≥250m）
- [ ] **Step 2: 跑绿**（数据已在位，测试转绿即可）
- [ ] **Step 3: Commit**（含预置数据与 record 脚本增补）`feat: onboard degraded-GNSS trajectory 0093 with contract tests`

---

### Task 2: deadReckoning.ts（多速率 1:10 航位推算）

**Files:**
- Create: `src/lib/deadReckoning.ts`
- Test: `src/__tests__/deadReckoning.test.ts`

**Interfaces:**
- Consumes: `TrajPoint`（headingDeg=KITTI yaw 需经 `yawToCompassDeg`，speedMps，timestamp，numsats）
- Produces:
  - `detectOutages(trace: TrajPoint[], satThreshold = 6): boolean[]`——逐点失锁标记（numsats ≤ 阈值），与 trace 严格对齐
  - `deadReckon(trace: TrajPoint[], opts?: { gnssHz?: 1; gain?: 0.3; satThreshold?: 6 }): DrResult`——`DrResult { positions: Array<[number, number]>; corrected: boolean[]; innovations: number[] }`：
    - **10Hz 预测（每帧）**：`p += v·dt·[sin(compass), cos(compass)]`（局部米制：dLat = v·dt·cos(compass)/111320，dLng = v·dt·sin(compass)/(111320·cos(lat))；compass = `yawToCompassDeg(headingDeg)`）
    - **1Hz 更新（每第 10 帧）**：若该历元 numsats > satThreshold（GNSS 可信）：`p ← p + gain·(p_gnss − p)`，记录 `innovations[i] = |p_gnss − p|`（更新前）；`corrected[i] = true`。失锁历元跳过更新（自由递推）
    - 首帧初始化：`p = p_gnss`（首个可信历元；全程无可信历元则返回全 GNSS 原位置）
    - `positions` 恒为 10Hz 滤波输出（GNSS 不可信时段即 DR 外推）

- [ ] **Step 1: 写失败测试（手算向量，TDD 铁律）**：
  1. **直线可信段**：60 帧 10Hz，恒速 10m/s、yaw=0°（正东），GNSS 位置沿东向每帧 +1m、卫星 10 颗 → 滤波输出与 GNSS 偏差有界（≤0.5m/历元×增益收敛），第 10/20/… 帧 corrected=true 且 innovations 递减
  2. **失锁外推（核心）**：前 20 帧可信（建稳），第 20–60 帧 numsats=3 且 **GNSS 位置冻结不动**（模拟失锁），车速恒 10m/s、yaw=0° → 输出位置继续以 10m/s 东向推进（第 60 帧距第 20 帧 ≈ 40s×10 = 400m±1m），失锁帧 corrected=false
  3. **1Hz 更新纠回**：同 2，但 GNSS 不冻结而是带 5m 恒定横向偏置且卫星 10 颗 → 每 10 帧 gain=0.3 几何级数纠回（手算第 1、2 历元后的残差 5×0.7、5×0.49）
  4. **圆周外推**：yaw 随时间线性增加（wz 恒定），失锁 30 帧 → 终点位置与手算圆弧终点角距 ≤1°（或位置差 ≤2% 弧长）
  5. **detectOutages**：合成 numsats [10,10,3,3,10] 阈值 6 → [f,f,t,t,f]
- [ ] **Step 2: 跑红 → Step 3: 实现（<60 行）→ Step 4: 跑绿**
- [ ] **Step 5: 用真实 0093 做烟囱验证（非断言，人审）**：临时脚本或 vitest console 输出——DR 输出与 GNSS 的最大分离点应在失锁段（卫星 ≤4 时段），且无 NaN
- [ ] **Step 6: Commit** `feat: multi-rate dead reckoning (10Hz predict / 1Hz update)`

---

### Task 3: 三层渲染（DR 图层）+ App 接线

**Files:**
- Modify: `src/components/MapView.tsx`、`src/components/SvgFallback.tsx`、`src/App.tsx`
- Test: `src/__tests__/mapview.test.tsx`（追加）

**Interfaces:**
- Consumes: `deadReckon`（T2）
- Produces:
  - MapView/SvgFallback 增可选 prop `drPath?: Array<[number, number]>`（缺省不渲染——0011/0033 无失锁段时 `detectOutages` 全 false，App 传 undefined，既有轨迹渲染零变化）
  - DR 图层：紫色 `#7c3aed` 折线（HERE：`H.map.Polyline` style strokeColor；SVG：`<polyline data-testid="dr-path">`，strokeWidth 1.5，加 `strokeDasharray="6 3"` 与匹配路线区分）；渲染于匹配路线（蓝）之下、散点之上
  - App：`DRIVE_IDS` 增 `'2011_09_26_drive_0093'`（下拉第三项）；加载完成后 `const dr = useMemo(() => { const out = detectOutages(data.trace); return out.some(Boolean) ? deadReckon(data.trace) : null }, [data])`；MapView 传 `drPath={dr?.positions}`；**偏差统计/回放语义不变**（deviationM 仍是原始 GNSS→匹配路线 = DR+MM 联合纠偏量，计划注释写明）
  - 0093 的多 section 拼接：derive 不改（既有行为），mapview 测试补一条**双 section 合成用例**（两段不相邻 polyline → matched-path 仍非空、gnss-dot 投影不抛错）——锁住多段路径不炸

- [ ] **Step 1: 先写失败测试**：mapview 追加两条——① `drPath` 传入 3 点 → `[data-testid="dr-path"]` 存在且 points 非空；不传 → null。② 双 section 合成 derive→渲染烟囱（构造 2 段不相邻 polyline 的 response 走 `derive()`，断言 matched-path 非空且无异常）
- [ ] **Step 2: 跑红 → Step 3: 实现两组件图层 + App 接线 → Step 4: 跑绿（全套）**
- [ ] **Step 5: 手动烟囱（dev 模式，选 0093）**：三层可见——橙点漂移、紫虚线平滑、蓝线锁路网；0011/0033 无紫线（无失锁段）
- [ ] **Step 6: Commit** `feat: render DR layer with degraded trajectory 0093`

---

### Task 4: DR 增强匹配 + 0093 fixture 重录（碎裂→连续对比叙事）

**Files:**
- Modify: `src/App.tsx`（live 路径增强）
- Create: `scripts/rerecord-0093-dr.py`（一次性工具，入库留痕）
- Modify: `public/fixtures/2011_09_26_drive_0093.json`（重录后替换）

**Interfaces:**
- Consumes: `deadReckon`（T2，live 路径直接用 TS 模块）
- Produces:
  - **App live 路径**：`matchService` 调用前，若 `detectOutages(trace)` 有真值 → `importRoute` 的 trace 用 `deadReckon(trace).positions` 映射回 TrajPoint 形状（lat/lng 替换，其余字段透传）；无失锁 → 原样（0011/0033 live 行为零变化）。注意：**缓存/fixture 路径不增强**（离线数据即所录即所得）
  - **0093 fixture 重录**：py 一次性脚本复刻 T2 的 DR 规则（同 gain/阈值/1Hz 结构，~25 行），对 `public/sample/here/0093.json` 生成 DR 增强请求 → curl live（key 经 .env 读入不回显）→ 断言 section 数 ≤ 原始 4 段（预期碎裂减少；若反而变多，保留原始 fixture 并在 Errata 记录实证）→ 包装 CacheEntry 替换 `public/fixtures/2011_09_26_drive_0093.json`
  - 契约测试随新 fixture 更新段数断言（`checkFixture(f0093, …, N, 250)`，N 按实录值）
  - **同步义务注释**：py 脚本头部注明与 `src/lib/deadReckoning.ts` 的参数同步（DR 规则若改，重录脚本跟随）

- [ ] **Step 1: 先跑 py 脚本（DR 增强）实录**，看 section 数与里程对比原始（4 段/292m）——**这一步的输出直接决定叙事走向**，结果记录进计划 Errata
- [ ] **Step 2: App live 增强接线 + 测试**：app.test 增一条——0093 + key + 桩 fetch 断言请求 body 的 trace 点等于 DR 输出（用 `deadReckon(trace0093).positions` 生成期望值，直接比对 JSON）
- [ ] **Step 3: 跑绿 + Commit** `feat: DR-augmented live matching and re-recorded 0093 fixture`

---

### Task 5: Step4 验收

- [ ] **Step 1: 全量绿**：`npm run build && npm run test`
- [ ] **Step 2: 手动验收（用户浏览器，写入 `.superpowers/sdd/<plan>/manual-acceptance.md`）**：
  - 选 0093 → 静态模式：三层对比清晰（橙点偏离蓝线肉眼可见，紫 DR 线平滑衔接）；统计面板 mean≈6.8/p95≈15.8/max≈26m（若 T4 重录改变了路线则按新值）
  - 客户演示模式回放 0093：车标沿蓝线、橙点逐个洒出且 visibly 偏离、紫线随播放生长
  - 0011/0033 回归：无紫线、渲染与 Step3 一致
  - preview 模式复查（演示用）
- [ ] **Step 3: 收尾**：git 干净；Errata 补记（navstat 无效性、0093 扫描结论、T4 重录对比数据）

---

## 升级路径（路线 B，不在本步范围）

真·捷联积分 + ESKF：oxts 已带 `axMps2`/`wzDegs`（trajectory_light 已携带）；需要零偏状态 + NHC/ZUPT 伪观测 + Q/R 整定。触发条件：面试前有余力或被追问 KF 实现细节时口头展开（参数与结构已在本计划讨论记录中）。

## Self-Review 记录

- **叙事覆盖**：退化数据（0093 扫描发现）→ 多速率 DR（用户 1:10 提议）→ DR 喂 MM（用户核心诉求）→ 三层可视化 → 碎裂→连续对比（T4 实录验证）✓
- **裁决记录**：路线 A（用户）；1:10 多速率（用户）；不做人工扰动（用户）；DR 图层仅失锁轨迹渲染（避免 0011/0033 视觉污染）；偏差语义 = DR+MM 联合纠偏量（注释写明）；fixture 重录用 py 复刻而非 ts 复用（Node 无法直接跑 TS 模块，一次性工具的同步义务以注释锚定）
- **占位符扫描**：无 TBD/TODO；T4 Step 1 的 section 数为待实录值（契约断言按实录更新，属数据驱动而非占位）
- **类型一致性**：`DrResult { positions; corrected; innovations }`（T2 产出 / T3/T4 消费 positions）；`drPath?: [number,number][]`（T3 内部 MapView↔SvgFallback 一致）；detectOutages 阈值默认 6（T2 定义 / T3/T4 消费一致）

## Errata（实现期运行时实证修正）

（执行期追加）

