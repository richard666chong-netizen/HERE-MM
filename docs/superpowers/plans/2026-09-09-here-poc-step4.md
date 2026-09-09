# HERE Map Matching POC — Step4 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Step4：接入 KITTI 退化轨迹 `2011_09_26_drive_0093`（城市峡谷，卫星 2–6，偏差 max 26m）+ 路线 A 多速率 DR（10Hz IMU 预测 / 1Hz GNSS 更新）+ DR 增强后喂 HERE Route Import 绑路 + 三层渲染（GNSS 散点 / DR 轨迹 / 匹配路线）——交付「退化场景下 DR+MM 的完整叙事」。

**Architecture:** `lib/deadReckoning.ts` 纯函数（失锁检测 + 2D 多速率航位推算）→ App 加载期产出 `drPositions`（10Hz 滤波输出）→ ① 作为第三图层渲染；② 作为 import 请求的增强 trace（live 路径），并重录 0093 的 DR 增强匹配 fixture（4 段碎裂 → 预期连续路线，即核心对比叙事）。数据格式零改动（trajectory_light 已带 headingDeg/speedMps/numsats/axMps2/wzDegs）。

**Tech Stack:** 现有地基，零新增 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-09-07-here-map-matching-poc-design.md`（L15 领域深度叙事、L131 退化场景素材）；本步为 spec 交付后的增量迭代，架构裁决记录于本文档修订记录。

## Global Constraints

- 零新增 npm 依赖；strict TS + `verbatimModuleSyntax`；测试显式 import from 'vitest'
- 既有 81 测试与既有轨迹（0011/0033）行为零破坏（DR 图层仅对存在失锁段的轨迹可视化；无失锁时图层不渲染）
- **DR 为路线 A**（用户裁决 2026-09-09）：2D 航位推算——航向用 oxts 融合航向（失锁期间惯性维持）、速度用 `speedMps`（轮速等效），**不做全量 ESKF**（升级路径见文末）；多速率结构 = 10Hz 预测 + 1Hz GNSS 历元更新（历元 = 下标 `i%10===0`，帧 0 亦为历元；用户提议的 1:10 构型）
- **两层阈值解耦（评审 blocker 修正）**：外层**叙事门控**用 `detectOutages(trace, 4)`——隧道级失锁（≤4 星）才渲染 DR 层/增强 live 请求（实测 0011/0033 的 ≤4 星点均为 0、0093 为 206，干净分离）；内层**可信历元更新门控**用 `numsats > 6`——少而准（0093 全程 >6 星仅 44 帧，DR 的价值恰在自由递推）
- **不做人工扰动**（用户裁决 2026-09-09）——退化来自真实数据（0093 卫星 2–6、t≈15s 位置突跳 6.2m）
- key 处理沿用（不进 git/代码/对话）；提交直接进 main，conventional commits
- DR 数学必须可测：合成向量（直线/匀速圆周/冻结 GNSS）下手算期望值写进测试

## 现状（已核实，2026-09-09）

- **三条轨迹 numsats 实测分布（评审实证，阈值依据）**：0011 min=8（≤6 星 0 点）；0033 min=5、p10=6、≤6 星 183/1594 点（6 段连续，最长 77 帧）、**≤4 星 0 点**；0093 min=2、≤4 星 206 点、>6 星仅 44 帧（帧 225–277，其中 1Hz 历元仅 [240,250,260,270]）、t≈15s 位置突跳 6.2m（帧 ~150，≤6 星区）。**推论**：阈值 6 会误伤 0033（紫线+增强，违反零变化）；阈值 4 三轨迹干净分离。
- 0093 另有 32/433 点 `speedMps` 低于 -0.1（最低 **-11.08 m/s**，t≈28.7s 低星重收敛期速度毛刺——退化指纹本身，契约测试需参数化下限而非放宽共享断言）
- GNSS 扫描（47 条 City 轨迹 + navstat 增强判据）：**0093 为最强退化候选**——43.3s/433 点/0.54km，卫星 min 2 / 均值 4.5（p10=2），行驶中 ≤4 星连续 3.7s、≤7 星连续 20.6s；navstat 全程恒 4（该信号在 KITTI 无效，已记）
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
- Produces: 第三条 demo 轨迹（433 点）与其 fixture（4 sections/292m，source:'mock'——bundled 即 mock 先例与 0011/0033 一致，录制来源在 response 本身）进入契约保护；`DRIVE_IDS` 增补在 T3（App 改动归 T3，本任务纯数据+测试）

- [ ] **Step 0: 预置数据修正**——`public/fixtures/2011_09_26_drive_0093.json` 的 `source` 由 'live' 改为 'mock'（评审修正：checkFixture 硬断言 mock，且离线不应亮 LIVE 徽标）
- [ ] **Step 1: 扩契约测试（先红）**——trajectories.test.ts 的 `it.each` 增一行 `['2011_09_26_drive_0093', d0093 as unknown as TrajPoint[], 433, -12]`（**速度下限参数化**：0093 有 32 点 speedMps 低于 -0.1、最低 -11.08——低星重收敛期的真实速度毛刺；既有两行加默认 -0.1，断言改用行参数）；fixtures.test.ts 增 `checkFixture(f0093, '2011_09_26_drive_0093', 4, 1)`（minSections=4；**minRouteLenM 是逐段下限**——传 1，另加总里程断言 `sections.reduce((a,s)=>a+s.summary.length,0) >= 250`，实测 292m）
- [ ] **Step 2: 跑绿**（数据已在位，测试转绿即可）
- [ ] **Step 3: Commit**（含预置数据与 record 脚本增补）`feat: onboard degraded-GNSS trajectory 0093 with contract tests`

---

### Task 2: deadReckoning.ts（多速率 1:10 航位推算）

**Files:**
- Create: `src/lib/deadReckoning.ts`
- Test: `src/__tests__/deadReckoning.test.ts`

**Interfaces:**
- Consumes: `TrajPoint`（headingDeg=KITTI yaw 需经 `yawToCompassDeg`，speedMps，timestamp，numsats）
- Produces（规则钉死——T4 的 py 复刻必须逐条抄录，评审 major 修正）：
  - `detectOutages(trace: TrajPoint[], satThreshold = 4): boolean[]`——逐点失锁标记（numsats ≤ 阈值），与 trace 严格对齐。**语义 = 叙事门控**（隧道级失锁判定），与更新门控解耦
  - `deadReckon(trace: TrajPoint[], opts?: { gain?: 0.3; updateThreshold?: 6 }): DrResult`——`DrResult { positions: Array<[number, number]>; corrected: boolean[]; innovations: number[] }`：
    - **初始化（帧 0，无条件）**：`p = trace[0]` 的 GNSS 位置（不论卫星数——无「init 前」特例，前导失锁段即从帧 0 纯递推；全程无可信历元 = 全程纯递推，语义天然良定义）
    - **10Hz 预测（每帧 k≥1）**：`p += v_k·dt_k·[sin(compass_k), cos(compass_k)]`（局部米制：dLat = v·dt·cos(compass)/111320，dLng = v·dt·sin(compass)/(111320·cos(lat))；compass = `yawToCompassDeg(headingDeg)`；dt = timestamp 差）
    - **1Hz 更新（历元 = 下标 i%10===0，含帧 0）**：若该历元 numsats > updateThreshold（可信）：`p ← p + gain·(p_gnss − p)`，记录 `innovations[i] = |p_gnss − p|`（更新前）、`corrected[i] = true`；否则跳过（自由递推）、`corrected[i] = false`。非历元帧 `corrected=false`、`innovations[i]=0`
- 测试向量的**期望值即规格**（手算错误 = 规格错误，评审已纠正两处）

- [ ] **Step 1: 写失败测试（6 组手算向量，TDD 铁律）**：
  1. **直线可信段**：60 帧 10Hz，恒速 10m/s、yaw=0°（正东），GNSS 位置沿东向每帧 +1m、卫星 10 颗 → 输出与 GNSS 逐点偏差 ≤0.5m（帧 0 初始化锁步、预测精确、历元 innovation=0）；第 10/20/… 帧 corrected=true
  2. **失锁外推（核心）**：前 20 帧可信（锁步），第 20–60 帧 numsats=3 且 **GNSS 位置冻结**，车速恒 10m/s、yaw=0° → 输出继续东向推进：**第 60 帧距第 20 帧 = 40 帧×0.1s×10m/s = 40m ±1m**（评审纠正：原稿 400m 为帧/秒混淆的 10 倍笔误）
  3. **1Hz 纠回（偏置阶跃）**：帧 0–9 GNSS 无偏（历元 0 在真值初始化），**第 10 帧起 GNSS = 真值 + 5m 恒定北偏**、卫星全程 10 颗 → 第 1 历元后 DR 残差 = 5×(1−0.3) = 3.5m、第 2 历元后 = 5×0.7² = 2.45m（偏置须阶跃出现——恒定偏置会被帧 0 初始化整体吸收、innovation 恒 0，评审纠正）
  4. **圆周外推**：yaw 随帧线性增加（恒定角速度），失锁 30 帧 → 终点与手算圆弧终点位置差 ≤2% 弧长
  5. **detectOutages**：合成 numsats [10,10,3,3,10] 阈值 4 → [f,f,t,t,f]；**负向锁定（评审补充）**：`detectOutages(trace0033)`（静态导入真实数据）全 false、`detectOutages(trace0093)` 含 ≥100 个 true
  6. **前导失锁（评审补充）**：前 30 帧 numsats=3 且 GNSS 带 3m 北偏漂移、帧 30 起卫星 10 颗无偏 → 前 30 帧输出 = 从帧 0 播种的平滑预测（非 GNSS 透传，与 GNSS 逐点分离 ≥1m），帧 30 历元起被 gain 纠回
- [ ] **Step 2: 跑红 → Step 3: 实现（<60 行）→ Step 4: 跑绿**
- [ ] **Step 5: 真实 0093 烟囱（人审）**：DR 与 GNSS 最大分离点应落在失锁段，无 NaN；输出点集落盘备用（T4 artifact 机制的雏形）
- [ ] **Step 6: Commit** `feat: multi-rate dead reckoning (10Hz predict / 1Hz update)`

---

### Task 3: 三层渲染（DR 图层）+ App 接线

**Files:**
- Modify: `src/components/MapView.tsx`、`src/components/SvgFallback.tsx`、`src/App.tsx`
- Test: `src/__tests__/mapview.test.tsx`（追加）

**Interfaces:**
- Consumes: `deadReckon`/`detectOutages`（T2）
- Produces:
  - MapView/SvgFallback 增可选 prop `drPath?: Array<[number, number]>`（缺省不渲染）
  - DR 图层：紫色 `#7c3aed` 折线（HERE：`H.map.Polyline` style strokeColor；SVG：`<polyline data-testid="dr-path">`，strokeWidth 1.5，加 `strokeDasharray="6 3"` 与匹配路线区分）；渲染于匹配路线（蓝）之下、散点之上
  - **画幅纳入 DR（评审 minor 修正）**：SvgFallback 的 geo useMemo 的 `all` 数组与依赖加入 `drPath ?? []`（依赖 `[trace, derived, drPath]`）；MapView 的 setLookAtData bounds 循环同样并入 drPath——0093 尾段 15.5s 纯递推的分离量可达 26m 级，不纳入则紫线被 viewBox/初始视野裁剪
  - App：`DRIVE_IDS` 增 `'2011_09_26_drive_0093'`（下拉第三项）；`const dr = useMemo(() => (data && detectOutages(data.trace, 4).some(Boolean) ? deadReckon(data.trace) : null), [data])`（**门控阈值 4**，评审 blocker 修正——阈值 6 会误伤 0033）；MapView 传 `drPath={dr?.positions}`；**偏差统计/回放语义不变**（deviationM 仍是原始 GNSS→匹配路线 = DR+MM 联合纠偏量，代码注释写明）
  - 0093 的多 section 拼接：derive 不改（既有行为），mapview 测试补一条**双 section 合成用例**（两段不相邻 polyline → matched-path 仍非空、gnss-dot 投影不抛错）——锁住多段路径不炸

