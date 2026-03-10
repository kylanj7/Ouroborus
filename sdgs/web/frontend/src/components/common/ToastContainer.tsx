import { X } from 'lucide-react'
import { useToastStore, Toast } from '../../store/toastStore'

const colorMap: Record<Toast['type'], { bg: string; border: string; text: string }> = {
  success: {
    bg: 'rgba(118, 185, 0, 0.1)',
    border: 'rgba(118, 185, 0, 0.3)',
    text: 'var(--accent-green)',
  },
  error: {
    bg: 'rgba(248, 81, 73, 0.1)',
    border: 'rgba(248, 81, 73, 0.3)',
    text: 'var(--status-failed)',
  },
  info: {
    bg: 'rgba(68, 147, 248, 0.1)',
    border: 'rgba(68, 147, 248, 0.3)',
    text: 'var(--accent-blue)',
  },
}

export default function ToastContainer() {
  const { toasts, removeToast } = useToastStore()

  if (toasts.length === 0) return null

  return (
    <div style={{
      position: 'fixed',
      top: '16px',
      right: '16px',
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      maxWidth: '400px',
    }}>
      {toasts.map((t) => {
        const c = colorMap[t.type]
        return (
          <div
            key={t.id}
            style={{
              background: c.bg,
              border: `1px solid ${c.border}`,
              borderRadius: 'var(--radius-sm)',
              padding: '10px 14px',
              color: c.text,
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '10px',
              animation: 'fadeIn 0.2s ease',
            }}
          >
            <span>{t.message}</span>
            <button
              onClick={() => removeToast(t.id)}
              style={{
                background: 'none',
                border: 'none',
                color: c.text,
                cursor: 'pointer',
                padding: '2px',
                display: 'flex',
                flexShrink: 0,
              }}
            >
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
