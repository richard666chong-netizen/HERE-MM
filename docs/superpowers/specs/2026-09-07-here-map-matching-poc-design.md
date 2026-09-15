# HERE Map Matching POC - 需求设计文档

## 概述

独立的 HERE 地图匹配（Map Matching, MM）演示应用：导入德国 KITTI GNSS+IMU 行驶轨迹，调用 HERE Route Matching API v8 将轨迹匹配到路网，以"静态对比 + 动态回放"双层展示原始 GNSS 轨迹与匹配结果的偏差分析。

本应用**完全独立于 LBN_test_platform**（该仓库零改动、零依赖、零数据残留），作为 HERE Sales Solution Architect 岗位面试的活体演示。

## 背景与目标

面试演示的三重叙事：

1. **Demo 速度**：求职信承诺"用 HERE 公开 API 快速搭 demo"，本应用即兑现
2. **买方视角**：模拟车厂工程师评估图商的方法论——定位质量分析正是 OEM 验收 HERE 的核心问题
3. **领域深度**：地图匹配、横向偏差、GNSS 退化场景分析是作者的量产项目本职

数据：KITTI raw oxts（OXTS RT3000 GNSS+IMU，卡尔斯鲁厄，WGS-84，10Hz，大众旅行车采集）。

| 数据 | 时长 | 里程 | 特征 | 用途 |
|---|---|---|---|---|
| 2011_09_30_drive_0033 | 2.7 min | 1.7 km | 连续城市行驶 | 主 demo |
| 2011_09_26_drive_0011 | 23 s | 0.11 km | 4 急转弯，卫星 5-8 颗（城市峡谷） | 困难场景 demo |

## 非目标

- 不集成 LBN_test_platform（该仓库保持原状）
- 不做中国境内数据演示（HERE 中国底图为合作方授权数据，演示风险大于收益）
- 不做用户系统/部署（本地 `npm run dev` 即可；GitHub Pages 为可选后续）
- v1/v2 不依赖真实 API 调用（apikey 未注册，Mock 优先；live 为 Step3）

## 技术方案

| 项目 | 选择 | 理由 |
|---|---|---|
| 框架 | Vite + React 19 + TypeScript | 与既有技术舒适区一致，脚手架最快 |
| 地图 | HERE Maps API for JavaScript，script 标签加载 + 自封装 loader | 零 npm 依赖；网络降级完全可控（本机 ISP 有 HTTPS 透明劫持前科） |
| 匹配 | HERE Routing API v8 **Route Import**：`POST https://router.hereapi.com/v8/import?return=polyline,summary&transportMode=car`，apikey 认证，JSON body `{"trace":[{lat,lng},...]}`（2–50000 点） | 2026-09-07 实测修正：Route Matching API v8（`routematching.hereapi.com/v8/match/routelinks`，CSV body，`mode=car`）自 2025-03-15 起**仅 Enterprise Plan** 可用，Base Plan key 请求返回 429 + `X-RateLimit-Limit: 0`；Route Import 是 Base Plan 内的等价轨迹匹配，返回匹配路线 polyline（flexible polyline，需解码），偏差由 app 自算 |
| Mock | 本地 fixture 按 v8/import 响应格式构造；2026-09-07 已用真实 key 录制 drive_0011 响应存 `data/fixtures/`，脚手架落地后迁入仓库 | 无 key 可开发，断网可演示 |
| 缓存 | localStorage（浏览器持久）+ fixture（随仓库）双层 | 演示永远可离线复现 |
| 图表 | Recharts | 偏差统计曲线 |
| 密钥 | `import.meta.env.VITE_HERE_KEY`，`.env` 文件（gitignore） | 沿用成熟模式 |

## 页面布局

单页应用，顶部双模式 tab：

- **工程分析模式（静态）**：HERE 底图全览——原始 GNSS 散点 vs 匹配路线折线双色对比；侧边/底部偏差统计面板（分布直方图 + 随里程偏差曲线 + 汇总指标：均值/95 分位/最大值）
- **客户演示模式（回放）**：播放/暂停/倍速(1x/2x/5x)/进度条拖动；车图标沿匹配路线行驶（航向取 IMU yaw）；GNSS 原始点随播放逐个洒出；偏差曲线随时间滚动联动

顶栏：轨迹选择（0033 / 0011）· `MOCK`/`LIVE` 状态角标 · 缓存管理（清除/录制）。

页脚固定标注：`Data: KITTI (Geiger et al., 2013), CC BY-NC-SA · Map: HERE`。

## 数据流

```
public/sample/here/2011_09_30_drive_0033.json   (trajectory_light.json 格式, WGS-84, 10Hz)
  ↓ 选择轨迹
MatchService.match(driveId)
  ├─ 缓存命中(localStorage) → 直接返回
  └─ 未命中 → 有 VITE_HERE_KEY ? HereRouterClient(live) : MockService(fixture)
       ↓ 响应(v8/import 原始格式: routes[].sections[].polyline + summary)
derived 预计算: 每轨迹点 → { matchedLatLng(点到匹配 polyline 的垂足投影), deviationM, headingDeg, speedMps }
              // 注意: import API 不提供逐点 linkId/confidence（那是 Route Matching API 的能力，Enterprise only）
  ↓
视图组件只消费 derived —— 回放层零实时计算
```

