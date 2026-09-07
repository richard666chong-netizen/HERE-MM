const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** HERE flexible polyline 解码（忽略可选第三维）。纯函数、无依赖。 */
export function decodeFlexiblePolyline(encoded: string): Array<[number, number]> {
  const charIdx = (c: string) => {
    const i = CHARSET.indexOf(c)
    if (i < 0) throw new Error(`invalid char: ${c}`)
    return i
  }

  let i = 0
  /** 裸 varint：低 5 位数据 + 0x20 延续位，小端拼接。不做 zigzag。 */
  const readVarintRaw = (): number => {
    let value = 0n, shift = 0n
    for (;;) {
      if (i >= encoded.length) throw new Error('truncated varint')
      const c = charIdx(encoded[i++])
      value |= BigInt(c & 0b11111) << shift
      if ((c & 0b100000) === 0) break
      shift += 5n
    }
    return Number(value)
  }
  const zigzag = (v: number) => (v >>> 1) ^ -(v & 1)

  const version = readVarintRaw()          // header 版本（v1 = 'B'），无 zigzag
  if (version !== 1) throw new Error(`unsupported version: ${version}`)
  const content = readVarintRaw()          // header 内容，varint（可能占 2 字符），无 zigzag
  const precision = content & 0xf
  const thirdDimType = (content >> 4) & 0b111
  const step = thirdDimType === 0 ? 2 : 3  // 有第三维时每坐标 3 个 varint

  const deltas: number[] = []
  while (i < encoded.length) deltas.push(zigzag(readVarintRaw()))

  const scale = 10 ** precision
  const out: Array<[number, number]> = []
  let lat = 0, lng = 0
  for (let k = 0; k + step - 1 < deltas.length; k += step) {
    lat += deltas[k]
    lng += deltas[k + 1]
    out.push([lat / scale, lng / scale])
  }
  return out
}
