import { useEffect, useRef, useState } from 'react'
import DeviationReplayChart from './components/DeviationReplayChart'
import MapView from './components/MapView'
import ReplayBar from './components/ReplayBar'
import SourceBadge from './components/SourceBadge'
import StatsPanel from './components/StatsPanel'
import { usePlayback } from './hooks/usePlayback'
import { derive } from './lib/derive'
import { cacheKey, matchService, readCache, writeCache } from './lib/fixtureStore'
import { loadHereMaps } from './lib/hereLoader'
import type { CacheEntry, DerivedPoint, TrajPoint } from './types'

const DRIVE_IDS = ['2011_09_30_drive_0033', '2011_09_26_drive_0011'] // 顶栏下拉顺序 0033/0011

// spec L45 双模式：工程分析（静态对比）/ 客户演示（回放）
const MODES = [
  { id: 'analysis', label: '工程分析模式' },
  { id: 'demo', label: '客户演示模式' },
] as const
type Mode = (typeof MODES)[number]['id']

interface DriveData {
  trace: TrajPoint[]
  derived: DerivedPoint[]
  entry: CacheEntry
}

/** mapStatus（Step1 生命周期约定）：空 key 同步 fallback 不调 loader；非空异步定夺，pending 渲染加载占位 */
type MapStatus = 'pending' | 'ok' | 'fallback'

/** Step2 编排壳：Step1 数据流不动 + 双模式 tab + 回放时钟接线 */
export default function App() {
  // 渲染期读取（非模块顶层 const）：保证测试可经 vi.stubEnv 注入空 key，防 .env 真 key 固化
  const apikey = import.meta.env.VITE_HERE_KEY ?? ''

  const [driveId, setDriveId] = useState(DRIVE_IDS[0])
  const [reloadToken, setReloadToken] = useState(0) // 「清除缓存」后重载当前 driveId
  const [data, setData] = useState<DriveData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mapStatus, setMapStatus] = useState<MapStatus>(apikey ? 'pending' : 'fallback')
  const [mode, setMode] = useState<Mode>('analysis')

  const lastIndex = data && data.trace.length > 0 ? data.trace.length - 1 : 0
  const pb = usePlayback(lastIndex) // 回放状态住在 App：tab 切换保留进度，换轨迹自动复位
  const scrubWasPlayingRef = useRef(false) // 拖动前是否在播放（松手据此续播）

  useEffect(() => {
    if (!apikey) return // 空 key：同步 fallback，loader 永不被调
    let cancelled = false
    loadHereMaps(apikey)
      .then(() => {
        if (!cancelled) setMapStatus('ok')
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
        const entry = await matchService(driveId, apikey ? { apikey, trace } : undefined)
        if (cancelled) return
        // 未缓存（fixture 的 derived 为空）→ 派生并回填缓存
        let derived = entry.derived
        if (derived.length === 0) {
          derived = derive(trace, entry.response)
          writeCache({ ...entry, derived })
        }
        setData({ trace, derived, entry: { ...entry, derived } })
      } catch (e) {
        // live entry 可能已写缓存但 derive 失败（如坏 polyline）——驱逐防毒化：
        // 缓存命中短路会绕过 fixture 回落，直到手动清缓存（Step3 终审 minor 采纳）
        const cached = readCache(driveId)
        if (cached?.source === 'live') localStorage.removeItem(cacheKey(driveId))
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [driveId, reloadToken])

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
    localStorage.removeItem(cacheKey(driveId))
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
          轨迹
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
        {data && <SourceBadge source={data.entry.source} />}
        <div role="tablist" aria-label="查看模式" style={{ display: 'flex', gap: 4, marginLeft: '0.75rem' }}>
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
                border: '1px solid #e5e7eb',
                background: mode === m.id ? '#eff6ff' : '#ffffff',
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
              录制
            </button>
          )}
          <button
            type="button"
            onClick={handleClearCache}
            style={{ padding: '0.3rem 0.9rem', cursor: 'pointer' }}
          >
            清除缓存
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
            <p style={{ color: '#dc2626', padding: '1rem' }}>加载失败: {error}</p>
          ) : loading && !data ? (
            <p style={{ color: '#6b7280', padding: '1rem' }}>加载中…</p>
          ) : mapStatus === 'pending' ? (
            <p style={{ color: '#6b7280', padding: '1rem' }}>正在加载 HERE 地图…</p>
          ) : data ? (
            <MapView
              trace={data.trace}
              derived={data.derived}
              mapStatus={mapStatus === 'ok' ? 'ok' : 'fallback'}
              apikey={apikey}
              /* 分析模式传全量下标 → 同一喷洒路径一次洒满，HERE 地图实例跨 tab 复用不重建 */
              upToIndex={mode === 'demo' ? pb.index : data.trace.length - 1}
              carIndex={mode === 'demo' ? pb.index : undefined}
            />
          ) : null}
        </section>
        <aside style={{ width: 380, flexShrink: 0 }}>
          {mode === 'analysis' ? (
            <StatsPanel trace={data?.trace ?? []} derived={data?.derived ?? []} />
          ) : data ? (
            <DeviationReplayChart trace={data.trace} derived={data.derived} index={pb.index} />
          ) : null}
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

      <footer style={{ padding: '0.5rem 1.5rem', borderTop: '1px solid #e5e7eb', fontSize: 12, color: '#6b7280' }}>
        Data: KITTI (Geiger et al., 2013), CC BY-NC-SA · Map: HERE
      </footer>
    </div>
  )
}
