export interface SourceBadgeProps {
  source: 'live' | 'mock'
}

const BADGES: Record<'live' | 'mock', { label: string; background: string; color: string }> = {
  mock: { label: 'MOCK', background: '#fef3c7', color: '#92400e' },
  live: { label: 'LIVE', background: '#dcfce7', color: '#166534' },
}

/** 数据源角标：MOCK = 缓存/fixture；LIVE = Step3 live 调用（此处仅预留渲染） */
export default function SourceBadge({ source }: SourceBadgeProps) {
  const b = BADGES[source]
  return (
    <span
      data-testid="source-badge"
      style={{
        background: b.background,
        color: b.color,
        fontSize: 12,
        fontWeight: 700,
        padding: '0.15rem 0.5rem',
        borderRadius: 999,
        letterSpacing: 0.5,
      }}
    >
      {b.label}
    </span>
  )
}
