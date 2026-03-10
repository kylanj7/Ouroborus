import { useEffect, useRef, useState, useCallback } from 'react'
import { createTrainingSSE } from '../api/sse'

export interface MetricPoint {
  step: number
  loss: number | null
  learning_rate: number | null
  grad_norm: number | null
  epoch: number
}

export function useTrainingSSE(runId: number | null) {
  const [logs, setLogs] = useState<string[]>([])
  const [metrics, setMetrics] = useState<MetricPoint[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const closeRef = useRef<(() => void) | null>(null)
  const prevIdRef = useRef<number | null>(null)

  useEffect(() => {
    if (!runId) return

    if (prevIdRef.current !== runId) {
      setLogs([])
      setMetrics([])
      setStatus(null)
      setDone(false)
      prevIdRef.current = runId
    }

    const close = createTrainingSSE(
      runId,
      (msg: Record<string, unknown>) => {
        const type = msg.type as string
        if (type === 'log') {
          setLogs(prev => [...prev, msg.data as string])
        } else if (type === 'status') {
          setStatus(msg.data as string)
        } else if (type === 'error') {
          setLogs(prev => [...prev, `ERROR: ${msg.data}`])
        } else if (type === 'metric') {
          setMetrics(prev => [...prev, {
            step: (msg.step as number) || 0,
            loss: (msg.loss as number) ?? null,
            learning_rate: (msg.learning_rate as number) ?? null,
            grad_norm: (msg.grad_norm as number) ?? null,
            epoch: (msg.epoch as number) || 0,
          }])
          if (msg.monologue) {
            setLogs(prev => [...prev, msg.monologue as string])
          }
        } else if (type === 'complete') {
          if (msg.monologue) {
            setLogs(prev => [...prev, msg.monologue as string])
          }
        }
      },
      () => setDone(true),
    )
    closeRef.current = close

    return () => close()
  }, [runId])

  const clear = useCallback(() => {
    setLogs([])
    setMetrics([])
    setStatus(null)
    setDone(false)
  }, [])

  return { logs, metrics, status, done, clear }
}