- [ ] **Step 1: 先写失败测试**：mapview 追加三条——① `drPath` 传入 3 点 → `[data-testid="dr-path"]` 存在且 points 非空；不传 → null。② 双 section 合成 derive→渲染烟囱（构造 2 段不相邻 polyline 的 response 走 `derive()`，断言 matched-path 非空且无异常）。③ **bbox 纳入（评审补充）**：构造 drPath 一点远离 trace bbox（北向 +0.01°）→ 渲染后 viewBox 高度比不含 drPath 时大约 0.01°×111320m 的投影量（±10%）
- [ ] **Step 2: 跑红 → Step 3: 实现两组件图层 + App 接线 → Step 4: 跑绿（全套）**
- [ ] **Step 5: 手动烟囱（dev 模式）**：选 0093 → 三层可见（橙点漂移、紫虚线平滑、蓝线锁路网，紫线不被画幅裁剪）；**选 0033/0011 → 无紫线**（门控阈值 4 下 0033 的 ≤4 星点为 0——若出现紫线即门控回归，T2 向量 5 的负向断言应已拦截）
- [ ] **Step 6: Commit** `feat: render DR layer with degraded trajectory 0093`

---

### Task 4: DR 增强匹配 + 0093 fixture 重录（碎裂→连续对比叙事）

