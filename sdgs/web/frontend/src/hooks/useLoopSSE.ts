import { useEffect, useRef, useState, useCallback } from 'react'
import { createLoopSSE, LoopSSEMessage } from '../api/sse'

export interface LoopMetrics {
  evolution: number
  overall_score: number
  factual_accuracy: number
  completeness: number
  technical_precision: number
  best_score_so_far: number
  delta_from_previous: number
  target_reached: boolean
  domain_scores: Record<string, Record<string, number>>
}

export function useLoopSSE(loopId: string | null) {
  const [logs, setLogs] = useState<string[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [evolution, setEvolution] = useState<number>(0)
  const [metrics, setMetrics] = useState<LoopMetrics[]>([])
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  const [stopReason, setStopReason] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const closeRef = useRef<(() => void) | null>(null)
  const prevIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!loopId) return

    if (prevIdRef.current !== loopId) {
      setLogs([])
      setStatus(null)
      setStage(null)
      setEvolution(0)
      setMetrics([])
      setConfig(null)
      setStopReason(null)
      setDone(false)
      prevIdRef.current = loopId
    }

    const close = createLoopSSE(
      loopId,
      (msg: LoopSSEMessage) => {
        switch (msg.type) {
          case 'log':
            setLogs(prev => {
              const next = [...prev, msg.data ?? '']
              return next.length > 2000 ? next.slice(-1500) : next
            })
            break
          case 'status':
            setStatus(msg.data ?? null)
            break
          case 'stage':
            setStage(msg.stage ?? null)
            if (msg.evolution) setEvolution(msg.evolution)
            break
          case 'metrics':
            setMetrics(prev => [...prev, {
              evolution: msg.evolution ?? 0,
              overall_score: msg.overall_score ?? 0,
              factual_accuracy: msg.factual_accuracy ?? 0,
              completeness: msg.completeness ?? 0,
              technical_precision: msg.technical_precision ?? 0,
              best_score_so_far: msg.best_score_so_far ?? 0,
              delta_from_previous: msg.delta_from_previous ?? 0,
              target_reached: msg.target_reached ?? false,
              domain_scores: msg.domain_scores ?? {},
            }])
            break
          case 'config':
            setConfig(msg.data as unknown as Record<string, unknown> ?? null)
            break
          case 'error':
            setLogs(prev => {
              const next = [...prev, `ERROR: ${msg.data ?? 'Unknown error'}`]
              return next.length > 2000 ? next.slice(-1500) : next
            })
            break
          case 'done':
            setStopReason(msg.stop_reason ?? null)
            break
        }
      },
      () => setDone(true),
    )
    closeRef.current = close

    return () => close()
  }, [loopId])

  const clear = useCallback(() => {
    setLogs([])
    setStatus(null)
    setStage(null)
    setEvolution(0)
    setMetrics([])
    setConfig(null)
    setStopReason(null)
    setDone(false)
  }, [])

  return { logs, status, stage, evolution, metrics, config, stopReason, done, clear }
}
