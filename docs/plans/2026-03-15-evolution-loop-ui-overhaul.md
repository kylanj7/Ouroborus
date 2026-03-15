# Evolution Loop UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Evolution Loop page with a new interface reflecting the 8-stage closed-loop training system, backed by new API endpoints that talk directly to the closed-loop orchestrator.

**Architecture:** New FastAPI router (`closed_loop.py`) + service layer (`closed_loop_service.py`) handle start/stop/status/history/SSE. Frontend gets 5 new components (StagePipeline, BenchmarkChart, TallyDiagnosis, GateBanner, CycleHistory), a rewritten Loop page, updated store, SSE hook, and API client. Follows existing patterns: BroadcastQueue for SSE, Zustand stores, auth via `get_current_user`.

**Tech Stack:** Python/FastAPI (backend), React/TypeScript/Zustand/Recharts (frontend)

**Spec:** `docs/specs/2026-03-15-evolution-loop-ui-overhaul-design.md`

---

## File Structure

### New Backend Files
| File | Responsibility |
|------|---------------|
| `sdgs/web/routers/closed_loop.py` | REST + SSE endpoints for closed-loop (start, stop, status, history, events) |
| `sdgs/web/services/closed_loop_service.py` | Background orchestrator execution, SSE event emission |

### New Frontend Files
| File | Responsibility |
|------|---------------|
| `src/components/loop/StagePipeline.tsx` | Horizontal 8-stage strip |
| `src/components/loop/BenchmarkChart.tsx` | Recharts multi-line score chart |
| `src/components/loop/TallyDiagnosis.tsx` | Cluster detail cards |
| `src/components/loop/GateBanner.tsx` | Floating gate pass/fail notification |
| `src/components/loop/CycleHistory.tsx` | Cycle metrics table |

### Modified Files
| File | Change |
|------|--------|
| `sdgs/web/app.py` | Register closed_loop router |
| `src/pages/Loop.tsx` | Complete rewrite |
| `src/store/loopStore.ts` | New state shape for closed-loop |
| `src/hooks/useLoopSSE.ts` | New event types |
| `src/api/client.ts` | New endpoint functions |
| `src/api/sse.ts` | New SSE factory for closed-loop |

---

## Task 1: Backend service layer

**Files:**
- Create: `sdgs/web/services/closed_loop_service.py`

- [ ] **Step 1: Implement the service**

This service manages the orchestrator lifecycle and SSE broadcasting. It follows the existing `job_runner.py` pattern.