**Files:**
- Modify: `src/App.tsx`（live 路径增强）
- Create: `scripts/rerecord-0093-dr.py`（一次性工具，入库留痕）
- Modify: `public/fixtures/2011_09_26_drive_0093.json`（重录后替换）

**Interfaces:**
- Consumes: `deadReckon`/`detectOutages`（T2，live 路径直接用 TS 模块）
- Produces:
  - **App live 路径**：`matchService` 调用前，若 `detectOutages(trace, 4).some(Boolean)` → `importRoute` 的 trace 用 `deadReckon(trace).positions` 映射回 TrajPoint 形状（lat/lng 替换，其余字段透传）；否则原样（**0011/0033 live 请求零变化**——0033 的 ≤4 星点为 0，评审 blocker 修正）。缓存/fixture 路径不增强（离线即所录即所得）
  - **0093 fixture 重录**：py 一次性脚本逐条抄录 T2 钉死规则（帧 0 无条件播种 / 历元 i%10===0 / 更新门控 numsats>6 / gain 0.3 / 同米制常数），对 `public/sample/here/0093.json` 生成 DR 增强请求 → curl live（key 经 .env 读入不回显）→ 对比原始（4 段/292m）：section 数减少则替换 `public/fixtures/2011_09_26_drive_0093.json`（source 'mock'），否则保留原始并在 Errata 记录实证
  - **py/TS 同步可检验（评审 major 修正）**：py 脚本把 DR 增强请求点落盘为 `public/sample/here/2011_09_26_drive_0093.dr.json`（入库 artifact）；新增 vitest 断言 TS `deadReckon(trace0093).positions` 与 artifact 逐点 haversine 距离 ≤0.1m——py 复刻参数漂移即红
  - 契约测试随新 fixture 更新段数断言（N 按实录值，总里程断言沿用 ≥250 或按实录调整）

