export interface SSEMessage {
  type: 'log' | 'status' | 'error' | 'done'
  data: string
}

export interface LoopSSEMessage {
  type: 'log' | 'status' | 'error' | 'done' | 'stage' | 'metrics' | 'config'
  data?: string
  stage?: string
  evolution?: number
  stop_reason?: string
  // metrics fields
  overall_score?: number
  factual_accuracy?: number
  completeness?: number
  technical_precision?: number
  best_score_so_far?: number
  delta_from_previous?: number
  target_reached?: boolean
  domain_scores?: Record<string, Record<string, number>>
}

function createSSEWithBackoff<T>(
  url: string,
  onMessage: (msg: T) => void,
  onDone?: () => void,
): () => void {
  let lastEventId = 0
  let reconnectTimer: number | null = null
  let eventSource: EventSource | null = null
  let closed = false
  let retryCount = 0

  function connect(fromId: number) {
    if (closed) return

    const fullUrl = `${url}${url.includes('?') ? '&' : '?'}last_id=${fromId}`
    eventSource = new EventSource(fullUrl)

    eventSource.onopen = () => {
      retryCount = 0
    }

    eventSource.onmessage = (event) => {
      if (event.lastEventId) {
        lastEventId = parseInt(event.lastEventId, 10) + 1
      }
      try {
        const msg: T = JSON.parse(event.data)
        onMessage(msg)
        if ((msg as any).type === 'done') {
          cleanup()
          onDone?.()
        }
      } catch {
        // ignore parse errors
      }
    }

    eventSource.onerror = () => {
      if (closed) return
      eventSource?.close()
      // Exponential backoff: 2s, 4s, 8s, 16s, max 30s
      const delay = Math.min(2000 * Math.pow(2, retryCount), 30000)
      retryCount++
      reconnectTimer = window.setTimeout(() => {
        connect(lastEventId)
      }, delay)
    }
  }

  function cleanup() {
    closed = true
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    eventSource?.close()
    eventSource = null
  }

  connect(0)

  return cleanup
}

export function createDatasetSSE(
  datasetId: number,
  onMessage: (msg: SSEMessage) => void,
  onDone?: () => void,
): () => void {
  return createSSEWithBackoff<SSEMessage>(
    `/api/events/datasets/${datasetId}`,
    onMessage,
    onDone,
  )
}

export function createTrainingSSE(
  runId: number,
  onMessage: (msg: SSEMessage) => void,
  onDone?: () => void,
): () => void {
  return createSSEWithBackoff<SSEMessage>(
    `/api/events/training/${runId}`,
    onMessage,
    onDone,
  )
}

export function createLoopSSE(
  loopId: string,
  onMessage: (msg: LoopSSEMessage) => void,
  onDone?: () => void,
): () => void {
  return createSSEWithBackoff<LoopSSEMessage>(
    `/api/events/loop/${loopId}`,
    onMessage,
    onDone,
  )
}