```python
# sdgs/web/services/closed_loop_service.py
"""Background closed-loop orchestrator execution with SSE broadcasting."""
import logging
import queue
import threading
import uuid
from typing import Any

from sdgs.loop.config_v2 import load_closed_loop_config
from sdgs.loop.orchestrator_v2 import ClosedLoopOrchestrator
from sdgs.loop.state_v2 import LoopStateStore

logger = logging.getLogger(__name__)

_cl_queues: dict[str, queue.Queue] = {}
_cl_logs: dict[str, list[dict]] = {}
_cl_lock = threading.Lock()
_active_loop_id: str | None = None


def init_cl_stream(loop_id: str):
    with _cl_lock:
        _cl_queues[loop_id] = queue.Queue()
        _cl_logs[loop_id] = []


def emit_cl_event(loop_id: str, event: dict):
    with _cl_lock:
        if loop_id in _cl_logs:
            event["id"] = len(_cl_logs[loop_id])
            _cl_logs[loop_id].append(event)
        if loop_id in _cl_queues:
            _cl_queues[loop_id].put(event)


def finish_cl_stream(loop_id: str):
    with _cl_lock:
        if loop_id in _cl_queues:
            _cl_queues[loop_id].put(None)  # sentinel


def get_cl_queue(loop_id: str) -> queue.Queue | None:
    with _cl_lock:
        return _cl_queues.get(loop_id)


def get_cl_logs(loop_id: str) -> list[dict]:
    with _cl_lock:
        return list(_cl_logs.get(loop_id, []))


def get_active_loop_id() -> str | None:
    return _active_loop_id


def start_closed_loop(config_path: str | None = None) -> str:
    """Start a closed-loop run in a background thread. Returns loop_id."""
    global _active_loop_id

    if _active_loop_id is not None:
        # Check if it's actually still running
        store = LoopStateStore()
        active = store.get_active_loop()
        store.close()
        if active:
            raise RuntimeError("A closed-loop is already running")
        _active_loop_id = None

    loop_id = f"cl-{uuid.uuid4().hex[:8]}"
    _active_loop_id = loop_id
    init_cl_stream(loop_id)

    config = load_closed_loop_config(config_path)

    def _run():
        global _active_loop_id
        try:
            orch = ClosedLoopOrchestrator(config=config)

            # Hook into orchestrator logging to emit SSE events
            handler = _SSELogHandler(loop_id)
            logging.getLogger("sdgs.loop").addHandler(handler)

            try:
                orch.run(loop_id=loop_id)
            finally:
                logging.getLogger("sdgs.loop").removeHandler(handler)

            # Emit done event
            store = LoopStateStore()
            state = store.get_loop(loop_id)
            store.close()
            emit_cl_event(loop_id, {
                "type": "done",
                "loop_id": loop_id,
                "stop_reason": state.stop_reason.value if state and state.stop_reason else None,
            })
        except Exception as e:
            logger.error("Closed-loop %s failed: %s", loop_id, e)
            emit_cl_event(loop_id, {"type": "done", "loop_id": loop_id, "stop_reason": "aborted"})
        finally:
            finish_cl_stream(loop_id)
            _active_loop_id = None

    thread = threading.Thread(target=_run, daemon=True, name=f"closed-loop-{loop_id}")
    thread.start()

    return loop_id


def stop_closed_loop() -> str | None:
    """Request graceful stop of the active loop. Returns loop_id or None."""
    store = LoopStateStore()
    active = store.get_active_loop()
    if not active:
        store.close()
        return None
    store.request_stop(active.loop_id)
    store.close()
    return active.loop_id


class _SSELogHandler(logging.Handler):
    """Logging handler that emits log records as SSE events."""

    def __init__(self, loop_id: str):
        super().__init__()
        self.loop_id = loop_id

    def emit(self, record: logging.LogRecord):
        try:
            msg = self.format(record)
            # Detect stage transitions
            if "===" in msg and "Cycle" in msg:
                emit_cl_event(self.loop_id, {"type": "log", "message": msg, "stage": "cycle_start"})
            elif "GATE PASSED" in msg or "GATE FAILED" in msg:
                emit_cl_event(self.loop_id, {"type": "log", "message": msg, "stage": "gating"})
            else:
                emit_cl_event(self.loop_id, {"type": "log", "message": msg})
        except Exception:
            pass
```

- [ ] **Step 2: Commit**

```bash
git add sdgs/web/services/closed_loop_service.py
git commit -m "feat: add closed-loop service layer with SSE broadcasting"
```

---

## Task 2: Backend router

**Files:**
- Create: `sdgs/web/routers/closed_loop.py`
- Modify: `sdgs/web/app.py`

- [ ] **Step 1: Implement the router**

