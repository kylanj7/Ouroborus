import { useEffect } from 'react'

interface GateBannerData {
  passed: boolean
  delta: number
  cycle: number
  consecutiveFailures: number
}

interface GateBannerProps {
  data: GateBannerData | null
  onDismiss: () => void
}

export default function GateBanner({ data, onDismiss }: GateBannerProps) {
  useEffect(() => {
    if (!data) return
    const timer = setTimeout(onDismiss, 10000)
    return () => clearTimeout(timer)
  }, [data, onDismiss])

  if (!data) return null

  const { passed, delta, cycle, consecutiveFailures } = data
  const isFailCap = !passed && consecutiveFailures >= 3

  let background: string
  let text: string
  const baseVersion = cycle

  if (passed) {
    background = '#10b981'
    const deltaStr = delta >= 0 ? `+${delta.toFixed(1)}` : `${delta.toFixed(1)}`
    text = `GATE PASSED ${deltaStr}pp -- merged as Base v${baseVersion}`
  } else if (isFailCap) {
    background = '#f59e0b'
    text = 'FAIL CAP REACHED -- loop stopped'
  } else {
    background = '#ef4444'
    const deltaStr = delta >= 0 ? `+${delta.toFixed(1)}` : `${delta.toFixed(1)}`
    text = `GATE FAILED ${deltaStr}pp -- rolled back (failure ${consecutiveFailures}/3)`
  }

  return (
    <>
      <style>{`
        @keyframes gateBannerSlideIn {
          from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
      <div
        style={{
          position: 'fixed',
          top: 80,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 1000,
          maxWidth: 600,
          width: '90vw',
          background,
          color: '#ffffff',
          borderRadius: 8,
          padding: '14px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          boxShadow: '0 4px 24px rgba(0, 0, 0, 0.4)',
          animation: 'gateBannerSlideIn 0.25s ease-out forwards',
          cursor: 'default',
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.02em' }}>{text}</span>
        <button
          onClick={onDismiss}
          style={{
            background: 'rgba(255, 255, 255, 0.25)',
            border: 'none',
            color: '#ffffff',
            borderRadius: 4,
            padding: '4px 10px',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          Dismiss
        </button>
      </div>
    </>
  )
}