- [ ] **Step 1: 先跑 py 脚本（DR 增强）实录**，看 section 数与里程对比原始（4 段/292m）——**输出直接决定叙事走向**，结果记录进计划 Errata；artifact 一并落盘
- [ ] **Step 2: App live 增强接线 + 测试**（评审 major 修正口径）：app.test 增两条——
  1. **0093 增强生效**：0093 + key + 桩 fetch（TRACES 增 0093，router 桩返回合法响应）→ 断言 `JSON.parse(body).trace` 深等于 `buildImportRequest(drAugmented)`（drAugmented = trace0093 的 lat/lng 替换为 `deadReckon(trace0093).positions`——同进程同变换含 round6，浮点确定不脆），**反断言 ≠ `buildImportRequest(trace0093)`**（「忘了增强」的真证伪点）
  2. **0033 零变化回归**：0033 + key + 桩 fetch → 断言 `JSON.parse(body).trace` 深等于 `buildImportRequest(trace0033)`（堵住门控阈值回归的假绿）
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
- **裁决记录**：路线 A（用户）；1:10 多速率（用户）；不做人工扰动（用户）；**门控阈值 4 与更新阈值 6 解耦**（评审：阈值语义不同——「有没有故事」vs「信不信这一历元」；实测三轨迹在 4 下干净分离）；**帧 0 无条件播种**（评审：0093 前 52% 轨迹无可信历元，「首可信历元初始化」会让核心叙事在主演示区段落空；播种初值的绝对偏差是数据现实，紫线平滑+历元纠回才是卖点）；0093 fixture 标 'mock'（bundled 先例 + 离线徽标语义）；py 同步义务以 artifact + vitest 距离断言可检验（非仅注释）
- **占位符扫描**：无 TBD/TODO；T4 section 数为待实录值（契约断言按实录更新，数据驱动而非占位）
- **类型一致性**：`DrResult { positions; corrected; innovations }`（T2 产出 / T3/T4 消费 positions）；`drPath?: [number,number][]`（T3 内部 MapView↔SvgFallback 一致）；`detectOutages(satThreshold=4)` 语义=门控、`deadReckon(updateThreshold=6)` 语义=历元可信度——两层阈值刻意不同，T2/T3/T4 调用处均已写明