```python
# sdgs/web/routers/closed_loop.py
"""FastAPI router for the closed-loop training system."""
import json
import asyncio
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from sdgs.web.auth import get_current_user
from sdgs.loop.state_v2 import LoopStateStore
from sdgs.web.services.closed_loop_service import (
    start_closed_loop, stop_closed_loop, get_active_loop_id,
    get_cl_logs, get_cl_queue,
)

router = APIRouter(prefix="/api/closed-loop", tags=["closed-loop"])


class ClosedLoopStartRequest(BaseModel):
    config_path: str | None = None


@router.post("/start")
async def start(req: ClosedLoopStartRequest, current_user=Depends(get_current_user)):
    try:
        loop_id = start_closed_loop(config_path=req.config_path)
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"loop_id": loop_id, "status": "running"}


@router.post("/stop")
async def stop(current_user=Depends(get_current_user)):
    loop_id = stop_closed_loop()
    if not loop_id:
        raise HTTPException(status_code=404, detail="No active closed-loop run")
    return {"loop_id": loop_id, "status": "stop_requested"}


@router.get("/status")
async def status():
    store = LoopStateStore()
    active = store.get_active_loop()
    if not active:
        latest = store.get_loop(get_active_loop_id()) if get_active_loop_id() else None
        if not latest:
            store.close()
            return {"loop_id": None, "status": "idle", "current_cycle": 0,
                    "current_stage": None, "consecutive_gate_failures": 0, "stop_reason": None}
        active = latest
    result = {
        "loop_id": active.loop_id,
        "status": active.status,
        "current_cycle": active.current_cycle,
        "current_stage": active.current_stage.value,
        "consecutive_gate_failures": active.cycles[-1].consecutive_gate_failures if active.cycles else 0,
        "stop_reason": active.stop_reason.value if active.stop_reason else None,
    }
    store.close()
    return result


@router.get("/history")
async def history(loop_id: str | None = None):
    store = LoopStateStore()
    if loop_id:
        state = store.get_loop(loop_id)
    else:
        state = store.get_active_loop()
        if not state and get_active_loop_id():
            state = store.get_loop(get_active_loop_id())
    store.close()

    if not state:
        return {"loop_id": None, "cycles": []}

    cycles = []
    for c in state.cycles:
        cycles.append({
            "cycle": c.cycle,
            "benchmark_scores": c.benchmark_scores,
            "gate_passed": c.gate_passed,
            "gate_delta": c.gate_delta,
            "consecutive_gate_failures": c.consecutive_gate_failures,
            "dataset_size": c.dataset_size,
            "training_loss": c.training_loss,
            "merged_model_path": c.merged_model_path,
            "tally_metadata": c.tally_metadata,
            "dataset_path": c.dataset_path,
            "adapter_path": c.adapter_path,
            "started_at": c.started_at,
            "completed_at": c.completed_at,
        })

    return {"loop_id": state.loop_id, "cycles": cycles}


@router.get("/events")
async def events(last_id: int = -1):
    loop_id = get_active_loop_id()
    if not loop_id:
        raise HTTPException(status_code=404, detail="No active loop for SSE")

    async def stream():
        # Replay stored logs first
        logs = get_cl_logs(loop_id)
        for log_entry in logs:
            if log_entry.get("id", 0) > last_id:
                yield f"id: {log_entry.get('id', 0)}\ndata: {json.dumps(log_entry)}\n\n"

        # Stream live events
        q = get_cl_queue(loop_id)
        if not q:
            return

        while True:
            try:
                event = await asyncio.get_event_loop().run_in_executor(None, q.get, True, 30)
                if event is None:
                    break
                yield f"id: {event.get('id', 0)}\ndata: {json.dumps(event)}\n\n"
            except Exception:
                yield f": keepalive\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
```

- [ ] **Step 2: Register the router in app.py**

Add after the existing loop router registration:

```python
from sdgs.web.routers import closed_loop
app.include_router(closed_loop.router)
```

- [ ] **Step 3: Verify backend starts**

Run: `cd /home/kylan/Coding/Ouroborus && python -c "from sdgs.web.app import app; print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add sdgs/web/routers/closed_loop.py sdgs/web/app.py
git commit -m "feat: add closed-loop API router with start/stop/status/history/events"
```

---

## Task 3: Frontend API client + SSE

**Files:**
- Modify: `sdgs/web/frontend/src/api/client.ts`
- Modify: `sdgs/web/frontend/src/api/sse.ts`

- [ ] **Step 1: Add API functions to client.ts**

Add at the end of the file:

```typescript
// Closed-loop API
export const startClosedLoop = (configPath?: string) =>
  request<{ loop_id: string; status: string }>('/api/closed-loop/start', {
    method: 'POST',
    body: JSON.stringify({ config_path: configPath || null }),
  })

export const stopClosedLoop = () =>
  request<{ loop_id: string; status: string }>('/api/closed-loop/stop', {
    method: 'POST',
  })

export const getClosedLoopStatus = () =>
  request<{
    loop_id: string | null
    status: string
    current_cycle: number
    current_stage: string | null
    consecutive_gate_failures: number
    stop_reason: string | null
  }>('/api/closed-loop/status')

export const getClosedLoopHistory = (loopId?: string) => {
  const params = loopId ? `?loop_id=${loopId}` : ''
  return request<{
    loop_id: string | null
    cycles: ClosedLoopCycle[]
  }>(`/api/closed-loop/history${params}`)
}

export interface ClosedLoopCycle {
  cycle: number
  benchmark_scores: Record<string, number>
  gate_passed: boolean | null
  gate_delta: number
  consecutive_gate_failures: number
  dataset_size: number
  training_loss: number | null
  merged_model_path: string | null
  tally_metadata: Record<string, any>
  dataset_path: string | null
  adapter_path: string | null
  started_at: string | null
  completed_at: string | null
}
```

