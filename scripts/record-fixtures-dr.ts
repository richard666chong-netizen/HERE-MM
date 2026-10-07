#!/usr/bin/env vite-node
/** Step5 服务器侧录制：按 **App live 路径同一条变换链** 录制 v8/import 响应——
 *  buildGnssFeed（失锁期冻在最后一帧有效定位）→ deadReckon（10Hz 递推 / 1Hz 纠回）→ buildImportRequest。
 *
 *  为什么不复用 record-fixtures.mjs：那个脚本直送原始 trace，而 App 的 live 路径对含失锁
 *  轨迹发的是 DR 增强 trace——用原始 trace 录 fixture 会让「有 key / 无 key」看到两条不同路线。
 *  这里由 vite-node 直接 import src 的真实模块，故不存在 py 复刻的参数漂移同步义务
 *  （0093 的 rerecord-0093-dr.py 正是为绕开 .mjs 无法 import TS 而写的复刻 + artifact 比对）。
 *
 *  产出（与 record-fixtures.mjs 同路径，不与之冲突——两者 DRIVES 集合不相交）：
 *    data/fixtures/<drive>_import_{req,resp}.json   请求/响应留痕（gitignored）
 *    public/fixtures/<drive>.json                   CacheEntry 包装（source:'mock'，入库）
 *
 *  用法：
 *    npx vite-node scripts/record-fixtures-dr.ts <driveId> [driveId ...] [--compare]
 *    --compare 额外把「失锁期未增强的冻结流」也发一次，量化 DR 增强对绑路的作用（只打印，不落盘）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deadReckon } from '../src/lib/deadReckoning'
import { buildGnssFeed } from '../src/lib/gnssFeed'
import { buildImportRequest } from '../src/lib/hereRouterClient'
import type { CacheEntry, ImportResponse, TrajPoint } from '../src/types'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function readKey(): string {
  const env = readFileSync(join(ROOT, '.env'), 'utf8')
  const m = env.match(/^VITE_HERE_KEY=(.*)$/m)
  if (!m || !m[1].trim()) throw new Error('VITE_HERE_KEY missing in .env')
  return m[1].trim()
}

/** 与 src/lib/hereRouterClient.ts 的 importRoute 同 URL（改动需两处同步） */
async function importTrace(apikey: string, trace: TrajPoint[]): Promise<ImportResponse> {
  const url = `https://router.hereapi.com/v8/import?return=polyline,summary&transportMode=car&apikey=${encodeURIComponent(apikey)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trace: buildImportRequest(trace) }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as ImportResponse
  const sections = body?.routes?.[0]?.sections
  if (!Array.isArray(sections) || sections.length === 0) {
    // HERE 拒绝请求时也返回 HTTP 200：notices 是唯一线索，必须打出来才可诊断
    throw new Error(`invalid response shape: ${JSON.stringify(body).slice(0, 400)}`)
  }
  return body
}

const summarize = (resp: ImportResponse): string => {
  const sections = resp.routes[0].sections
  return `${sections.length} section(s) / ${sections.reduce((a, s) => a + (s.summary?.length ?? 0), 0)} m`
}

const argv = process.argv.slice(2)
const compare = argv.includes('--compare')
const tIdx = argv.indexOf('--tunnel')
const tunnelS = tIdx >= 0 ? Number(argv[tIdx + 1]) : 60 // 仿真隧道时长；缺省按演示配置 60s 录
if (tIdx >= 0 && !Number.isFinite(tunnelS)) {
  console.error('--tunnel 需要一个秒数，如 --tunnel 60')
  process.exit(2)
}
const skip = new Set(['--compare', '--tunnel', tIdx >= 0 ? argv[tIdx + 1] : ''])
const drives = argv.filter((a) => !a.startsWith('--') && !skip.has(a))
if (drives.length === 0) {
  console.error(
    'usage: npx vite-node scripts/record-fixtures-dr.ts <driveId> [...] [--tunnel 秒] [--compare]',
  )
  process.exit(2)
}

const apikey = readKey()
mkdirSync(join(ROOT, 'data/fixtures'), { recursive: true })
let failed = 0

for (const driveId of drives) {
  const trace = JSON.parse(
    readFileSync(join(ROOT, `public/sample/here/${driveId}.json`), 'utf8'),
  ) as TrajPoint[]
  try {
    const feed = buildGnssFeed(trace, { tunnelDurationS: tunnelS || undefined })
    const staleCount = feed.filter((p, i) => p.lat !== trace[i].lat || p.lng !== trace[i].lng).length
    const drPositions = deadReckon(feed).positions
    const augmented = feed.map((p, i) => ({ ...p, lat: drPositions[i][0], lng: drPositions[i][1] }))

    const resp = await importTrace(apikey, augmented)
    const suffix = tunnelS ? `-t${tunnelS}` : ''
    const fixturePath = join(ROOT, `public/fixtures/${driveId}${suffix}.json`)
    writeFileSync(
      join(ROOT, `data/fixtures/${driveId}_import_req.json`),
      JSON.stringify({ trace: buildImportRequest(augmented) }),
    )
    writeFileSync(join(ROOT, `data/fixtures/${driveId}_import_resp.json`), JSON.stringify(resp))

    let prev = ''
    try {
      const committed = JSON.parse(readFileSync(fixturePath, 'utf8')) as CacheEntry
      prev = ` | 原 fixture: ${summarize(committed.response)}`
    } catch {
      prev = ' | 无已提交 fixture'
    }
    const entry: CacheEntry = {
      driveId,
      source: 'mock',
      createdAt: new Date().toISOString(),
      response: resp,
      derived: [],
    }
    writeFileSync(fixturePath, JSON.stringify(entry, null, 2))
    console.log(
      `${driveId}${tunnelS ? `（仿真隧道 ${tunnelS}s）` : ''}: 冻结 ${staleCount}/${trace.length} 帧` +
        ` → DR 增强 ${summarize(resp)}${prev}`,
    )

    if (compare) {
      // 「失锁期未增强」对照：直接把冻结流（GNSS 无解期位置不动）送去绑路。
      // 全程失锁的轨迹（0106）冻结流是同一个点重复 N 次 → HERE 无法成路，属预期，不计失败。
      try {
        console.log(`  └ 对照（冻结流未增强）: ${summarize(await importTrace(apikey, feed))}`)
      } catch (e) {
        console.log(`  └ 对照（冻结流未增强）: 无有效路线（${e instanceof Error ? e.message : e}）`)
      }
    }
  } catch (e) {
    failed++
    console.error(`${driveId}: FAILED (${e instanceof Error ? e.message : e}) — 旧录制保留，未覆盖`)
  }
}

if (failed) process.exit(1)