## 修订记录

- 2026-09-09 精简对抗评审（workflow `step4-plan-review`：3 视角，9 条发现全采纳）后修订：
  - **[blocker×3] satThreshold=6 与实测数据冲突**：0033 min=5、≤6 星 183 点 → 门控会误伤 0033（紫线+live 增强，违反零变化，且无测试能拦）；0093 在阈值 6 下仅 4 个可信历元、1Hz 结构名存实亡。修正：门控阈值 4（0011/0033 的 ≤4 星点为 0、0093 为 206）+ 两层阈值解耦 + T2 向量 5 负向锁定（真实 0033 全 false/0093 ≥100 true）+ T4 的 0033 零变化回归测试
  - **[blocker×2] 失锁外推向量手算 10 倍错**：40 帧@10Hz = 4s = 40m，原稿 400m 系帧/秒混淆。修正：40m±1m
  - **[blocker] T1 三处断言与数据冲突**：0093 有 32 点 speedMps 低至 -11.08（低星速度毛刺）→ it.each 参数化速度下限；fixture source 'live' vs checkFixture 硬断言 → 改标 'mock'；minRouteLenM 为逐段下限 → 传 1 + 总里程断言 ≥250
  - **[major] 纠回向量恒定偏置被初始化吸收**：innovation 恒 0、纠回不发生。修正：偏置在第 10 帧阶跃出现，第 1/2 历元残差精确 3.5/2.45m
  - **[major] 初始化规则欠定义 + py/TS 二义**：修正为帧 0 无条件播种 + 历元 i%10===0 钉死 + 前导失锁向量（第 6 组）+ py 侧 artifact 落盘 `0093.dr.json` 供 vitest 逐点 ≤0.1m 比对
  - **[major] 0093 前 52% 无 DR 效果**：由帧 0 播种规则一并解决（t≈15s 突跳段从帧 0 起即有 DR 输出）
  - **[major] T4 断言口径**：body 与 positions 全精度直比必红（round6 截断）→ 改为 body 深等于 `buildImportRequest(drAugmented)` + 反断言 ≠ 原始；stub 需含 0093 的 TRACES 与合法 router 响应（防静默落 fixture 测不到 live 路径）
  - **[minor] drPath 未入画幅**：SvgFallback geo memo 与 MapView bounds 均并入 drPath（0093 尾段递推分离可达 26m，不入则紫线被裁）+ bbox 测试向量

## Errata（实现期运行时实证修正）

（执行期追加）