- [ ] **Step 2: Add SSE factory to sse.ts**

Add at the end of the file:

```typescript
export function createClosedLoopSSE(
  onMessage: (msg: any) => void,
  onDone?: () => void,
): () => void {
  const token = localStorage.getItem('access_token')
  let lastId = -1
  let retryCount = 0
  let es: EventSource | null = null
  let closed = false

  function connect() {
    if (closed) return
    const url = `/api/closed-loop/events?last_id=${lastId}&token=${token}`
    es = new EventSource(url)

    es.onmessage = (event) => {
      retryCount = 0
      try {
        const data = JSON.parse(event.data)
        if (event.lastEventId) lastId = parseInt(event.lastEventId)
        if (data.type === 'done') {
          onMessage(data)
          onDone?.()
          return
        }
        onMessage(data)
      } catch (e) {
        console.error('SSE parse error:', e)
      }
    }

    es.onerror = () => {
      es?.close()
      if (closed) return
      retryCount++
      const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 30000)
      setTimeout(connect, delay)
    }
  }

  connect()

  return () => {
    closed = true
    es?.close()
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add sdgs/web/frontend/src/api/client.ts sdgs/web/frontend/src/api/sse.ts
git commit -m "feat: add closed-loop API client and SSE functions"
```

---

## Task 4: Frontend store + SSE hook

**Files:**
- Modify: `sdgs/web/frontend/src/store/loopStore.ts`
- Modify: `sdgs/web/frontend/src/hooks/useLoopSSE.ts`

- [ ] **Step 1: Rewrite loopStore.ts**

Replace the store contents with the new closed-loop state shape. Read the existing file first to understand the Zustand pattern used, then replace:

```typescript
import { create } from 'zustand'
import { getClosedLoopStatus, getClosedLoopHistory, startClosedLoop, stopClosedLoop, ClosedLoopCycle } from '../api/client'

interface GateBannerData {
  passed: boolean
  delta: number
  cycle: number
  consecutiveFailures: number
}

interface LoopState {
  // Status
  loopId: string | null
  status: string
  currentCycle: number
  currentStage: string | null
  consecutiveGateFailures: number
  stopReason: string | null

  // Data
  cycles: ClosedLoopCycle[]
  tallyResult: Record<string, any> | null
  gateBanner: GateBannerData | null

  // UI
  loading: boolean
  error: string | null

  // Actions
  fetchStatus: () => Promise<void>
  fetchHistory: () => Promise<void>
  start: (configPath?: string) => Promise<string | null>
  stop: () => Promise<void>
  setCurrentStage: (stage: string) => void
  setCurrentCycle: (cycle: number) => void
  addCycle: (cycle: ClosedLoopCycle) => void
  setTallyResult: (data: Record<string, any>) => void
  showGateBanner: (data: GateBannerData) => void
  dismissGateBanner: () => void
  setStatus: (status: string) => void
  setStopReason: (reason: string | null) => void
}

export const useLoopStore = create<LoopState>((set, get) => ({
  loopId: null,
  status: 'idle',
  currentCycle: 0,
  currentStage: null,
  consecutiveGateFailures: 0,
  stopReason: null,
  cycles: [],
  tallyResult: null,
  gateBanner: null,
  loading: false,
  error: null,

  fetchStatus: async () => {
    try {
      const data = await getClosedLoopStatus()
      set({
        loopId: data.loop_id,
        status: data.status,
        currentCycle: data.current_cycle,
        currentStage: data.current_stage,
        consecutiveGateFailures: data.consecutive_gate_failures,
        stopReason: data.stop_reason,
      })
    } catch (e: any) {
      set({ error: e.message })
    }
  },

  fetchHistory: async () => {
    try {
      const data = await getClosedLoopHistory(get().loopId || undefined)
      set({ cycles: data.cycles, loopId: data.loop_id })
    } catch (e: any) {
      set({ error: e.message })
    }
  },

  start: async (configPath?: string) => {
    set({ loading: true, error: null })
    try {
      const data = await startClosedLoop(configPath)
      set({ loopId: data.loop_id, status: 'running', loading: false, cycles: [], currentCycle: 0 })
      return data.loop_id
    } catch (e: any) {
      set({ error: e.message, loading: false })
      return null
    }
  },

  stop: async () => {
    try {
      await stopClosedLoop()
      set({ status: 'stop_requested' })
    } catch (e: any) {
      set({ error: e.message })
    }
  },

  setCurrentStage: (stage) => set({ currentStage: stage }),
  setCurrentCycle: (cycle) => set({ currentCycle: cycle }),
  addCycle: (cycle) => set((s) => ({ cycles: [...s.cycles, cycle] })),
  setTallyResult: (data) => set({ tallyResult: data }),
  showGateBanner: (data) => set({ gateBanner: data }),
  dismissGateBanner: () => set({ gateBanner: null }),
  setStatus: (status) => set({ status }),
  setStopReason: (reason) => set({ stopReason: reason }),
}))
```

