export interface ReplayBarProps {
  index: number
  lastIndex: number
  tSec: number
  totalSec: number
  playing: boolean
  speed: 1 | 2 | 5
  onToggle(): void
  onSeek(i: number): void
  onSpeed(s: 1 | 2 | 5): void
  /** 拖动起止：App 据此暂停/续播（防播放中拖动被 rAF 前推漂移） */
  onScrubStart(): void
  onScrubEnd(): void
}

const SPEEDS: ReadonlyArray<1 | 2 | 5> = [1, 2, 5]

/** 回放控制条（spec L48）：播放/暂停 + 倍速 1x/2x/5x + 进度拖动（拖动即暂停） + 时间读数 */
export default function ReplayBar({
  index,
  lastIndex,
  tSec,
  totalSec,
  playing,
  speed,
  onToggle,
  onSeek,
  onSpeed,
  onScrubStart,
  onScrubEnd,
}: ReplayBarProps) {
  return (
    <div
      data-testid="replay-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.5rem 1.5rem',
        borderTop: '1px solid #e5e7eb',
      }}
    >
      <button
        type="button"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={onToggle}
        style={{ fontSize: 16, padding: '0.3rem 0.9rem', cursor: 'pointer' }}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <div role="group" aria-label="Speed" style={{ display: 'flex', gap: 4 }}>
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={speed === s}
            onClick={() => onSpeed(s)}
            style={{
              padding: '0.3rem 0.6rem',
              cursor: 'pointer',
              fontWeight: speed === s ? 700 : 400,
              border: '1px solid #e5e7eb',
              borderRadius: 6,
              background: speed === s ? '#eff6ff' : '#ffffff',
            }}
          >
            {s}x
          </button>
        ))}
      </div>
      <input
        type="range"
        aria-label="Progress"
        min={0}
        max={lastIndex}
        value={index}
        onPointerDown={onScrubStart}
        onPointerUp={onScrubEnd}
        onChange={(e) => onSeek(Number(e.target.value))}
        style={{ flex: 1 }}
      />
      <span
        data-testid="replay-time"
        style={{ fontSize: 13, color: '#374151', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
      >
        {tSec.toFixed(1)}s / {totalSec.toFixed(1)}s
      </span>
    </div>
  )
}