坐标说明：KITTI 为 WGS-84，HERE 原生 WGS-84，**不做任何坐标系转换**（GCJ-02 仅适用于中国境内数据）。

## 缓存 schema

```json
{
  "driveId": "2011_09_30_drive_0033",
  "source": "live | mock",
  "createdAt": "ISO-8601",
  "response": { "...": "v8/match 原始响应，不裁剪" },
  "derived": [
    {
      "i": 0,
      "matchedLatLng": [48.9701, 8.4787],
      "linkId": "-here:cs:segments:...",
      "deviationM": 3.2,
      "headingDeg": 91.5,
      "speedMps": 12.4
    }
  ]
}
```

- key：`here-mm-cache:{driveId}`；fixture 结构与之相同（`response` 字段驱动契约测试）
- `derived.i` 与原始轨迹点序号严格对齐（10Hz），回放按 `i` 索引

## 网络与兜底（演示永不因网络失败）

1. SDK 加载失败：提示 + 重试按钮（预留 https→http 降级补丁位，仅 dev 生效）
2. live 调用失败：自动落回 fixture/缓存，UI 角标明示数据来源
3. **无底图模式**：断网时 HERE tiles 拉不到 → 纯色背景 + 路线/散点/车标照常渲染，演示不死
4. 最终兜底：Step3 完成后屏录一份完整 demo 视频存档

## 测试

- **单元测试（Vitest）**：derived 生成（响应→逐点映射）、deviationM 横向偏差计算、缓存 key 与读写
- **契约测试**：fixture 的 `response` 结构必须匹配 v8/match 官方文档 schema（字段缺失即失败，防止 HERE 响应变更后 fixture 静默失效）
- **手动验收清单**：无 `.env` 冷启动 → MOCK 角标亮 → 双模式全流程可走通

## Git 与目录

- 独立仓库 `D:\here-poc`，单人短周期，直接提交 `main`
- `.gitignore`：`node_modules/ dist/ .env data/raw/`
- 两条 demo 轨迹 JSON 入库于 `public/sample/here/`（轻量，自包含）；原始 oxts 数据在 `data/raw/`（不入库）
- **Step0 搬家清场**：`D:\LBN_test_platform\data\` 下全部 HERE POC 相关文件（`kitti/`、`fetch_kitti_oxts.py`、`analyze_kitti.py`）整体迁入 `D:\here-poc\data\`，LBN 仓库回到无 HERE 痕迹状态（这些文件均为未跟踪文件，搬走即净，无需回滚）

## 实施顺序

| 步骤 | 内容 | 交付判据 |
|---|---|---|
| Step0 | 搬家清场 + Vite 脚手架 + .gitignore + 轨迹入库 | LBN `git status` 无 HERE 相关条目；`npm run dev` 空壳可起 |
| Step1 | SDK loader + HereMapView + MockService + 静态对比 + 统计 | MOCK 模式下双线对比 + 偏差图表可见 |
| Step2 | 回放条 + derived 消费 + 双模式 tab | 回放流畅，偏差曲线联动 |
| Step3 | apikey 后 live 联调 + fixture 录制回写 + 屏录 | LIVE 角标亮，断网仍可完整演示 |

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| fixture 无真实响应可录（尚未注册） | 按官方文档 schema 构造；拿到 key 后第一件事就是录制真实响应回写 |
| ISP HTTPS 劫持影响 HERE 域名 | 无底图模式 + Mock 兜底；必要时启用 dev 用 http 降级补丁 |
| KITTI 许可 CC BY-NC-SA | 仅面试演示用途；页脚标注出处；不用于任何商业交付 |
| MM 匹配质量不佳（如 0011 急弯场景） | 这本身是叙事素材（GNSS 退化场景下 MM 的价值）；若 0033 质量异常则切换 2011_09_26_drive_0019 备用 |

## 偏差统计指标定义

### 数据流概览

```
KITTI oxts trace（WGS-84, 10Hz, 全程有坐标——失锁期为 OXTS INS 桥接值）
  ↓ buildGnssFeed（仿真失锁：posmode==0 或隧道参数 → 冻结 GNSS 位置, 标 noFix）
  ↓ deadReckon（本地简易 DR：heading + speed 积分, 1Hz GNSS 纠正 gain=0.3）
  ↓ liveTrace（DR 推算结果, 始终运行——无论 mock 还是 live）
  ↓
  ├─ Mock: liveTrace → fixture 预录制 HERE 响应 → derive(liveTrace, fixture.response)
  └─ Live: liveTrace → HERE /import API 实时返回 → derive(liveTrace, api.response)
  ↓
  derived[]: 每点 → { matchedLatLng, deviationM, headingDeg, speedMps, linkId }