- [ ] **Step 2: Rewrite useLoopSSE.ts**

Replace with new hook that handles closed-loop event types:

```typescript
import { useEffect, useRef, useState } from 'react'
import { createClosedLoopSSE } from '../api/sse'
import { useLoopStore } from '../store/loopStore'

export function useLoopSSE() {
  const [logs, setLogs] = useState<string[]>([])
  const [done, setDone] = useState(false)
  const store = useLoopStore()
  const closeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (store.status !== 'running') return

    const close = createClosedLoopSSE(
      (msg) => {
        switch (msg.type) {
          case 'stage':
            store.setCurrentStage(msg.stage)
            if (msg.cycle !== undefined) store.setCurrentCycle(msg.cycle)
            break
          case 'log':
            setLogs((prev) => {
              const next = [...prev, msg.message]
              return next.length > 2000 ? next.slice(-2000) : next
            })
            break
          case 'benchmark_scores':
            store.fetchHistory()
            break
          case 'tally_result':
            store.setTallyResult(msg)
            break
          case 'gate_decision':
            store.showGateBanner({
              passed: msg.passed,
              delta: msg.delta,
              cycle: msg.cycle,
              consecutiveFailures: msg.consecutive_failures || 0,
            })
            store.fetchHistory()
            break
          case 'done':
            store.setStatus('stopped')
            store.setStopReason(msg.stop_reason)
            store.fetchStatus()
            store.fetchHistory()
            setDone(true)
            break
        }
      },
      () => setDone(true),
    )

    closeRef.current = close
    return () => close()
  }, [store.status])

  return { logs, done, clear: () => setLogs([]) }
}
```

- [ ] **Step 3: Commit**

```bash
git add sdgs/web/frontend/src/store/loopStore.ts sdgs/web/frontend/src/hooks/useLoopSSE.ts
git commit -m "feat: rewrite loop store and SSE hook for closed-loop"
```

---

## Task 5: Frontend components

**Files:**
- Create: `sdgs/web/frontend/src/components/loop/StagePipeline.tsx`
- Create: `sdgs/web/frontend/src/components/loop/BenchmarkChart.tsx`
- Create: `sdgs/web/frontend/src/components/loop/TallyDiagnosis.tsx`
- Create: `sdgs/web/frontend/src/components/loop/GateBanner.tsx`
- Create: `sdgs/web/frontend/src/components/loop/CycleHistory.tsx`

These are all React components using inline styles (existing project pattern), Lucide icons, and Recharts. Each is a self-contained component.

- [ ] **Step 1: Create StagePipeline.tsx**

Horizontal strip showing 8 stages with active/complete/upcoming styling. Props: `currentStage: string | null`, `currentCycle: number`. Maps wire values (tallying, retrieving...) to display labels (TALLY, RETRIEVE...).

- [ ] **Step 2: Create BenchmarkChart.tsx**

