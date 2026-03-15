import { useEffect, useState, useCallback } from 'react'
import { createClosedLoopSSE } from '../api/sse'
import { useLoopStore } from '../store/loopStore'

const MAX_LOGS = 2000
const TRIM_TO = 1500

export function useLoopSSE() {
  const status = useLoopStore(state => state.status)
  const [logs, setLogs] = useState<string[]>([])
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (status !== 'running') return

    setDone(false)

    const close = createClosedLoopSSE(
      (msg: any) => {
        switch (msg.type) {
          case 'stage':
            if (msg.stage != null) {
              useLoopStore.getState().setCurrentStage(msg.stage)
            }
            if (msg.cycle != null) {
              useLoopStore.getState().setCurrentCycle(msg.cycle)
            }
            break

          case 'log':
            setLogs(prev => {
              const next = [...prev, msg.data ?? '']
              return next.length > MAX_LOGS ? next.slice(-TRIM_TO) : next
            })
            break

          case 'benchmark_scores':
            // Incoming benchmark_scores events are informational; cycle records
            // are fetched via fetchHistory. No store action needed here.
            break

          case 'tally_result':
            if (msg.data != null) {
              useLoopStore.getState().setTallyResult(
                typeof msg.data === 'object' ? msg.data : { raw: msg.data },
              )
            }
            break

          case 'gate_decision':
            useLoopStore.getState().showGateBanner({
              passed: msg.passed ?? false,
              delta: msg.delta ?? 0,
              cycle: msg.cycle ?? useLoopStore.getState().currentCycle,
              consecutiveFailures: msg.consecutive_failures ?? 0,
            })
            break

          case 'done':
            useLoopStore.getState().setStatus('idle')
            if (msg.stop_reason != null) {
              useLoopStore.getState().setStopReason(msg.stop_reason)
            }
            setDone(true)
            break
        }
      },
      () => {
        setDone(true)
      },
    )

    return () => close()
  }, [status])

  const clear = useCallback(() => {
    setLogs([])
    setDone(false)
  }, [])

  return { logs, done, clear }
}