```

### 指标一：横向偏差（deviationM）

- **含义**：本地 DR 推算位置到 HERE MM 匹配路线的垂直距离
- **A 端**：`liveTrace[i]`——本地 DR 推算位置（heading + speed 简化积分, 1Hz GNSS 纠正）
- **B 端**：HERE `/import` 返回的匹配路线 polyline 上最近的投影点（垂足）
- **计算**（`derive.ts`）：对每个 DR 点, 在 MM polyline 的所有线段上找最近投影点（`nearestOnPolyline`, `t` 参数 clamp 到 `[0,1]`）, `deviationM` = DR 点到垂足的 haversine 距离
- **语义**：HERE MM 对本地 DR 结果的纠偏量——DR 偏离路网多远, MM 拉回了多少

### 指标二：偏差均值（meanM）

- **含义**：全轨迹所有点的 `deviationM` 算术平均
- **计算**（`stats.ts:deviationStats`）：`sum(deviationM[]) / n`
- **语义**：DR → MM 的平均纠偏量

### 指标三：偏差 95 分位（p95M）

- **含义**：95% 的点偏差低于此值
- **计算**：最近秩法——`sorted[ceil(0.95 * n) - 1]`（升序排列后取第 95 百分位秩）
- **语义**：排除最差 5% 后的偏差上界——OEM 验收常用指标

### 指标四：偏差最大值（maxM）

- **含义**：全轨迹最大的单点偏差
- **计算**：`sorted[n - 1]`
- **语义**：最坏工况下 DR 偏离路网的距离

### 指标五：DR 漂移（drMaxDriftM）

- **含义**：本地简易 DR 推算位置与 OXTS 输出轨迹的最大偏差
- **A 端**：`deadReckon(gnssFeed).positions[i]`——本地 DR 推算位置
- **B 端**：`trace[i].lat/lng`——KITTI oxts 输出（OXTS RT3000 GNSS+INS 融合解, 失锁期为内部 INS 桥接值）
- **计算**（`App.tsx`）：`max(haversineM(dr.positions[i], [trace[i].lat, trace[i].lng]))`
- **语义**：本地简化 DR（heading + speed 积分）与 OXTS 专业 INS（原始 IMU + Kalman 滤波）的精度差距
- **注意**：OXTS 输出不是独立高精度真值（需 RTK 厘米级参考系统）, 而是同一套传感器的更精密融合解——此指标是"两种算法精度对比", 非严格真值验证

### 指标六：偏差分布直方图

- **含义**：`deviationM` 的等宽分桶分布（默认 20 bin, 值域 0..max）
- **计算**（`stats.ts:deviationHistogram`）：半开区间 `fromM ≤ v < toM`, 末 bin 右闭
- **语义**：偏差集中分布区间——偏左表示 DR 与路网整体贴合良好

### 指标七：偏差-里程曲线

- **含义**：`deviationM` 随沿轨迹累计里程的变化
- **X 轴**：`liveTrace` 的 haversine 累计里程（km）
- **Y 轴**：`deviationM`（m）
- **计算**（`stats.ts:deviationVsDistance`）：沿 `liveTrace` 逐段累加 haversine 距离, 与 `derived[i].deviationM` 按下标对齐
- **语义**：定位退化发生在路程的哪个位置——失锁段偏差陡升, 恢复后回落

### 四指标汇总对比

| 指标 | A 端 | B 端 | 语义 |
|---|---|---|---|
| 均值 / p95 / 最大 | 本地 DR 推算位置 | HERE MM 匹配路线 | MM 对 DR 的纠偏量 |
| DR 漂移 | 本地 DR 推算位置 | OXTS 输出（含 INS 桥接） | 两种 DR 算法精度差距 |

### 本地 DR 算法说明

- **输入**：OXTS 输出的 `headingDeg`（yaw 弧度转罗经度）+ `speedMps`（vf 前向速度）
- **未使用**：三轴加速度（ax/ay/az/af/al/au）和三轴角速度（wx/wy/wz/wf/wl/wu）——从数据解析阶段就未提取
- **算法**：简化位置积分 `pos += speed × cos/sin(heading) × dt`
- **纠正**：每 10 帧（1Hz）用 GNSS 位置拉回, `gain = 0.3`（`pos += 0.3 × (gnss - pos)`）
- **门控**：`numsats > 6` 时才纠正（≤4 星视为失锁, 不纠正, 纯递推）
- **与 OXTS INS 的区别**：OXTS 用原始 IMU 数据跑专业 Kalman 滤波（含误差建模、重力补偿、科氏力修正）；本地 DR 用的是 OXTS 已处理好的航向和速度做简化积分——相当于在 OXTS 的"肩膀"上做简化推算

### Mock 模式与 Live 模式的偏差口径

两种模式下偏差统计的口径完全一致——都基于 `derive(liveTrace, response)`：

| | liveTrace 来源 | response 来源 | DR 运行 |
|---|---|---|---|
| **Live** | 本地 DR 推算 | HERE API 实时返回 | 是 |
| **Mock** | 本地 DR 推算 | 仓库 fixture（用 DR 轨迹录制） | 是 |

差异仅在 HERE MM 响应的来源：Live 首次走 API（之后 localStorage 缓存）, Mock 读 fixture 文件。fixture 已用 DR 增强后的轨迹重新录制, 确保两侧数据对齐。