Recharts LineChart. Props: `cycles: ClosedLoopCycle[]`, `targetScore: number`. Dynamically generates lines from `benchmark_scores` keys (excluding "average"). Average line is bold/dashed. Gate pass/fail shown as colored dots on ReferenceDot.

- [ ] **Step 3: Create TallyDiagnosis.tsx**

Card layout showing tally agent results. Props: `tallyResult: Record<string, any> | null`, `cycle: number`. Shows clusters with gap_description, root_cause, priority bar, affected questions (scrollable, truncated), search queries, generation guidance.

- [ ] **Step 4: Create GateBanner.tsx**

Floating notification. Props: `data: GateBannerData | null`, `onDismiss: () => void`. Auto-dismisses after 10 seconds via setTimeout. Green for pass, red for fail, yellow for fail cap. Absolute positioned, slides in from top.

- [ ] **Step 5: Create CycleHistory.tsx**

HTML table. Props: `cycles: ClosedLoopCycle[]`. Dynamic benchmark columns from keys in benchmark_scores. Gate column shows colored badge with delta. Derives base version by counting gate_passed cycles.

- [ ] **Step 6: Commit**

```bash
git add sdgs/web/frontend/src/components/loop/
git commit -m "feat: add closed-loop UI components (pipeline, chart, tally, gate, history)"
```

---

## Task 6: Rewrite Loop page

**Files:**
- Modify: `sdgs/web/frontend/src/pages/Loop.tsx`

- [ ] **Step 1: Rewrite Loop.tsx**

Complete rewrite. The page composes the 5 new components:

```
<div>
  <ControlsBar />         {/* Start/Stop/Status/BaseVersion/FailCounter */}
  <GateBanner />           {/* Floating overlay */}
  <StagePipeline />        {/* 8-stage strip */}
  <BenchmarkChart />       {/* Score chart */}
  <TallyDiagnosis />       {/* Cluster details */}
  <CycleHistory />         {/* Metrics table */}
  <LiveLogs />             {/* Collapsible log stream */}
</div>
```

The controls bar is inline (start button, stop button, status badge, base version, fail counter). Live logs is a collapsible section at the bottom.

Uses `useLoopStore()` for state and `useLoopSSE()` for real-time updates. Calls `fetchStatus()` and `fetchHistory()` on mount.

Gate banner auto-dismisses after 10 seconds. The page uses the existing glassmorphism card styling pattern.

- [ ] **Step 2: Build and verify**

Run: `cd /home/kylan/Coding/Ouroborus/sdgs/web/frontend && npm run build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add sdgs/web/frontend/src/pages/Loop.tsx
git commit -m "feat: rewrite Evolution Loop page for closed-loop system"
```

---

## Task 7: Build, verify, and push

- [ ] **Step 1: Rebuild frontend**

Run: `cd /home/kylan/Coding/Ouroborus/sdgs/web/frontend && npm run build`
Expected: Build succeeds

- [ ] **Step 2: Verify backend starts**

Run: `cd /home/kylan/Coding/Ouroborus && python -c "from sdgs.web.app import app; print(len(app.routes), 'routes')"`
Expected: prints route count, no errors

- [ ] **Step 3: Verify closed-loop endpoints exist**

Run: `cd /home/kylan/Coding/Ouroborus && python -c "from sdgs.web.app import app; routes = [r.path for r in app.routes if 'closed' in str(getattr(r, 'path', ''))]; print(routes)"`
Expected: Shows closed-loop paths

- [ ] **Step 4: Push**

```bash
git push origin master
```

---

## Summary

| Task | What | Backend/Frontend |
|------|------|-----------------|
| 1 | Service layer (orchestrator lifecycle + SSE) | Backend |
| 2 | API router (start/stop/status/history/events) | Backend |
| 3 | API client + SSE factory functions | Frontend |
| 4 | Loop store + SSE hook rewrite | Frontend |
| 5 | 5 new components (pipeline, chart, tally, gate, history) | Frontend |
| 6 | Loop page rewrite | Frontend |
| 7 | Build + verify + push | Both |

**Execution order:** Sequential. Backend first (1-2), then frontend (3-6), then verify (7).
