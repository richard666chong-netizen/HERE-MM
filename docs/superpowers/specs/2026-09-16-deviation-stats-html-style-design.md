# 设计：HTML 风格偏差统计统一面板（Phase 6）

日期：2026-09-16 · 状态：待用户评审
参考实现：`HERE-POC-MapMatching-CHANG-Zhen.html`（untracked，**勿提交**）`renderStatsPanel` L601–685、数据函数 L251–287

## 背景与目标

HTML 演示页的偏差统计有工程侧缺失的核心语义：**随回放进度实时切片**（chips / 直方图 / 偏差-里程图逐帧更新 + Current Deviation 红字读数）。本设计把它移植进工程——**样式与内容以 HTML 为准，技术路线按工程惯例自选**（已决策：自绘 SVG，方案 A）。

已锁定的需求口径（用户 2026-09-16 决策）：

1. **统一面板**：analysis 与 demo 共用一个组件（HTML 架构：一个 `renderStatsPanel(upToIndex)` 双态）；`DeviationReplayChart` 时间窗图保留不动。
2. **DR Max Drift chip 始终显示**（与 HTML 一致，不再按失锁门控）。

## 组件结构

```
src/components/StatsPanel.tsx    升级：统一面板（双态）
src/components/StatsCharts.tsx   新建：HistogramSvg + DistanceDeviationSvg（自绘 SVG，纯渲染）
src/lib/stats.ts                 新增：driftSeries()
```

### StatsPanel props（破坏性变更：移除 drMaxDriftM）

```ts
interface StatsPanelProps {
  trace: TrajPoint[]      // liveTrace（与 derived 对齐，供偏差-里程计算）
  derived: DerivedPoint[]
  driftM: number[]        // 逐帧 DR 漂移（本地 DR vs OXTS trace），App 预计算一次
  upToIndex?: number      // 缺省 = 全量（analysis）；给定 = 切片 + 红字读数（demo）
}
```

- 切片语义：`upTo = clamp(upToIndex ?? derived.length-1, 0, derived.length-1)`；统计输入 = `derived.slice(0, upTo+1)`；漂移 = `max(0, ...driftM.slice(0, upTo+1))`。
- Current Deviation 红字读数**仅当 `upToIndex` prop 给定时渲染**（HTML L681 同款条件）：`Current Deviation: {derived[upTo].deviationM.toFixed(2)} m`，数值 `#dc2626` 20px strong。
- chips：沿用现有 `InfoChip`（i 图标弹层）；**label 用 HTML 全称**（Mean Deviation / P95 Deviation / Max Deviation / DR Max Drift），**tooltip 内容保留工程富文本口径**；数值 `toFixed(2)` + ` m`。
- 更新节律（沿用 DeviationReplayChart 约定）：chips + 两图按 0.5s 时间戳量化（从 upToIndex 向后扫到首个 `timestamp ≤ tQ` 的帧），红字读数全速；**端点免量化**（`upToIndex === 末帧` 时直接用末帧，保证终点值精确等于全量统计）。

### StatsCharts.tsx（纯渲染，数据全由 StatsPanel 用 stats.ts 算好）

参数全部照抄 HTML（320×100 viewBox，padL=28 padB=16 padT=4 padR=4，轴 3+3 刻度，刻度字 8px `#6b7280`，轴线 `#9ca3af` 0.5px）：

- `HistogramSvg({ bins })`：20 桶，bar fill `#2563eb` opacity 0.7、宽 0.85×barW；y 刻度 maxCount/中值/0，x 刻度 0/中值/最大（m）。
- `DistanceDeviationSvg({ points })`：面积图 fill `rgba(37,99,235,0.15)` stroke `#2563eb` 0.8；yMax = `max(points 内最大偏差, 0.1)`（同切片下与 stats.maxM 等价，组件自足），xMax = `max(末点 distanceM, 1)`（单点守卫，HTML L652）；x 轴 km/m 自适应（≥1000 → km）。

## 数据层

`stats.ts` 新增纯函数（TDD）：

```ts
/** 逐帧 DR 漂移序列：本地 DR 推算位置 vs OXTS 输出的 haversine。长度不齐按 Math.min 截断（HTML L608 口径）。 */
export function driftSeries(trace: TrajPoint[], drPositions: [number, number][]): number[]
```

已有 `deviationStats / deviationHistogram / deviationVsDistance` 不动（切片在调用侧，与 HTML 同构）。守卫复用：直方图 max=0 防除零（已存在）、里程图 `maxDist ≥ 1`、drift 空输入返回 `[]`。

## 数据流（App.tsx）

- `DriveData` 增 `driftM: number[]`：load() 里 `drPositions` 已现成，`driftSeries(trace, drPositions)` 一次算好存入。
- 删除 `drMaxDriftM` memo（被 driftM 取代）；`dr` memo 保留（analysis 的 drPath 仍用）。
- 侧栏：demo = `StatsPanel(trace=liveTrace, derived, driftM, upToIndex=pb.index)` 上 + `DeviationReplayChart` 下（HTML 布局序）；analysis = `StatsPanel` 无 upToIndex。加载中传空数组（现有 `?? []` 模式）。

## 测试计划

1. `driftSeries`：空输入 / 常规最大 / 长度不齐截断 / 全零。
2. `StatsPanel`（jsdom）：无 upToIndex → 无读数、全量值；给 upToIndex → 切片值变化 + 读数存在；直方图渲染 20 个 rect；DR chip 无失锁数据也渲染；量化不破坏最终帧（终点值=全量值）。
3. 更新受 props 破坏性变更影响的现有测试（app.test 等）。
4. `vitest` 全量 + `npm run build`。
5. 目视验收：有头 Edge + 用户判别（验证工作流 memory：无头验不了视觉；5173）。

## 非目标

- `DeviationReplayChart` 不动；不移除项目里的 recharts。
- 图表不加 hover tooltip（HTML 本无；后续可补 `<title>`）。
- 不动 analysis 的 drPath / 失锁检测逻辑。
- 不照搬 HTML 的 DOM 拼接/innerHTML 实现方式。

## 验收标准

- analysis 模式：4 chips + 两图数值与现 recharts 版一致（同数据同函数），样式为 HTML 风格。
- demo 模式：随回放推进，chips/两图 ~2Hz 更新，红字读数即时；拖到终点暂停时数值精确等于全量统计（端点免量化）。
- 无失锁数据集（如 0093 隧道 Off）DR Max Drift chip 仍显示。
- 150+ 新测试全绿，build 通过。
