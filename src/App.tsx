import { useEffect, useState } from 'react'
import MapView from './components/MapView'
import SourceBadge from './components/SourceBadge'
import StatsPanel from './components/StatsPanel'
import { derive } from './lib/derive'
import { matchService, writeCache } from './lib/fixtureStore'
import { loadHereMaps } from './lib/hereLoader'
import type { CacheEntry, DerivedPoint, TrajPoint } from './types'

const DRIVE_IDS = ['2011_09_30_drive_0033', '2011_09_26_drive_0011'] // 顶栏下拉顺序 0033/0011

interface DriveData {
  trace: TrajPoint[]
  derived: DerivedPoint[]
  entry: CacheEntry
}

/** mapStatus（T7 生命周期约定在 App 落实）：空 key 同步 fallback 不调 loader；非空异步定夺，pending 渲染加载占位 */
type MapStatus = 'pending' | 'ok' | 'fallback'

/** Step1 编排壳：选 driveId → 取 trace + matchService entry → 未缓存则 derive 并回填 → 双线对比 + 偏差统计 */
export default function App() {
  // 渲染期读取（非模块顶层 const）：保证测试可经 vi.stubEnv 注入空 key，防 .env 真 key 固化
  const apikey = import.meta.env.VITE_HERE_KEY ?? ''

  const [driveId, setDriveId] = useState(DRIVE_IDS[0])
  const [reloadToken, setReloadToken] = useState(0) // 「清除缓存」后重载当前 driveId
  const [data, setData] = useState<DriveData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mapStatus, setMapStatus] = useState<MapStatus>(apikey ? 'pending' : 'fallback')

  useEffect(() => {
    if (!apikey) return // 空 key：同步 fallback，loader 永不被调
    let cancelled = false
    loadHereMaps(apikey)
      .then(() => {
        if (!cancelled) setMapStatus('ok')
      })
      .catch(() => {
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
        const entry = await matchService(driveId)
        if (cancelled) return
        // 未缓存（fixture 的 derived 为空）→ 派生并回填缓存
        let derived = entry.derived
        if (derived.length === 0) {
          derived = derive(trace, entry.response)
          writeCache({ ...entry, derived })
        }
        setData({ trace, derived, entry: { ...entry, derived } })
      } catch (e) {
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

  /** 遍历 localStorage 删除 here-mm-cache:* 前缀键后重载当前 driveId（spec 顶栏三件套的「清除」落点） */
  function handleClearCache(): void {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k !== null && k.startsWith('here-mm-cache:')) doomed.push(k)
    }
    for (const k of doomed) localStorage.removeItem(k)
    setReloadToken((t) => t + 1)
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
        <button
          type="button"
          onClick={handleClearCache}
          style={{ marginLeft: 'auto', padding: '0.3rem 0.9rem', cursor: 'pointer' }}
        >
          清除缓存
        </button>
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
            />
          ) : null}
        </section>
        <aside style={{ width: 380, flexShrink: 0 }}>
          <StatsPanel trace={data?.trace ?? []} derived={data?.derived ?? []} />
        </aside>
      </main>

      <footer style={{ padding: '0.5rem 1.5rem', borderTop: '1px solid #e5e7eb', fontSize: 12, color: '#6b7280' }}>
        Data: KITTI (Geiger et al., 2013), CC BY-NC-SA · Map: HERE
      </footer>
    </div>
  )
}
