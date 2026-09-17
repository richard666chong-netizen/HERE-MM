import { useEffect, useMemo, useRef, useState } from 'react'
import DeviationReplayChart from './components/DeviationReplayChart'
import MapView from './components/MapView'
import ReplayBar from './components/ReplayBar'
import SourceBadge from './components/SourceBadge'
import StatsPanel from './components/StatsPanel'
import { usePlayback } from './hooks/usePlayback'
import { deadReckon, detectOutages } from './lib/deadReckoning'
import { buildGnssFeed } from './lib/gnssFeed'
import { derive } from './lib/derive'
import { driftSeries } from './lib/stats'
import { cacheKey, matchService, readCache, writeCache } from './lib/fixtureStore'
import { buildMatchedTrack } from './lib/matchedTrack'
import { loadHereMaps, probeBasemap } from './lib/hereLoader'
import type { CacheEntry, DerivedPoint, TrajPoint } from './types'

// 顶栏下拉顺序：退化 0093（真值不可信）→ 退化 0096/0106（真值可信，posmode 失锁）→ 0042（仿真隧道宿主）
const DRIVE_IDS = [
  '2011_09_26_drive_0093',
  '2011_09_26_drive_0096',
  '2011_09_26_drive_0106',
  '2011_10_03_drive_0042',
] // 0042 压末尾：仿真隧道宿主（高速，60s 拒止 → 横向漂移 58.6m）

// spec L45 双模式：工程分析（静态对比）/ 客户演示（回放）
const MODES = [
  { id: 'analysis', label: 'Analysis' },
  { id: 'demo', label: 'Demo' },
] as const
type Mode = (typeof MODES)[number]['id']

interface DriveData {
  trace: TrajPoint[]
  /** 退化 GNSS 流（散点画它、DR 递推用它）；隧道关闭且无 posmode 时与 trace 同引用 */
  gnssFeed: TrajPoint[]
  /** DR 增强后的轨迹（发给 HERE MM 的）；无退化时与 trace 同引用 */
  liveTrace: TrajPoint[]
  derived: DerivedPoint[]
  /** 逐帧 DR 漂移（本地 DR vs OXTS trace）：StatsPanel 的 DR Max Drift 数据源（全量/切片共用） */
  driftM: number[]
  entry: CacheEntry
}

/** 仿真隧道时长选项（秒）；0 = 关闭。轨迹/航向/速度全是真实 KITTI 数据，只有「拒止多久」是场景设定。 */
const TUNNEL_OPTIONS = [0, 30, 60, 120] as const

/** mapStatus（Step1 生命周期约定）：空 key 同步 fallback 不调 loader；非空异步定夺，pending 渲染加载占位 */
type MapStatus = 'pending' | 'ok' | 'fallback'

