import { useState, useRef, useEffect } from 'react'
import { Info } from 'lucide-react'

interface InfoTipProps {
  text: string
}

export default function InfoTip({ text }: InfoTipProps) {
  const [show, setShow] = useState(false)
  const [above, setAbove] = useState(false)
  const iconRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (show && iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect()
      setAbove(rect.top > 160)
    }
  }, [show])

  return (
    <span
      ref={iconRef}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', marginLeft: 4, cursor: 'help' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <Info size={12} style={{ color: 'var(--text-muted)', opacity: 0.6 }} />
      {show && (
        <span style={{
          position: 'absolute',
          left: '50%',
          transform: 'translateX(-50%)',
          ...(above ? { bottom: 20 } : { top: 20 }),
          width: 220,
          padding: '8px 10px',
          borderRadius: 8,
          background: 'rgba(15, 23, 42, 0.95)',
          border: '1px solid var(--border-color)',
          color: 'var(--text-secondary)',
          fontSize: 11,
          lineHeight: 1.5,
          zIndex: 1000,
          pointerEvents: 'none',
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          whiteSpace: 'normal',
          textTransform: 'none',
          letterSpacing: 'normal',
          fontWeight: 400,
        }}>
          {text}
        </span>
      )}
    </span>
  )
}