/** Step2 编排壳：Step1 数据流不动 + 双模式 tab + 回放时钟接线 */
export default function App() {
  // 渲染期读取（非模块顶层 const）：保证测试可经 vi.stubEnv 注入空 key，防 .env 真 key 固化
  const apikey = import.meta.env.VITE_HERE_KEY ?? ''

  const [driveId, setDriveId] = useState(DRIVE_IDS[0])
  const [tunnelS, setTunnelS] = useState(0) // 仿真隧道时长（0 = 关闭）
  const variant = tunnelS ? `t${tunnelS}` : '' // 缓存分档：请求体随隧道变，不分档会命中旧缓存
  const [reloadToken, setReloadToken] = useState(0) // 「清除缓存」后重载当前 driveId
  const [data, setData] = useState<DriveData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mapStatus, setMapStatus] = useState<MapStatus>(apikey ? 'pending' : 'fallback')
  const [mode, setMode] = useState<Mode>('analysis')

  // DR 渲染层：仅在有失锁时才渲染黄色 DR 路径（drPath）。DR 推算本身始终运行（liveTrace 已含 DR 结果）,
  // 但无失锁时 DR ≈ GNSS, drPath 与 GNSS 散点重合, 无渲染必要。
  // 门控两路：真实失锁（numsats≤4）+ 流内 noFix 帧（仿真隧道）。两者都无 → null → drPath 缺省不渲染。
  const dr = useMemo(() => {
    if (!data) return null
    const hasOutage =
      detectOutages(data.trace, 4).some(Boolean) || data.gnssFeed.some((p) => p.noFix)
    return hasOutage ? deadReckon(data.gnssFeed) : null
  }, [data])

  const lastIndex = data && data.trace.length > 0 ? data.trace.length - 1 : 0
  // 车标匹配轨道：MM 响应 → 到访序拼装 + 断口桥（绑路主路径；弧长来自 derived.trackArcM）
  const carTrack = useMemo(
    () => (data ? buildMatchedTrack(data.liveTrace, data.entry.response) : null),
    [data],
  )
  const pb = usePlayback(lastIndex) // 回放状态住在 App：tab 切换保留进度，换轨迹自动复位
  const scrubWasPlayingRef = useRef(false) // 拖动前是否在播放（松手据此续播）

  useEffect(() => {
    if (!apikey) return // 空 key：同步 fallback，loader 永不被调
    let cancelled = false
    loadHereMaps(apikey)
      // SDK 脚本到位 ≠ 瓦片能到达：企业网/VPN 可只放行 js.api.here.com 而静默拦截瓦片，
      // 那种情况会留一块无提示的白板（用户 2026-09-10 实测），故置 'ok' 前探一次瓦片链路
      .then(() => probeBasemap(apikey))
      .then((tilesOk) => {
        if (cancelled) return
        if (!tilesOk) console.warn('[hereLoader] 底图瓦片不可达（检查网络 / VPN）→ 落 SVG 兜底')
        setMapStatus(tilesOk ? 'ok' : 'fallback')
      })
      .catch((err: unknown) => {
        // Bug A 诊断埋点：浏览器控制台留下 loader 失败的真实原因（超时/网络/脚本错）
        console.warn('[hereLoader]', err instanceof Error ? err.message : err)
        if (!cancelled) setMapStatus('fallback') // 加载失败/超时/断网 → SVG 兜底
      })
    return () => {
      cancelled = true
    }
  }, [apikey])

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    setLoading(true)
    async function load(): Promise<void> {
      try {
        const traceRes = await fetch(`/sample/here/${driveId}.json`)
        if (!traceRes.ok) throw new Error(`trace load failed: ${driveId}`)
        const trace = (await traceRes.json()) as TrajPoint[]
        // DR 始终运行：无退化时 DR 在 1Hz GNSS 纠正间做 10Hz 插值，
        // 有退化时 DR 在失锁期自由递推。递推输入为 buildGnssFeed 的退化流（posmode==0 期冻结；
        // 无该列且隧道关闭时与 trace 同引用）。
        const gnssFeed = buildGnssFeed(trace, { tunnelDurationS: tunnelS || undefined })
        const drPositions = deadReckon(gnssFeed).positions
        const liveTrace = gnssFeed.map((p, i) => ({ ...p, lat: drPositions[i][0], lng: drPositions[i][1] }))
        // DR 漂移序列（StatsPanel 数据源）：drPositions 此处已算好，顺带一次 O(n)
        const driftM = driftSeries(trace, drPositions)
        const entry = await matchService(
          driveId,
          apikey ? { apikey, trace: liveTrace } : undefined,
          variant,
        )
        if (cancelled) return
        // 未缓存（fixture 的 derived 为空）→ 派生并回填缓存；
        // 旧缓存缺 trackArcM（车标轨道弧长）→ 同样重派生升级，渲染层无需感知版本
        let derived = entry.derived
        if (derived.length === 0 || derived[0]?.trackArcM === undefined) {
          derived = derive(liveTrace, entry.response)
          writeCache({ ...entry, derived }, variant)
        }
        setData({ trace, gnssFeed, liveTrace, derived, driftM, entry: { ...entry, derived } })
      } catch (e) {
        // live entry 可能已写缓存但 derive 失败（如坏 polyline）——驱逐防毒化：
        // 缓存命中短路会绕过 fixture 回落，直到手动清缓存（Step3 终审 minor 采纳）
        const cached = readCache(driveId, variant)
        if (cached?.source === 'live') localStorage.removeItem(cacheKey(driveId, variant))
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [driveId, reloadToken, tunnelS])

  /** 遍历 localStorage 删除 here-mm-cache:* 前缀键后重载当前 driveId */
  function handleClearCache(): void {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k !== null && k.startsWith('here-mm-cache:')) doomed.push(k)
    }
    for (const k of doomed) localStorage.removeItem(k)
    setReloadToken((t) => t + 1)
  }

  /** 「录制」（spec L50 顶栏三件套落点）：删当前 driveId 缓存并重载 → 缓存 miss 后走 live；
   *  live 失败自动落回 fixture（演示不中断）。仓库文件级回写归 scripts/record-fixtures.mjs。 */
  function handleRecord(): void {
    localStorage.removeItem(cacheKey(driveId, variant))
    setReloadToken((t) => t + 1)
  }

  /** 切回工程分析即暂停（静态分析态不该有后台播放）；进度与倍速保留 */
  function switchMode(m: Mode): void {
    if (m === 'analysis') pb.pause()
    setMode(m)
  }

  /** 拖动即暂停（评审 minor 采纳）：防播放中拖动被 rAF 时钟持续前推（5x 下松手落点漂移 ~50 点/秒）；
   *  松手时若拖动前在播放则续播——play() 会重置基线时间戳，续播无跳帧 */
  function handleScrubStart(): void {
    scrubWasPlayingRef.current = pb.playing
    pb.pause()
  }
  function handleScrubEnd(): void {
    if (scrubWasPlayingRef.current && pb.index < lastIndex) pb.play() // 终点松手不重启（审查 minor 采纳）
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '0.6rem 1.5rem',
          borderBottom: '1px solid #e5e7eb',
        }}
      >
        <h1 style={{ fontSize: '1.05rem', margin: 0 }}>HERE Map Matching POC</h1>
        <label htmlFor="drive-select" style={{ fontSize: 13, color: '#374151' }}>
          Trajectory
        </label>
        <select
          id="drive-select"
          value={driveId}
          onChange={(e) => setDriveId(e.target.value)}
          style={{ padding: '0.25rem 0.5rem' }}
        >
          {DRIVE_IDS.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        {/* 仿真隧道旋钮：口径必须写在界面上——数据全真，只有「GNSS 被拒止多久」是场景参数 */}
        <label
          htmlFor="tunnel-select"
          style={{ fontSize: 13, color: '#374151', marginLeft: '0.25rem' }}
          title="Simulation: GNSS denial duration. Trajectory / heading / speed are real KITTI data; only denial duration is a scenario parameter"
        >
          Tunnel
        </label>
        <select
          id="tunnel-select"
          value={tunnelS}
          onChange={(e) => setTunnelS(Number(e.target.value))}
          style={{ padding: '0.25rem 0.5rem' }}
          title="Simulation: GNSS denial duration (starts at 30% of trajectory length, truncated if it exceeds the end)"
        >
          {TUNNEL_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s === 0 ? 'Off' : `${s}s`}
            </option>
          ))}
        </select>
        {data && <SourceBadge source={data.entry.source} />}
        <div role="tablist" aria-label="View mode" style={{ display: 'flex', gap: 4, marginLeft: '0.75rem' }}>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              onClick={() => switchMode(m.id)}
              style={{
                padding: '0.3rem 0.9rem',
                cursor: 'pointer',
                borderRadius: 6,
                border: `1px solid ${mode === m.id ? '#2563eb' : '#e5e7eb'}`,
                background: mode === m.id ? '#2563eb' : '#ffffff',
                color: mode === m.id ? '#ffffff' : 'inherit',
                fontWeight: mode === m.id ? 700 : 400,
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
        {/* 右推容器（spec L50 顶栏三件套落点）：录制仅 apikey 非空渲染；无 key 时只剩清除缓存，
            布局与 Step2 一致（容器接管 marginLeft:'auto'，按钮自身不带） */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
          {apikey && (
            <button type="button" onClick={handleRecord} style={{ padding: '0.3rem 0.9rem', cursor: 'pointer' }}>
              Record
            </button>
          )}
          <button
            type="button"
            onClick={handleClearCache}
            style={{ padding: '0.3rem 0.9rem', cursor: 'pointer' }}
          >
            Clear Cache
          </button>
        </div>
      </header>

      <main style={{ flex: 1, display: 'flex', gap: '1rem', padding: '1rem 1.5rem', alignItems: 'stretch' }}>
        <section
          style={{
            flex: 1,
            minHeight: 520,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            overflow: 'hidden',
            background: '#f9fafb',
          }}
        >
          {error ? (
            <p style={{ color: '#dc2626', padding: '1rem' }}>Load failed: {error}</p>
          ) : loading && !data ? (
            <p style={{ color: '#6b7280', padding: '1rem' }}>Loading…</p>
          ) : mapStatus === 'pending' ? (
            <p style={{ color: '#6b7280', padding: '1rem' }}>Loading HERE map…</p>
          ) : data ? (
            <MapView
              trace={data.trace}
              derived={data.derived}
              mapStatus={mapStatus === 'ok' ? 'ok' : 'fallback'}
              apikey={apikey}
              upToIndex={mode === 'demo' ? pb.index : data.trace.length - 1}
              carPos={mode === 'demo' ? pb.pos : undefined}
              carTrace={data.liveTrace}
              carTrack={carTrack}
              drPath={mode === 'analysis' ? dr?.positions : undefined}
              showMm={mode === 'analysis'}
              gnssPath={data.gnssFeed}
              interactive={mode === 'analysis'}
            />
          ) : null}
        </section>
        <aside style={{ width: 380, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {mode === 'demo' && data ? (
            <>
              <StatsPanel
                trace={data.liveTrace}
                derived={data.derived}
                driftM={data.driftM}
                upToIndex={pb.index}
              />
              <DeviationReplayChart trace={data.liveTrace} derived={data.derived} index={pb.index} />
            </>
          ) : (
            <StatsPanel
              trace={data?.liveTrace ?? []}
              derived={data?.derived ?? []}
              driftM={data?.driftM ?? []}
            />
          )}
        </aside>
      </main>

      {mode === 'demo' && data && data.trace.length > 0 && (
        <ReplayBar
          index={pb.index}
          lastIndex={lastIndex}
          tSec={data.trace[Math.min(pb.index, lastIndex)].timestamp}
          totalSec={data.trace[lastIndex].timestamp}
          playing={pb.playing}
          speed={pb.speed}
          onToggle={pb.toggle}
          onSeek={pb.seek}
          onSpeed={pb.setSpeed}
          onScrubStart={handleScrubStart}
          onScrubEnd={handleScrubEnd}
        />
      )}

      <footer style={{ padding: '0.5rem 1.5rem', borderTop: '1px solid #e5e7eb', fontSize: 12, color: '#374151' }}>
        <strong>Data:</strong> KITTI (Geiger et al., 2013), CC BY-NC-SA · <strong>Map:</strong> HERE
      </footer>
    </div>
  )
}
